import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { UsageLedger, PRUNE_INTERVAL_MS } from './usageLedger.ts'

// 2026-07-31 12:00 本地时间
const T = new Date(2026, 6, 31, 12, 0, 0).getTime()
const DAY = 24 * 3600 * 1000

function mk(over: Record<string, unknown> = {}) {
  return {
    accountId: 'acc-1', apiKeyId: '__legacy__', model: 'claude-sonnet-4.6',
    clientIP: '10.0.1.133', status: 200, inputTokens: 100, outputTokens: 10,
    cacheReadTokens: 50, cacheWriteTokens: 0, reasoningTokens: 5,
    credits: 0.25, responseTimeMs: 1000, at: T,
    ...over
  }
}

test('同一组合累加到一行', () => {
  const l = new UsageLedger()
  l.add(mk())
  l.add(mk({ credits: 0.75, responseTimeMs: 3000 }))
  const rows = l.query('2026-07-31', '2026-07-31')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].requests, 2)
  assert.equal(rows[0].success, 2)
  assert.equal(rows[0].failed, 0)
  assert.equal(rows[0].credits, 1)
  assert.equal(rows[0].inputTokens, 200)
  assert.equal(rows[0].responseTimeMsSum, 4000)
  assert.equal(rows[0].firstAt, T)
  assert.equal(rows[0].lastAt, T)
})

test('维度不同拆成不同行', () => {
  const l = new UsageLedger()
  l.add(mk())
  l.add(mk({ model: 'claude-opus-5' }))
  l.add(mk({ clientIP: '10.0.1.132' }))
  assert.equal(l.query('2026-07-31', '2026-07-31').length, 3)
})

test('429/503 单独计数且都算 failed', () => {
  const l = new UsageLedger()
  l.add(mk({ status: 429 }))
  l.add(mk({ status: 503 }))
  l.add(mk({ status: 500 }))
  const r = l.query('2026-07-31', '2026-07-31')[0]
  assert.equal(r.requests, 3)
  assert.equal(r.failed, 3)
  assert.equal(r.rateLimited, 1)
  assert.equal(r.unavailable, 1)
})

test('缺失维度归一到 unknown', () => {
  const l = new UsageLedger()
  l.add(mk({ accountId: undefined, apiKeyId: undefined, model: undefined, clientIP: undefined }))
  const r = l.query('2026-07-31', '2026-07-31')[0]
  assert.equal(r.accountId, 'unknown')
  assert.equal(r.apiKeyId, 'anonymous')
  assert.equal(r.model, 'unknown')
  assert.equal(r.clientIP, 'unknown')
})

test('query 按日期区间闭区间过滤', () => {
  const l = new UsageLedger()
  l.add(mk({ at: T - DAY }))
  l.add(mk({ at: T }))
  l.add(mk({ at: T + DAY }))
  assert.equal(l.query('2026-07-31', '2026-07-31').length, 1)
  assert.equal(l.query('2026-07-30', '2026-08-01').length, 3)
  assert.equal(l.query('2026-08-05', '2026-08-06').length, 0)
})

test('超过单日键上限后归入 overflow 桶', () => {
  const l = new UsageLedger({ maxKeysPerDay: 3 })
  for (let i = 0; i < 5; i++) l.add(mk({ clientIP: `10.0.0.${i}` }))
  const rows = l.query('2026-07-31', '2026-07-31')
  assert.equal(rows.length, 4)                                  // 3 个正常 + 1 个 overflow
  const ov = rows.find(r => r.accountId === '__overflow__')!
  assert.equal(ov.requests, 2)
  assert.equal(ov.model, 'claude-sonnet-4.6')                   // overflow 桶只保模型维度
})

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'))
}

test('flush 落盘后能被新实例读回', () => {
  const dir = tmpDir()
  const a = new UsageLedger()
  a.initialize(dir)
  a.add(mk())
  a.flushSync()
  assert.ok(fs.existsSync(path.join(dir, 'kiro-usage-ledger.json')))

  const b = new UsageLedger()
  b.initialize(dir)
  const rows = b.query('2026-07-31', '2026-07-31')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].credits, 0.25)
})

test('读盘时裁掉超过保留期的天', () => {
  const dir = tmpDir()
  const a = new UsageLedger()
  a.initialize(dir)
  a.add(mk({ at: T }))
  a.add(mk({ at: T - 200 * DAY }))
  a.flushSync()

  // 用 now 注入「当前时间」，避免测试依赖真实今天
  const b = new UsageLedger({ retainDays: 90 })
  b.initialize(dir, T)
  assert.equal(b.query('2000-01-01', '2100-01-01').length, 1)
})

test('无变更时 flush 不重写文件', () => {
  const dir = tmpDir()
  const l = new UsageLedger()
  l.initialize(dir)
  l.add(mk())
  l.flushSync()
  const p = path.join(dir, 'kiro-usage-ledger.json')
  const mtime1 = fs.statSync(p).mtimeMs
  l.flushSync()
  assert.equal(fs.statSync(p).mtimeMs, mtime1)
})

test('文件损坏时降级为空账本而不抛', () => {
  const dir = tmpDir()
  fs.writeFileSync(path.join(dir, 'kiro-usage-ledger.json'), '{ not json')
  const l = new UsageLedger()
  l.initialize(dir)                                  // 不抛
  assert.equal(l.query('2000-01-01', '2100-01-01').length, 0)
  l.add(mk())
  l.flushSync()
  assert.equal(l.query('2026-07-31', '2026-07-31').length, 1)   // 之后仍可正常工作
})

const LEDGER = 'kiro-usage-ledger.json'
/** 让出一拍，给 setImmediate 调度的异步 flush 机会跑 */
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('waitFor timeout')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

test('攒够 flushEveryChanges 后异步落盘，不阻塞 add()', async () => {
  const dir = tmpDir()
  const p = path.join(dir, LEDGER)
  // flushIntervalMs 设很大，排除周期定时器干扰，只测阈值触发这条路
  const l = new UsageLedger({ flushEveryChanges: 3, flushIntervalMs: 3_600_000 })
  l.initialize(dir)

  l.add(mk())
  l.add(mk({ clientIP: '10.0.0.1' }))
  assert.equal(fs.existsSync(p), false)          // 未到阈值：不落盘
  l.add(mk({ clientIP: '10.0.0.2' }))
  assert.equal(fs.existsSync(p), false)          // 到阈值但仍在当前 tick：已挪出热路径

  await waitFor(() => fs.existsSync(p))
  const b = new UsageLedger()
  b.initialize(dir)
  assert.equal(b.query('2026-07-31', '2026-07-31').reduce((s, r) => s + r.requests, 0), 3)
})

test('落盘失败后退避，不再每个请求都重试', async () => {
  const dir = tmpDir()
  const l = new UsageLedger({ flushEveryChanges: 3, flushIntervalMs: 3_600_000 })
  l.initialize(dir)

  const orig = fs.promises.writeFile
  let attempts = 0
  ;(fs.promises as { writeFile: unknown }).writeFile = async (): Promise<void> => {
    attempts += 1
    throw new Error('ENOSPC: no space left on device')
  }
  try {
    for (let i = 0; i < 20; i++) l.add(mk())
    await waitFor(() => attempts >= 1)
    await tick()
    await tick()
    assert.equal(attempts, 1)      // 健康时 20/3 = 6 次；并发写保护把这一批压成 1 次

    for (let i = 0; i < 20; i++) l.add(mk())   // 退避窗口内继续来请求
    await tick()
    await tick()
    assert.equal(attempts, 1)      // 一次都没再试，stderr 也就不会刷屏
  } finally {
    ;(fs.promises as { writeFile: unknown }).writeFile = orig
  }
})

test('磁盘与上游的脏值都净化成数字，不产出字符串/NaN/null', () => {
  const dir = tmpDir()
  const p = path.join(dir, LEDGER)
  fs.writeFileSync(p, JSON.stringify({
    version: 1,
    rows: [{
      day: '2026-07-31', accountId: 'acc-1', apiKeyId: '__legacy__',
      model: 'claude-sonnet-4.6', clientIP: '10.0.1.133',
      requests: 1, success: 1, failed: 0, rateLimited: 0, unavailable: 0,
      inputTokens: 100, outputTokens: 10, cacheReadTokens: 50, cacheWriteTokens: 0,
      credits: '1.5',                      // 字符串：直接 += 会拼成 "1.50.25"
      responseTimeMsSum: 1000, firstAt: T, lastAt: T
      // reasoningTokens 整个缺失：undefined += n 会变 NaN，落盘序列化成 null
    }]
  }))

  const l = new UsageLedger()
  l.initialize(dir)
  const loaded = l.query('2026-07-31', '2026-07-31')[0]
  assert.equal(typeof loaded.credits, 'number')
  assert.equal(loaded.credits, 1.5)
  assert.equal(loaded.reasoningTokens, 0)

  // 上游 kiroApi 取 token 时没有 typeof 守卫（kiroApi.ts:1786），字符串可达
  l.add(mk({ inputTokens: '100', credits: '0.25' }) as never)
  const r = l.query('2026-07-31', '2026-07-31')[0]
  assert.equal(r.credits, 1.75)            // 不是 "1.50.25"
  assert.equal(r.inputTokens, 200)         // 不是 "100100"
  assert.equal(r.reasoningTokens, 5)       // 磁盘缺字段归一成 0 后再 +5，不是 NaN

  l.flushSync()
  const raw = fs.readFileSync(p, 'utf-8')
  assert.ok(!raw.includes('null'), '落盘不应出现 null（NaN 的序列化形态）')
  assert.ok(!raw.includes('"1.75"'), '落盘 credits 应是数字不是字符串')
})

test('stop() 停掉周期定时器并同步落盘', async () => {
  const dir = tmpDir()
  const p = path.join(dir, LEDGER)
  const l = new UsageLedger({ flushIntervalMs: 5, flushEveryChanges: 1000 })
  l.initialize(dir)
  l.add(mk())
  l.stop()
  assert.ok(fs.existsSync(p))              // 同步落盘：进程要退出，等不了 promise
  const mtime = fs.statSync(p).mtimeMs

  l.add(mk({ clientIP: '10.0.0.9' }))      // 有未落盘增量
  await new Promise(resolve => setTimeout(resolve, 60))   // 远超 flushIntervalMs
  assert.equal(fs.statSync(p).mtimeMs, mtime)             // 定时器已停，没有周期落盘
})

test('保留期裁剪在进程内生效，不靠重启', () => {
  const dir = tmpDir()
  const l = new UsageLedger({ retainDays: 90 })
  l.initialize(dir, T)
  l.add(mk({ at: T }))
  l.add(mk({ at: T - 200 * DAY }))
  assert.equal(l.query('2000-01-01', '2100-01-01').length, 2)

  l.pruneIfNeeded(T + 1000)                          // 闸门未到：热路径零开销
  assert.equal(l.query('2000-01-01', '2100-01-01').length, 2)

  l.pruneIfNeeded(T + PRUNE_INTERVAL_MS + 1)         // 闸门到点：裁掉过期天
  assert.equal(l.query('2000-01-01', '2100-01-01').length, 1)
})

test('overflow 行重载后不占用当日配额', () => {
  const dir = tmpDir()
  const a = new UsageLedger({ maxKeysPerDay: 2 })
  a.initialize(dir)
  for (let i = 0; i < 4; i++) a.add(mk({ clientIP: `10.0.0.${i}` }))   // 2 正常 + 1 overflow
  a.flushSync()
  assert.ok(a.query('2026-07-31', '2026-07-31').some(r => r.accountId === '__overflow__'))

  const b = new UsageLedger({ maxKeysPerDay: 3 })
  b.initialize(dir)
  b.add(mk({ clientIP: '10.9.9.9' }))      // 第 3 个正常组合，配额内
  const normals = b.query('2026-07-31', '2026-07-31').filter(r => r.accountId !== '__overflow__')
  assert.equal(normals.length, 3)          // overflow 行若计入 keysPerDay，这里会被折叠成 2
  assert.ok(normals.some(r => r.clientIP === '10.9.9.9'))
})
