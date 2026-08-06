import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isBannedAccountError,
  filterSyncableAccounts,
  describeSkipped
} from './accountSyncFilter.ts'

// 纯额度判定的用例在 src/shared/quota.test.ts；这里只覆盖过滤器的组合行为

test('过滤：开超额的耗尽账号仍然同步', () => {
  const r = filterSyncableAccounts([
    { id: 'a', quotaUsed: 500, quotaLimit: 500, overageEnabled: true, overageCap: 10000 },
    { id: 'b', quotaUsed: 500, quotaLimit: 500 }
  ])
  assert.deepEqual(r.usable.map(a => a.id), ['a'])
  assert.deepEqual(r.skipped.map(s => s.id), ['b'])
})

test('封禁识别：命中 Kiro 风控信号词', () => {
  assert.equal(isBannedAccountError('AccountSuspendedException: ...'), true)
  assert.equal(isBannedAccountError('TEMPORARILY_SUSPENDED'), true)
  assert.equal(isBannedAccountError('User ID is xxx suspended'), true)
  assert.equal(isBannedAccountError('账户已封禁，请联系支持'), true)
  assert.equal(isBannedAccountError('HTTP 423 Locked'), true)
})

test('封禁识别：临时故障不算封禁', () => {
  assert.equal(isBannedAccountError(undefined), false)
  assert.equal(isBannedAccountError(''), false)
  assert.equal(isBannedAccountError('fetch failed'), false)
  assert.equal(isBannedAccountError('token expired'), false)
  assert.equal(isBannedAccountError('UnauthorizedException'), false)
  // 4231 不是 423，词边界必须生效
  assert.equal(isBannedAccountError('request id 4231'), false)
})

test('过滤：耗尽与封禁被剔除，其余保留', () => {
  const r = filterSyncableAccounts([
    { id: 'a', email: 'ok@x.com', quotaUsed: 10, quotaLimit: 500 },
    { id: 'b', email: 'full@x.com', quotaUsed: 500, quotaLimit: 500 },
    { id: 'c', email: 'ban@x.com', quotaUsed: 0, quotaLimit: 500, lastError: 'AccountSuspendedException' },
    { id: 'd', email: 'new@x.com' }
  ])
  assert.deepEqual(r.usable.map(a => a.id), ['a', 'd'])
  assert.deepEqual(r.skipped, [
    { id: 'b', email: 'full@x.com', reason: 'quota-exhausted' },
    { id: 'c', email: 'ban@x.com', reason: 'banned' }
  ])
})

test('过滤：封禁优先于耗尽归因（同时命中时只记一次）', () => {
  const r = filterSyncableAccounts([
    { id: 'a', quotaUsed: 500, quotaLimit: 500, lastError: 'TEMPORARILY_SUSPENDED' }
  ])
  assert.equal(r.usable.length, 0)
  assert.deepEqual(r.skipped, [{ id: 'a', email: undefined, reason: 'banned' }])
})

test('过滤：全部不可用时 usable 为空，不做全量回退', () => {
  const r = filterSyncableAccounts([
    { id: 'a', quotaUsed: 500, quotaLimit: 500 },
    { id: 'b', quotaUsed: 300, quotaLimit: 300 }
  ])
  assert.deepEqual(r.usable, [])
  assert.equal(r.skipped.length, 2)
})

test('过滤：空输入', () => {
  const r = filterSyncableAccounts([])
  assert.deepEqual(r.usable, [])
  assert.deepEqual(r.skipped, [])
})

test('跳过原因摘要', () => {
  assert.equal(describeSkipped([]), '')
  assert.equal(
    describeSkipped([
      { id: 'a', reason: 'quota-exhausted' },
      { id: 'b', reason: 'quota-exhausted' },
      { id: 'c', reason: 'banned' }
    ]),
    '2 quota-exhausted, 1 banned'
  )
})
