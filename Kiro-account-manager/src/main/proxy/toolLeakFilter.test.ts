import test from 'node:test'
import assert from 'node:assert/strict'
import { createToolLeakFilter, toolSig, type LeakedTool } from './toolLeakFilter.ts'

interface RunResult {
  text: string
  tools: LeakedTool[]
}

// 把若干帧喂给过滤器（模拟 Kiro 的流式分帧），返回可见文本 + 救回的工具
async function run(frames: string[]): Promise<RunResult> {
  let text = ''
  const f = createToolLeakFilter({ emit: (s) => { text += s } })
  for (const frame of frames) await f.push(frame)
  await f.flush()
  return { text, tools: f.leakedTools }
}

// 逐字符分帧：验证跨帧解析（任何切分点都不能改变结果）
async function runCharByChar(whole: string): Promise<RunResult> {
  return run(whole.split(''))
}

test('普通文本原样透传', async () => {
  const r = await run(['hello ', 'world'])
  assert.equal(r.text, 'hello world')
  assert.deepEqual(r.tools, [])
})

test('模型原生 <function_calls>/<invoke>/<parameter> 泄漏被救回', async () => {
  const leak = '<function_calls>\n<invoke name="Bash">\n<parameter name="command">ls -la</parameter>\n<parameter name="timeout">5000</parameter>\n</invoke>\n</function_calls>'
  const r = await run(['前置文本\n', leak, '\n后置文本'])
  assert.deepEqual(r.tools, [{ name: 'Bash', input: { command: 'ls -la', timeout: 5000 } }])
  assert.equal(r.text.includes('<invoke'), false)
  assert.equal(r.text.includes('</function_calls>'), false)
  assert.equal(r.text.includes('前置文本'), true)
  assert.equal(r.text.includes('后置文本'), true)
})

test('<tool_use id name>JSON</tool_use> 泄漏被救回', async () => {
  const leak = '<tool_use id="tooluse_abc" name="Read">{"file_path":"/tmp/a.ts"}</tool_use>'
  const r = await run([leak])
  assert.deepEqual(r.tools, [{ name: 'Read', input: { file_path: '/tmp/a.ts' } }])
  assert.equal(r.text.includes('<tool_use'), false)
})

// 实测泄漏形态：开标签是 <tool_use id name>（跟请求侧 formatToolUses 学的），
// 收尾标签却是模型原生的 </invoke> —— 两套格式混搭，任一单独的解析器都匹配不上
test('混搭格式 <tool_use id name>JSON</invoke> 泄漏被救回（回归：曾泄漏成可见文本且工具不执行）', async () => {
  const leak = '<tool_use id="tooluse_Kq_KfS3aqhT3mFRSfsBqy8" name="Bash">\n{"command":"cd /tmp && go build ./... 2>&1","description":"Build all packages with go"}\n</invoke>'
  const r = await run([leak])
  assert.deepEqual(r.tools, [{
    name: 'Bash',
    input: { command: 'cd /tmp && go build ./... 2>&1', description: 'Build all packages with go' }
  }])
  assert.equal(r.text.includes('<tool_use'), false)
  assert.equal(r.text.includes('</invoke>'), false)
})

test('混搭格式跨帧分片同样被救回', async () => {
  const leak = '<tool_use id="tooluse_x" name="Bash">\n{"command":"echo hi"}\n</invoke>'
  const r = await runCharByChar(leak)
  assert.deepEqual(r.tools, [{ name: 'Bash', input: { command: 'echo hi' } }])
  assert.equal(r.text.trim(), '')
})

test('反向混搭 <invoke name>+</tool_use> 也被救回', async () => {
  const leak = '<invoke name="Grep">\n<parameter name="pattern">foo</parameter>\n</tool_use>'
  const r = await run([leak])
  assert.deepEqual(r.tools, [{ name: 'Grep', input: { pattern: 'foo' } }])
  assert.equal(r.text.trim(), '')
})

test('JSON 参数值里含 </invoke> 字面量时不被截断', async () => {
  const input = { command: "echo '</invoke>' > /tmp/x" }
  const leak = `<tool_use id="t1" name="Bash">${JSON.stringify(input)}</tool_use>`
  const r = await run([leak])
  assert.deepEqual(r.tools, [{ name: 'Bash', input }])
  assert.equal(r.text.trim(), '')
})

// 畸形 JSON 不能把后续文本一直扣在缓冲区里（否则整段响应到流末尾才吐出）
test('JSON 畸形但括号已闭合时立刻消费，后续文本继续流式输出', async () => {
  let text = ''
  const f = createToolLeakFilter({ emit: (s) => { text += s } })
  await f.push('<tool_use id="t1" name="Bash">{"command":}</tool_use>')
  await f.push('后续文本')
  assert.equal(text, '后续文本', '后续文本应立即输出，而非缓冲到 flush')
  assert.deepEqual(f.leakedTools, [{ name: 'Bash', input: {} }])
  await f.flush()
})

test('JSON 体跨帧未收完时继续等待而不是当畸形处理', async () => {
  const r = await run(['<tool_use id="t1" name="Bash">{"command":"ec', 'ho hi"}</invoke>'])
  assert.deepEqual(r.tools, [{ name: 'Bash', input: { command: 'echo hi' } }])
  assert.equal(r.text.trim(), '')
})

test('连续两个泄漏块都被救回且不外泄空白', async () => {
  const leak = '<tool_use id="t1" name="Read">{"file_path":"/a"}</tool_use>\n<tool_use id="t2" name="Read">{"file_path":"/b"}</tool_use>'
  const r = await run([leak])
  assert.deepEqual(r.tools.map(t => t.input.file_path), ['/a', '/b'])
  assert.equal(r.text.trim(), '')
})

test('损坏的 <function_calls>→"count" 前缀不泄漏成文本', async () => {
  const leak = '正文count<invoke name="Bash">\n<parameter name="command">ls</parameter>\n</invoke>'
  const r = await run([leak])
  assert.deepEqual(r.tools, [{ name: 'Bash', input: { command: 'ls' } }])
  assert.equal(r.text, '正文')
})

// 实测 Kiro 流式会在 <function_calls> 与 <invoke 之间切帧；完整的 <function_calls>
// 若不整串暂留，就会残留成可见文本（工具仍能救回，但用户看到一截标签）
test('<function_calls> 与 <invoke 跨帧切开时不残留成文本', async () => {
  const r = await run(['正文\n<function_calls>\n', '<invoke name="Bash">\n<parameter name="command">ls</parameter>\n</invoke>\n</function_calls>'])
  assert.deepEqual(r.tools, [{ name: 'Bash', input: { command: 'ls' } }])
  assert.equal(r.text.includes('<function_calls>'), false, '不应残留 <function_calls>')
  assert.equal(r.text.trim(), '正文')
})

// 实测：</invoke> 与 </function_calls> 之间切帧时，孤立的收尾标签会漏成可见文本
test('</invoke> 与 </function_calls> 跨帧切开时收尾标签不残留', async () => {
  const r = await run(['<function_calls>\n<invoke name="Bash">\n<parameter name="command">ls</parameter>\n</invoke>', '\n</function_calls>'])
  assert.deepEqual(r.tools, [{ name: 'Bash', input: { command: 'ls' } }])
  assert.equal(r.text.includes('function_calls'), false, '不应残留 </function_calls>')
})

test('孤立 </function_calls> 逐字符分帧也不残留', async () => {
  const r = await runCharByChar('<function_calls>\n<invoke name="Bash">\n<parameter name="command">ls</parameter>\n</invoke>\n</function_calls>')
  assert.deepEqual(r.tools, [{ name: 'Bash', input: { command: 'ls' } }])
  assert.equal(r.text.includes('function_calls'), false)
})

// 认领必须可撤销：工具块之后来的是正常文本时，不能把它误吃或误扣
test('工具块之后紧跟正常文本时照常输出', async () => {
  const r = await run(['<tool_use id="t1" name="Bash">{"command":"ls"}</invoke>', '好了，命令已发出。'])
  assert.deepEqual(r.tools, [{ name: 'Bash', input: { command: 'ls' } }])
  assert.equal(r.text, '好了，命令已发出。')
})

test('损坏前缀 count 与 <invoke 跨帧切开时也不残留', async () => {
  const r = await run(['正文count', '<invoke name="Bash">\n<parameter name="command">ls</parameter>\n</invoke>'])
  assert.deepEqual(r.tools, [{ name: 'Bash', input: { command: 'ls' } }])
  assert.equal(r.text, '正文')
})

// 暂留必须有界：否则正文里出现 count / <function_calls> 会把后续文本全扣到流末尾
test('正文里的 count 不阻塞后续文本的流式输出', async () => {
  let text = ''
  const f = createToolLeakFilter({ emit: (s) => { text += s } })
  await f.push('文件数 count 是 42，')
  await f.push('继续输出后面的内容。')
  assert.equal(text, '文件数 count 是 42，继续输出后面的内容。', '不应被扣到 flush')
  await f.flush()
  assert.deepEqual(f.leakedTools, [])
})

test('正文里的 <function_calls> 后跟普通文本时不阻塞流式输出', async () => {
  let text = ''
  const f = createToolLeakFilter({ emit: (s) => { text += s } })
  await f.push('这个标签 <function_calls> 是 Kiro 的内部格式，')
  await f.push('跟你的问题无关。')
  assert.equal(text, '这个标签 <function_calls> 是 Kiro 的内部格式，跟你的问题无关。')
  await f.flush()
})

// ===== 围栏内的工具标签是模型刻意展示的字面量，必须原样放行 =====
// 回归：曾把它当泄漏吃掉（代码变成 const leak = ''，语法还正确所以不易察觉），
// 同时凭空注入一次真实工具调用 —— 实测「让模型给本文件加个单测用例」就会触发
test('```围栏内的工具标签原样放行，不救回也不注入', async () => {
  const fenced = "```ts\nconst leak = '<tool_use id=\"tooluse_abc\" name=\"Read\">{\"file_path\":\"/tmp/a.ts\"}</tool_use>'\n```"
  const r = await run([fenced])
  assert.deepEqual(r.tools, [], '围栏内不应注入工具调用')
  assert.equal(r.text, fenced, '围栏内文本必须逐字保留')
})

test('围栏内的原生 <invoke> 语法同样原样放行', async () => {
  const fenced = '```\n<function_calls>\n<invoke name="Bash">\n<parameter name="command">rm -rf /</parameter>\n</invoke>\n</function_calls>\n```'
  const r = await run([fenced])
  assert.deepEqual(r.tools, [])
  assert.equal(r.text, fenced)
})

test('围栏内容逐字符跨帧也原样放行', async () => {
  const fenced = "```ts\nconst leak = '<tool_use id=\"t1\" name=\"Grep\">{\"pattern\":\"foo\"}</tool_use>'\n```"
  const r = await runCharByChar(fenced)
  assert.deepEqual(r.tools, [])
  assert.equal(r.text, fenced)
})

test('围栏标记本身跨帧切开也能正确识别', async () => {
  const fenced = "``\n" // 故意把开栏标记切成 `` + `
  let text = ''
  const f = createToolLeakFilter({ emit: (s) => { text += s } })
  await f.push('```')
  await f.push('ts\n<tool_use id="t1" name="Read">{"file_path":"/a"}</tool_use>\n```')
  await f.flush()
  assert.deepEqual(f.leakedTools, [], '围栏标记跨帧时仍应判定为围栏内')
  assert.equal(text, '```ts\n<tool_use id="t1" name="Read">{"file_path":"/a"}</tool_use>\n```')
  assert.ok(fenced.length > 0)
})

test('~~~ 围栏同样生效', async () => {
  const fenced = '~~~\n<tool_use id="t1" name="Read">{"file_path":"/a"}</tool_use>\n~~~'
  const r = await run([fenced])
  assert.deepEqual(r.tools, [])
  assert.equal(r.text, fenced)
})

test('围栏闭合之后的真泄漏仍然被救回', async () => {
  const s = '```ts\nconst example = \'<tool_use id="t1" name="Read">{"file_path":"/a"}</tool_use>\'\n```\n'
    + '现在真的调用一下：<tool_use id="t2" name="Bash">{"command":"ls"}</invoke>'
  const r = await run([s])
  assert.deepEqual(r.tools, [{ name: 'Bash', input: { command: 'ls' } }], '围栏外的泄漏应照常救回')
  assert.equal(r.text.includes('const example'), true, '围栏内的示例应保留')
  assert.equal(r.text.includes('name="Bash"'), false, '围栏外的泄漏不应留在文本里')
})

test('围栏未闭合时其后内容一律按围栏内处理（宁可不救回也不误吃代码）', async () => {
  const s = '```ts\n<tool_use id="t1" name="Read">{"file_path":"/a"}</tool_use>'
  const r = await run([s])
  assert.deepEqual(r.tools, [])
  assert.equal(r.text, s)
})

// ===== 收尾标签被输出上限截断（线上实测：Edit 调用，完整 JSON 体但无任何收尾标签）=====
test('流结束时无收尾标签但 JSON 体完整 → 救回（回归：曾泄漏成文本、工具不执行）', async () => {
  const input = {
    replace_all: false,
    file_path: '/Users/soar/project/auto-coding/src/executor-pool.ts',
    old_string: "    this.state = 'spawning';\n    const sockPath = computeSockPath();",
    new_string: "    this.state = 'spawning';\n    const sockPath = computeSockPath(this.idx);"
  }
  const leak = '<tool_use id="tooluse_4sEmx9wREFq0H1Qe8VobZ5" name="Edit">\n' + JSON.stringify(input)
  const r = await run(['我来改一下。\n', leak])
  assert.deepEqual(r.tools, [{ name: 'Edit', input }])
  assert.equal(r.text.includes('<tool_use'), false, '不应把开标签泄漏成文本')
  assert.equal(r.text.trim(), '我来改一下。')
})

test('无收尾标签且体跨帧分片 → 收齐后仍救回', async () => {
  const leak = '<tool_use id="t1" name="Edit">{"file_path":"/a.ts","old_string":"a","new_string":"b"}'
  const r = await runCharByChar(leak)
  assert.deepEqual(r.tools, [{ name: 'Edit', input: { file_path: '/a.ts', old_string: 'a', new_string: 'b' } }])
  assert.equal(r.text.trim(), '')
})

test('无收尾标签 + <parameter> 体完整 → 救回', async () => {
  const leak = '<invoke name="Bash">\n<parameter name="command">go vet ./...</parameter>'
  const r = await run([leak])
  assert.deepEqual(r.tools, [{ name: 'Bash', input: { command: 'go vet ./...' } }])
})

// 截断的体绝不能猜参数：Edit 少一个 new_string 会写坏文件
test('无收尾标签且最后一个 <parameter> 被截断 → 不救回，原样文本', async () => {
  const leak = '<invoke name="Edit">\n<parameter name="file_path">/a.ts</parameter>\n<parameter name="new_string">半截'
  const r = await run([leak])
  assert.deepEqual(r.tools, [], '参数不全时不应救回')
  assert.equal(r.text, leak, '应原样输出，不丢字符')
})

test('围栏内未闭合的标签仍原样放行，不被 flush 救回', async () => {
  const s = '```ts\n<tool_use id="t1" name="Edit">{"file_path":"/a.ts"}'
  const r = await run([s])
  assert.deepEqual(r.tools, [], '围栏内的内容不该被 flush 兜底救回')
  assert.equal(r.text, s)
})

// ===== 线上实测形态：开标签只有 id，工具名当成 <parameter name="name"> 传 =====
// 回归：nameM 只从开标签取名字 → 取不到 → 走「原样当文本输出」分支 → 整段泄漏成文本、工具丢失
const NAMELESS_LEAK = '<tool_use id="toolu_bdrk_01LMK1x1v6yMZKvKZQZuAvzR">\n'
  + '<parameter name="name">Edit</parameter>\n'
  + '<parameter name="file_path">/tmp/proj/codeListBanner.vue</parameter>\n'
  + '<parameter name="old_string">    appendG7ReturnHighlightUtmParam(url = \'\') {\n      return x\n    },\n    getGaParam(isClick = true) {</parameter>\n'
  + '<parameter name="new_string">    getGaParam(isClick = true) {</parameter>\n'
  + '</invoke>'

test('开标签无 name、工具名藏在 <parameter name="name"> 里 → 救回（回归：曾整段泄漏成文本）', async () => {
  const r = await run([NAMELESS_LEAK])
  assert.equal(r.tools.length, 1)
  assert.equal(r.tools[0].name, 'Edit', '工具名应从 <parameter name="name"> 取到')
  assert.equal('name' in r.tools[0].input, false, 'name 是工具名，不能混进工具参数')
  assert.equal(r.tools[0].input.file_path, '/tmp/proj/codeListBanner.vue')
  assert.equal(r.tools[0].input.new_string, '    getGaParam(isClick = true) {')
  assert.equal(r.text.includes('<tool_use'), false)
})

test('该形态逐字符跨帧同样救回', async () => {
  const r = await runCharByChar(NAMELESS_LEAK)
  assert.equal(r.tools.length, 1)
  assert.equal(r.tools[0].name, 'Edit')
  assert.equal(r.text.trim(), '')
})

test('该形态无收尾标签（输出被截断）也救回', async () => {
  const r = await run([NAMELESS_LEAK.replace('\n</invoke>', '')])
  assert.equal(r.tools.length, 1)
  assert.equal(r.tools[0].name, 'Edit')
  assert.equal(r.tools[0].input.new_string, '    getGaParam(isClick = true) {')
})

// <parameter> 体也需要「顺延收尾标签」重试：old_string 正好在改这类标签时会被截断，
// 而被截断的参数是 parseParameterBody 静默丢弃的 —— 少一个 new_string 就写坏文件
test('<parameter> 参数值里含 </invoke> 字面量时不被截断', async () => {
  const leak = '<invoke name="Edit">\n'
    + '<parameter name="file_path">/a.ts</parameter>\n'
    + '<parameter name="old_string">const s = \'</invoke>\'</parameter>\n'
    + '<parameter name="new_string">const s = \'</tool_use>\'</parameter>\n'
    + '</invoke>'
  const r = await run([leak])
  assert.equal(r.tools.length, 1)
  assert.equal(r.tools[0].input.old_string, "const s = '</invoke>'")
  assert.equal(r.tools[0].input.new_string, "const s = '</tool_use>'", '最后一个参数不能被静默丢掉')
})

test('开标签无 name 且体里也没有 name 参数 → 不救回，原样文本', async () => {
  const leak = '<tool_use id="t1">\n<parameter name="file_path">/a.ts</parameter>\n</invoke>'
  const r = await run([leak])
  assert.deepEqual(r.tools, [], '拿不到工具名不能瞎猜')
  assert.equal(r.text, leak, '应原样输出，不丢字符')
})

// 四个变化轴组合里最后一格：开标签无 name + JSON 体 → 名字只可能在 JSON 里
test('开标签无 name、JSON 体带 name 字段（含嵌套 input）→ 救回', async () => {
  const r = await run(['<tool_use id="t1">{"name":"Edit","input":{"file_path":"/a.ts","new_string":"x"}}</invoke>'])
  assert.deepEqual(r.tools, [{ name: 'Edit', input: { file_path: '/a.ts', new_string: 'x' } }])
})

test('开标签无 name、JSON 体 name 与参数平铺 → 救回且 name 不混进参数', async () => {
  const r = await run(['<tool_use id="t1">{"name":"Read","file_path":"/a.ts"}</tool_use>'])
  assert.deepEqual(r.tools, [{ name: 'Read', input: { file_path: '/a.ts' } }])
})

test('开标签带 name 时，体内的 name 仍是普通参数', async () => {
  const r = await run(['<tool_use id="t1" name="CreateFile">{"name":"foo.txt","dir":"/tmp"}</tool_use>'])
  assert.deepEqual(r.tools, [{ name: 'CreateFile', input: { name: 'foo.txt', dir: '/tmp' } }])
})

test('该形态在围栏内仍原样放行', async () => {
  const s = '```xml\n' + NAMELESS_LEAK + '\n```'
  const r = await run([s])
  assert.deepEqual(r.tools, [])
  assert.equal(r.text, s)
})

test('流结束仍未闭合的泄漏原样输出，不丢字符', async () => {
  const broken = '正文<tool_use id="t1" name="Bash">{"command":"ls"'
  const r = await run([broken])
  assert.deepEqual(r.tools, [])
  assert.equal(r.text, broken)
})

test('未闭合期间不提前吐出半截标签', async () => {
  let text = ''
  const f = createToolLeakFilter({ emit: (s) => { text += s } })
  await f.push('abc<tool_u')
  assert.equal(text, 'abc')
  await f.push('se id="t1" name="Read">{"file_path":"/a"}</invoke>')
  assert.equal(text, 'abc')
  await f.flush()
  assert.equal(text, 'abc')
  assert.deepEqual(f.leakedTools, [{ name: 'Read', input: { file_path: '/a' } }])
})

test('emit 的背压被保留（异步 emit 顺序串行）', async () => {
  const order: string[] = []
  const f = createToolLeakFilter({
    emit: async (s) => {
      order.push('start:' + s)
      await new Promise(resolve => setTimeout(resolve, 1))
      order.push('end:' + s)
    }
  })
  await f.push('a')
  await f.push('b')
  await f.flush()
  assert.deepEqual(order, ['start:a', 'end:a', 'start:b', 'end:b'])
})

test('toolSig 忽略键顺序', () => {
  assert.equal(toolSig('Bash', { a: 1, b: 2 }), toolSig('Bash', { b: 2, a: 1 }))
  assert.notEqual(toolSig('Bash', { a: 1 }), toolSig('Read', { a: 1 }))
})
