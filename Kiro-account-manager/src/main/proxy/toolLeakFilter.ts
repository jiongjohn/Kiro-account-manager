// ===== 工具调用 XML 泄漏修复（跨帧解析 + 流结束去重）=====
// 背景：Kiro 后端偶尔把模型的工具调用 XML 当普通文本，混在
//       assistantResponseEvent / codeEvent 里【流式分帧】发出。逐帧
//       `content.replace(/<tool_use.../)` 只覆盖 <tool_use> 且无法匹配跨帧分片的标签，
//       导致：原始 XML 泄漏成可见文本，且客户端解析不到工具调用 → 工具不执行、任务中断。
// 泄漏文本实测有三套写法混用：
//   1. 模型原生：<function_calls><invoke name="X"><parameter name="k">v</parameter></invoke></function_calls>
//      （<function_calls> 有时被后端损坏成纯文本 "count"）
//   2. 请求侧 formatToolUses 同格式：<tool_use id="..." name="X">{JSON}</tool_use>
//      （历史里含未声明工具时请求侧会把 toolUses 摊平成这个形状，模型照学）
//   3. 两者混搭：<tool_use id="..." name="X">{JSON}</invoke>  ← 开/收标签不配对
// 方案：有状态的跨帧过滤器分离「正常文本」与「泄漏的工具调用」；正常文本照常输出，
//       泄漏工具解析为结构化 tool_use 暂存；流结束时与已见的结构化 toolUseEvent 去重
//       （同名同参丢弃，避免重复执行）后注入救回。
// 本文件是纯文本处理逻辑（不依赖 electron），便于单测覆盖各种畸形泄漏格式。

export interface LeakedTool {
  name: string
  input: Record<string, unknown>
}

export interface ToolLeakFilterOptions {
  // 正常文本的出口（await 以保留 SSE 背压：慢客户端时暂停拉流，避免内存堆积）
  emit: (text: string) => void | Promise<void>
  debug?: boolean
}

export interface ToolLeakFilter {
  // 追加一帧文本并处理（未闭合的标签会留在内部缓冲等下一帧）
  push(content: string): Promise<void>
  // 流结束：吐出残留（仍未闭合 = 损坏的工具调用，原样当文本输出，不丢字符）
  flush(): Promise<void>
  readonly leakedTools: LeakedTool[]
}

// 工具签名：用于泄漏工具与结构化 toolUseEvent 的同名同参去重
export function toolSig(name: string, input: Record<string, unknown>): string {
  const sortedKeys = Object.keys(input).sort()
  const norm: Record<string, unknown> = {}
  for (const k of sortedKeys) norm[k] = input[k]
  return name + '|' + JSON.stringify(norm)
}

// 模型原生格式的参数体：<parameter name="k">v</parameter>
function parseParameterBody(name: string, body: string): LeakedTool {
  const input: Record<string, unknown> = {}
  const re = /<parameter name="([^"]+)">([\s\S]*?)<\/parameter>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(body)) !== null) {
    const key = m[1]
    const raw = m[2]
    const t = raw.trim()
    // 类型还原：布尔/数字/null 转换，其余保留原字符串（保留内部空白，如 command/old_string）
    if (t === 'true') input[key] = true
    else if (t === 'false') input[key] = false
    else if (t === 'null') input[key] = null
    else if (/^-?\d+$/.test(t)) input[key] = parseInt(t, 10)
    else if (/^-?\d*\.\d+$/.test(t)) input[key] = parseFloat(t)
    else input[key] = raw
  }
  return { name, input }
}

function parseJsonBody(body: string): Record<string, unknown> | null {
  const raw = body.trim()
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch {
    /* 非 JSON 体 */
  }
  return null
}

// 开标签：<invoke name="X"> 或 <tool_use id="..." name="X">
function findOpener(s: string): number {
  const a = s.indexOf('<invoke name=')
  const b = s.indexOf('<tool_use')
  if (a === -1) return b
  if (b === -1) return a
  return Math.min(a, b)
}

// 收尾标签一律互认（模型会把两套格式混搭），取开标签之后出现的全部候选，由近到远
const CLOSERS = ['</tool_use>', '</invoke>', '</function_calls>'] as const

function findClosers(s: string, from: number): Array<{ idx: number; tag: string }> {
  const out: Array<{ idx: number; tag: string }> = []
  for (const tag of CLOSERS) {
    let i = s.indexOf(tag, from)
    while (i !== -1) {
      out.push({ idx: i, tag })
      i = s.indexOf(tag, i + tag.length)
    }
  }
  return out.sort((x, y) => x.idx - y.idx)
}

// ===== Markdown 围栏跟踪 =====
// 围栏内的工具调用标签是模型「刻意当字面量展示」的，不是泄漏，必须原样放行：
// 实测让模型给本文件的单测加用例时，它写的 <tool_use ...>…</tool_use> 字面量会被当成泄漏吃掉
// （代码变成 const leak = ''，语法还正确所以不易察觉），同时凭空注入一次真实工具调用。
// 代价：万一后端把真泄漏包在未闭合的围栏之后发出来，就救不回了 —— 真泄漏是模型的裸工具语法，
// 不是给人看的带围栏散文，这个交换划算。
// 只处理 ``` / ~~~ 围栏；单反引号行内代码不覆盖（完整工具块写在行内极少见，且散文里未配对的
// 反引号很常见，跟踪它误判风险更大）。
const FENCE_LINE = /^[ \t]{0,3}(?:`{3,}|~{3,})/

interface FenceState {
  open: boolean
  line: string // 当前尚未收到换行的残行（跨帧累积）
}

// 从给定状态出发扫过 chunk，返回新状态。围栏只在整行收完时翻转（围栏标记独占一行）
function scanFences(chunk: string, state: FenceState): FenceState {
  if (!chunk) return state
  const parts = chunk.split('\n')
  let open = state.open
  let line = state.line + parts[0]
  for (let i = 1; i < parts.length; i++) {
    if (FENCE_LINE.test(line)) open = !open
    line = parts[i]
  }
  return { open, line }
}

// 泄漏文本前可能有被后端损坏的 <function_calls> 残迹（含纯文本 "count"）
function stripToolPrefix(pre: string): string {
  const fc = pre.match(/<function_calls>\s*$/)
  if (fc) return pre.slice(0, pre.length - fc[0].length)
  const ct = pre.match(/count\s*$/)
  if (ct) return pre.slice(0, pre.length - ct[0].length)
  return pre
}

// 尾部可能是标签的前半截（跨帧分片），需留到下一帧再判断
function pendingToolTail(s: string): number {
  const markers = ['<function_calls>', '<invoke name=', '</invoke>', '</function_calls>', '<parameter name=', '</parameter>', '<tool_use', '</tool_use>', 'count']
  let hold = 0
  for (const tag of markers) {
    for (let k = Math.min(s.length, tag.length - 1); k >= 1; k--) {
      if (s.slice(s.length - k) === tag.slice(0, k)) {
        if (k > hold) hold = k
        break
      }
    }
  }
  // 上面的循环只暂留标签的半截（k 最大到 tag.length-1）。完整的 <function_calls>、以及被后端
  // 损坏成纯文本的 "count"，也必须整串暂留：紧跟它们的 <invoke 往往在下一帧才到，提前吐出去
  // 就再没机会从前缀里剥掉，会残留成可见文本（实测 Kiro 流式确实在这里切帧）。
  // 但只在「后面还可能长成 <invoke name=」时才暂留 —— 否则正文里出现 count 或 <function_calls>
  // 会把其后所有文本一直扣到流末尾，流式输出直接卡死。
  const OPENER_HINT = '<invoke name='
  for (const lead of ['<function_calls>', 'count']) {
    const i = s.lastIndexOf(lead)
    if (i === -1) continue
    const rest = s.slice(i + lead.length).replace(/^\s*/, '')
    if (!OPENER_HINT.startsWith(rest)) continue
    const len = s.length - i
    if (len > hold) hold = len
  }
  return hold
}

const CLOSE_FC = '</function_calls>'

export function createToolLeakFilter(options: ToolLeakFilterOptions): ToolLeakFilter {
  const leakedTools: LeakedTool[] = []
  let carry = ''
  // 刚消费掉一个工具块，后面可能还跟一个孤立的 </function_calls> 收尾。
  // 它常常在下一帧才到（此时 carry 已清空、没有开标签与之配对），若不认领就会漏成可见文本。
  let pendingFcClose = false
  // carry 起始位置处的围栏状态
  let fence: FenceState = { open: false, line: '' }

  // 推进 carry 并同步维护围栏状态。所有 carry 前进都必须走这里，
  // 否则围栏状态会与位置错位，围栏判定随即失效
  const advance = (n: number): void => {
    if (n <= 0) return
    fence = scanFences(carry.slice(0, n), fence)
    carry = carry.slice(n)
  }

  const emit = async (s: string): Promise<void> => {
    if (!s) return
    await options.emit(s)
  }

  const debugLog = (tool: LeakedTool): void => {
    if (!options.debug) return
    try {
      console.log('[tool-leak-fix] parsed leaked tool:', tool.name, JSON.stringify(tool.input).slice(0, 120))
    } catch {
      /* ignore */
    }
  }

  // 消费 carry 开头的一个工具块。
  // 'none' = 需要等更多帧（carry 不动）；'block' = 消费掉一个工具块；'text' = 当普通文本放行了一段
  const extractOne = async (isFlush: boolean, justConsumedBlock: boolean): Promise<'none' | 'block' | 'text'> => {
    const openAt = findOpener(carry)
    if (openAt === -1) return 'none'

    // 围栏内的标签是模型刻意展示的字面量，原样放行：吐掉「前缀 + 开标签的 '<'」，
    // 剩下的部分按普通文本继续流走（'<' 已消费，下一轮不会再把它当开标签）
    if (scanFences(carry.slice(0, openAt), fence).open) {
      await emit(carry.slice(0, openAt + 1))
      advance(openAt + 1)
      return 'text'
    }

    const gt = carry.indexOf('>', openAt)
    if (gt === -1) return 'none' // 开标签本身还没收完，等下一帧
    const openTag = carry.slice(openAt, gt + 1)
    const nameM = openTag.match(/\bname="([^"]+)"/)
    const candidates = findClosers(carry, gt + 1)
    if (!candidates.length) return 'none' // 收尾标签还没到，等下一帧

    // 选定收尾标签：默认最早的那个。若参数体看着是 JSON 但在此处解析不出来
    // （参数值里可能含 "</invoke>" 之类字面量，或 JSON 本身跨帧还没收完），顺延到下一个候选重试
    let chosen = candidates[0]
    let jsonInput: Record<string, unknown> | null = null
    if (carry.slice(gt + 1).trimStart().startsWith('{')) {
      let matched = false
      for (const c of candidates) {
        const parsed = parseJsonBody(carry.slice(gt + 1, c.idx))
        if (parsed) {
          chosen = c
          jsonInput = parsed
          matched = true
          break
        }
      }
      // 没有候选能解出完整 JSON：只有体看着还没收完（未见收尾 '}'）才等后续帧。
      // 已经是完整括号却解析不了 = 真畸形（或被 Kiro 截断），立刻按最早的收尾标签消费掉，
      // 至少把工具名救回来，避免后续文本被一直缓冲、流式输出卡到流末尾
      if (!matched && !isFlush && !carry.slice(gt + 1, candidates[0].idx).trim().endsWith('}')) return 'none'
    }

    const prefix = carry.slice(0, openAt)
    // 连续工具块之间的纯空白不外泄成可见文本（与旧实现连续消费 invoke 的行为一致）
    if (!(justConsumedBlock && !prefix.trim())) await emit(stripToolPrefix(prefix))

    const body = carry.slice(gt + 1, chosen.idx)
    let consumedEnd = chosen.idx + chosen.tag.length
    // </invoke> / </tool_use> 之后可能紧跟 </function_calls>，一并吃掉，避免残留标签泄漏成文本
    if (chosen.tag !== '</function_calls>') {
      const fcClose = carry.slice(consumedEnd).match(/^\s*<\/function_calls>/)
      if (fcClose) consumedEnd += fcClose[0].length
      // 这一帧还没等到，交给 pendingFcClose 在后续帧认领
      else pendingFcClose = true
    }

    if (nameM) {
      const tool: LeakedTool = /<parameter name="/.test(body)
        ? parseParameterBody(nameM[1], body)
        : { name: nameM[1], input: jsonInput ?? parseJsonBody(body) ?? {} }
      leakedTools.push(tool)
      debugLog(tool)
    } else {
      // 拿不到工具名（畸形开标签）：救不回来也不能吞字符，原样当文本输出
      await emit(carry.slice(openAt, consumedEnd))
    }
    advance(consumedEnd)
    return 'block'
  }

  const process = async (isFlush: boolean): Promise<void> => {
    // 认领上一帧工具块遗留的孤立 </function_calls>；还是它的前缀就继续等（pendingToolTail 会暂留），
    // 来的是别的内容说明这个尾巴不会出现了，撤销认领
    if (pendingFcClose) {
      const head = carry.replace(/^\s*/, '')
      if (head.startsWith(CLOSE_FC)) {
        advance(carry.length - head.length + CLOSE_FC.length)
        pendingFcClose = false
      } else if (head && !CLOSE_FC.startsWith(head)) {
        pendingFcClose = false
      }
    }

    let justConsumedBlock = false
    for (;;) {
      const step = await extractOne(isFlush, justConsumedBlock)
      if (step === 'none') break
      justConsumedBlock = step === 'block'
    }

    // 仍有未闭合的开标签：保留从开标签起，等下一帧
    const openAt = findOpener(carry)
    if (openAt !== -1) {
      if (isFlush) {
        // 流结束仍未闭合 = 损坏的工具调用，原样当文本输出（不丢字符）
        await emit(carry)
        advance(carry.length)
        return
      }
      const safe = stripToolPrefix(carry.slice(0, openAt))
      await emit(safe)
      advance(safe.length)
      return
    }
    if (isFlush) {
      await emit(carry)
      advance(carry.length)
      return
    }
    const hold = pendingToolTail(carry)
    await emit(carry.slice(0, carry.length - hold))
    advance(carry.length - hold)
  }

  return {
    leakedTools,
    push: async (content: string): Promise<void> => {
      carry += content
      await process(false)
    },
    flush: async (): Promise<void> => {
      await process(true)
    }
  }
}
