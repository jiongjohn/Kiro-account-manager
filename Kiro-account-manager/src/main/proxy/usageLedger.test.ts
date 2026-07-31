import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { UsageLedger } from './usageLedger.ts'

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
  a.flush()
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
  a.flush()

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
  l.flush()
  const p = path.join(dir, 'kiro-usage-ledger.json')
  const mtime1 = fs.statSync(p).mtimeMs
  l.flush()
  assert.equal(fs.statSync(p).mtimeMs, mtime1)
})

test('文件损坏时降级为空账本而不抛', () => {
  const dir = tmpDir()
  fs.writeFileSync(path.join(dir, 'kiro-usage-ledger.json'), '{ not json')
  const l = new UsageLedger()
  l.initialize(dir)                                  // 不抛
  assert.equal(l.query('2000-01-01', '2100-01-01').length, 0)
  l.add(mk())
  l.flush()
  assert.equal(l.query('2026-07-31', '2026-07-31').length, 1)   // 之后仍可正常工作
})
