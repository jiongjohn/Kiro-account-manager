import test from 'node:test'
import assert from 'node:assert/strict'
import {
  extractUpstreamStatus,
  isRetryableServerError,
  serverErrorRetryDelay,
  retryStreamOnServerError,
  DEFAULT_MAX_SERVER_ERROR_RETRIES,
  type StreamAttemptResult
} from './upstreamRetry.ts'

interface Harness {
  run: () => Promise<Error | null>
  waits: number[]
  retries: Array<{ index: number; delay: number; message: string }>
  gaveUp: Array<{ retries: number; message: string }>
  calls: () => number
}

/** 造一个按脚本依次返回结果的 attempt，并记录调用次数与等待时长 */
function harness(script: Array<StreamAttemptResult>, opts: { maxRetries?: number; aborted?: () => boolean } = {}): Harness {
  const waits: number[] = []
  const retries: Array<{ index: number; delay: number; message: string }> = []
  const gaveUp: Array<{ retries: number; message: string }> = []
  let calls = 0
  const run = (): Promise<Error | null> => retryStreamOnServerError({
    attempt: async () => {
      const step = script[Math.min(calls, script.length - 1)]
      calls++
      return step
    },
    maxRetries: opts.maxRetries ?? 2,
    baseDelayMs: 1000,
    wait: async (ms) => { waits.push(ms) },
    isAborted: opts.aborted,
    onRetry: (index, delay, error) => retries.push({ index, delay, message: error.message }),
    onGiveUp: (n, error) => gaveUp.push({ retries: n, message: error.message })
  })
  return { run, waits, retries, gaveUp, calls: () => calls }
}

const ok: StreamAttemptResult = { emitted: true, failure: null }
const fail5xx = (code = 503): StreamAttemptResult => ({ emitted: false, failure: new Error(`API error ${code}: boom`) })
const fail5xxMidStream = (code = 503): StreamAttemptResult => ({ emitted: true, failure: new Error(`API error ${code}: boom`) })
const fail4xx: StreamAttemptResult = { emitted: false, failure: new Error('API error 400: bad request') }

test('提取状态码：kiroApi 自己抛的格式', () => {
  assert.equal(extractUpstreamStatus(new Error('API error 503: upstream unavailable')), 503)
  assert.equal(extractUpstreamStatus(new Error('Auth error 403: expired')), 403)
  assert.equal(extractUpstreamStatus('API error 500: {"message":"internal"}'), 500)
})

test('提取状态码：兼容 HTTP xxx / status xxx 写法', () => {
  assert.equal(extractUpstreamStatus(new Error('HTTP 502 Bad Gateway')), 502)
  assert.equal(extractUpstreamStatus(new Error('http504 timeout')), 504)
  assert.equal(extractUpstreamStatus(new Error('Request failed with status 500')), 500)
  assert.equal(extractUpstreamStatus(new Error('status code: 503')), 503)
})

test('提取状态码：取不到时返回 undefined', () => {
  assert.equal(extractUpstreamStatus(new Error('fetch failed')), undefined)
  assert.equal(extractUpstreamStatus(new Error('')), undefined)
  assert.equal(extractUpstreamStatus(undefined), undefined)
  assert.equal(extractUpstreamStatus(null), undefined)
  assert.equal(extractUpstreamStatus({ message: 'API error 500' }), undefined)
})

test('提取状态码：响应体里的裸数字不算状态码（这正是不能用 includes 的原因）', () => {
  // 旧的 msg.includes('500') 会把这条误判成 5xx，然后无限重试一个参数错误
  const e = new Error('API error 400: {"message":"max_tokens must be <= 500"}')
  assert.equal(extractUpstreamStatus(e), 400)
  assert.equal(isRetryableServerError(e), false)
})

test('可重试判定：5xx 可重试', () => {
  assert.equal(isRetryableServerError(new Error('API error 500: x')), true)
  assert.equal(isRetryableServerError(new Error('API error 502: x')), true)
  assert.equal(isRetryableServerError(new Error('API error 503: x')), true)
  assert.equal(isRetryableServerError(new Error('API error 504: x')), true)
  assert.equal(isRetryableServerError(new Error('API error 529: overloaded')), true)
})

test('可重试判定：501/505 是确定性拒绝，不重试', () => {
  assert.equal(isRetryableServerError(new Error('API error 501: not implemented')), false)
  assert.equal(isRetryableServerError(new Error('API error 505: bad version')), false)
})

test('可重试判定：4xx / 无状态码不重试', () => {
  assert.equal(isRetryableServerError(new Error('API error 400: bad request')), false)
  assert.equal(isRetryableServerError(new Error('Auth error 403: expired')), false)
  assert.equal(isRetryableServerError(new Error('API error 429: throttled')), false)
  assert.equal(isRetryableServerError(new Error('fetch failed')), false)
  assert.equal(isRetryableServerError(new Error('socket hang up')), false)
})

test('退避时长：线性递增', () => {
  assert.equal(serverErrorRetryDelay(1, 1000), 1000)
  assert.equal(serverErrorRetryDelay(2, 1000), 2000)
  assert.equal(serverErrorRetryDelay(0, 1000), 1000)
  assert.equal(serverErrorRetryDelay(1, 0), 0)
  assert.equal(serverErrorRetryDelay(1, -5), 0)
})

test('默认重试次数为 2', () => {
  assert.equal(DEFAULT_MAX_SERVER_ERROR_RETRIES, 2)
})

// ---- 重试循环 ----

test('循环：首次成功不重试', async () => {
  const h = harness([ok])
  assert.equal(await h.run(), null)
  assert.equal(h.calls(), 1)
  assert.deepEqual(h.waits, [])
})

test('循环：5xx 后重试成功', async () => {
  const h = harness([fail5xx(), ok])
  assert.equal(await h.run(), null)
  assert.equal(h.calls(), 2)
  assert.deepEqual(h.waits, [1000])
  assert.deepEqual(h.retries.map(r => r.index), [1])
  assert.deepEqual(h.gaveUp, [])
})

test('循环：持续 5xx 最多重试 2 次，共打 3 次上游', async () => {
  const h = harness([fail5xx()])
  const err = await h.run()
  assert.match(err!.message, /API error 503/)
  assert.equal(h.calls(), 3, '1 次首发 + 2 次重试')
  assert.deepEqual(h.waits, [1000, 2000], '线性退避')
  assert.deepEqual(h.retries.map(r => r.index), [1, 2])
  assert.deepEqual(h.gaveUp.map(g => g.retries), [2])
})

test('循环：maxRetries=0 时完全不重试', async () => {
  const h = harness([fail5xx()], { maxRetries: 0 })
  assert.ok(await h.run())
  assert.equal(h.calls(), 1)
  assert.deepEqual(h.waits, [])
  assert.deepEqual(h.gaveUp, [], '没重试过就不算"重试后仍失败"')
})

test('循环：非 5xx 直接透出，不浪费重试', async () => {
  const h = harness([fail4xx])
  const err = await h.run()
  assert.match(err!.message, /400/)
  assert.equal(h.calls(), 1)
  assert.deepEqual(h.waits, [])
})

test('循环：已经吐过内容的失败不重试（流无法回退）', async () => {
  const h = harness([fail5xxMidStream()])
  const err = await h.run()
  assert.match(err!.message, /API error 503/)
  assert.equal(h.calls(), 1, '中途断流只能把错误透出去，重发会让客户端收到重复内容')
  assert.deepEqual(h.waits, [])
})

test('循环：客户端已断开时不重试', async () => {
  const h = harness([fail5xx()], { aborted: () => true })
  assert.ok(await h.run())
  assert.equal(h.calls(), 1)
})

test('循环：重试期间客户端断开 → wait 抛错，返回该错误并停止', async () => {
  let calls = 0
  const abortErr = new Error('Request aborted')
  const err = await retryStreamOnServerError({
    attempt: async () => { calls++; return fail5xx() },
    maxRetries: 2,
    baseDelayMs: 1000,
    wait: async () => { throw abortErr }
  })
  assert.equal(err, abortErr)
  assert.equal(calls, 1)
})

test('循环：501 不重试（确定性拒绝）', async () => {
  const h = harness([fail5xx(501)])
  assert.ok(await h.run())
  assert.equal(h.calls(), 1)
})

test('循环：先 502 再 503 再成功', async () => {
  const h = harness([fail5xx(502), fail5xx(503), ok])
  assert.equal(await h.run(), null)
  assert.equal(h.calls(), 3)
  assert.deepEqual(h.retries.map(r => r.message), ['API error 502: boom', 'API error 503: boom'])
})
