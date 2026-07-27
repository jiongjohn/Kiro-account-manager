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

  // 消费 carry 开头的一个工具块。返回 false = 需要等更多帧（carry 保持不动）
  const extractOne = async (isFlush: boolean, justConsumedBlock: boolean): Promise<boolean> => {
    const openAt = findOpener(carry)
    if (openAt === -1) return false
    const gt = carry.indexOf('>', openAt)
    if (gt === -1) return false // 开标签本身还没收完，等下一帧
    const openTag = carry.slice(openAt, gt + 1)
    const nameM = openTag.match(/\bname="([^"]+)"/)
    const candidates = findClosers(carry, gt + 1)
    if (!candidates.length) return false // 收尾标签还没到，等下一帧

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
      if (!matched && !isFlush && !carry.slice(gt + 1, candidates[0].idx).trim().endsWith('}')) return false
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
    carry = carry.slice(consumedEnd)
    return true
  }

  const process = async (isFlush: boolean): Promise<void> => {
    // 认领上一帧工具块遗留的孤立 </function_calls>；还是它的前缀就继续等（pendingToolTail 会暂留），
    // 来的是别的内容说明这个尾巴不会出现了，撤销认领
    if (pendingFcClose) {
      const head = carry.replace(/^\s*/, '')
      if (head.startsWith(CLOSE_FC)) {
        carry = carry.slice(carry.length - head.length + CLOSE_FC.length)
        pendingFcClose = false
      } else if (head && !CLOSE_FC.startsWith(head)) {
        pendingFcClose = false
      }
    }

    let justConsumedBlock = false
    while (await extractOne(isFlush, justConsumedBlock)) justConsumedBlock = true

    // 仍有未闭合的开标签：保留从开标签起，等下一帧
    const openAt = findOpener(carry)
    if (openAt !== -1) {
      if (isFlush) {
        // 流结束仍未闭合 = 损坏的工具调用，原样当文本输出（不丢字符）
        await emit(carry)
        carry = ''
        return
      }
      const safe = stripToolPrefix(carry.slice(0, openAt))
      await emit(safe)
      carry = carry.slice(safe.length)
      return
    }
    if (isFlush) {
      await emit(carry)
      carry = ''
      return
    }
    const hold = pendingToolTail(carry)
    await emit(carry.slice(0, carry.length - hold))
    carry = carry.slice(carry.length - hold)
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
