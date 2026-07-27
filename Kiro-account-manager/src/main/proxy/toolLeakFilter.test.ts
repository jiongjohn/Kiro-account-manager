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
