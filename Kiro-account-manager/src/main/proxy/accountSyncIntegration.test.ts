/**
 * 账号同步全链路集成测试：IPC 载荷 → filterSyncableAccounts → toPoolAccount → AccountPool → getNextAccount()
 *
 * 单独写这层，是因为之前 filter 和 AccountPool 各自的单测都是绿的，
 * 但拼起来是坏的：准入层按"基础额度 + 超额上限"放行超额账号，
 * toPoolAccount 却把超额字段剥掉了，池子只比基础额度，于是又把它判成耗尽——
 * 放行的账号一次都轮不到。任何一层的单测都看不见这个洞。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { AccountPool } from './accountPool.ts'
import { filterSyncableAccounts, type SyncCandidate } from './accountSyncFilter.ts'
import type { ProxyAccount } from './types.ts'

type Payload = ProxyAccount & Pick<SyncCandidate, 'lastError'>

/** 与 src/main/index.ts 的 toPoolAccount 保持一致 */
function toPoolAccount(account: Payload): ProxyAccount {
  const poolFields: Payload = { ...account }
  delete poolFields.lastError
  return poolFields
}

/** 走一遍 proxy-sync-accounts 的完整链路 */
function syncIntoPool(payload: Payload[]): { pool: AccountPool; skipped: string[] } {
  const { usable, skipped } = filterSyncableAccounts(payload)
  const pool = new AccountPool()
  pool.syncAccounts(usable.map(toPoolAccount))
  return { pool, skipped: skipped.map(s => s.id) }
}

/** 转 N 圈轮询，返回真正被选中过的账号 id */
function rotate(pool: AccountPool, rounds = 10): string[] {
  const seen = new Set<string>()
  for (let i = 0; i < rounds; i++) {
    const acc = pool.getNextAccount()
    if (!acc) break
    seen.add(acc.id)
    pool.recordSuccess(acc.id)
  }
  return [...seen].sort()
}

const acc = (id: string, extra: Partial<Payload> = {}): Payload =>
  ({ id, email: `${id}@x.com`, accessToken: `t-${id}`, ...extra }) as Payload

test('超额账号用超基础额度后，仍然进池子且能被轮询选中', () => {
  const { pool, skipped } = syncIntoPool([
    // 基础 500 已用 600，开了超额、上限 10000 —— 上游仍可服务
    acc('overage', { quotaUsed: 600, quotaLimit: 500, overageEnabled: true, overageCap: 10000 }),
    acc('normal')
  ])

  assert.deepEqual(skipped, [], '准入层不该拦它')
  assert.equal(pool.size, 2)
  assert.equal(pool.isQuotaExhausted(pool.getAccount('overage')!), false, '池子也不该判它耗尽')
  assert.equal(pool.availableCount, 2)
  assert.deepEqual(rotate(pool), ['normal', 'overage'], '两个账号都要参与轮询')
})

test('超额账号连超额上限也用完 → 挡在池子外', () => {
  const { pool, skipped } = syncIntoPool([
    acc('blown', { quotaUsed: 10500, quotaLimit: 500, overageEnabled: true, overageCap: 10000 }),
    acc('normal')
  ])

  assert.deepEqual(skipped, ['blown'])
  assert.equal(pool.size, 1)
  assert.deepEqual(rotate(pool), ['normal'])
})

test('超额上限未知 → 按无上限放行，池子里也不判耗尽', () => {
  const { pool, skipped } = syncIntoPool([
    acc('nocap', { quotaUsed: 999999, quotaLimit: 500, overageEnabled: true }),
    acc('normal')
  ])

  assert.deepEqual(skipped, [])
  assert.equal(pool.isQuotaExhausted(pool.getAccount('nocap')!), false)
  assert.deepEqual(rotate(pool), ['nocap', 'normal'])
})

test('没开超额的账号用满基础额度 → 挡在池子外', () => {
  const { pool, skipped } = syncIntoPool([
    acc('full', { quotaUsed: 500, quotaLimit: 500 }),
    acc('normal')
  ])

  assert.deepEqual(skipped, ['full'])
  assert.deepEqual(rotate(pool), ['normal'])
})

test('无额度数据的账号照常进池（还没轮询到用量，不能误伤）', () => {
  const { pool, skipped } = syncIntoPool([acc('fresh'), acc('normal')])
  assert.deepEqual(skipped, [])
  assert.deepEqual(rotate(pool), ['fresh', 'normal'])
})

test('封禁账号挡在池子外', () => {
  const { pool, skipped } = syncIntoPool([
    acc('banned', { lastError: 'AccountSuspendedException: ...' } as Partial<Payload>),
    acc('normal')
  ])
  assert.deepEqual(skipped, ['banned'])
  assert.equal(pool.size, 1)
})

test('lastError 不进池子，额度字段进', () => {
  const { pool } = syncIntoPool([
    acc('a', { quotaUsed: 100, quotaLimit: 500, overageEnabled: true, overageCap: 10000, lastError: 'fetch failed' } as Partial<Payload>)
  ])
  const stored = pool.getAccount('a')! as ProxyAccount & { lastError?: string }
  assert.equal(stored.lastError, undefined, 'lastError 只用于准入判断')
  assert.equal(stored.quotaUsed, 100)
  assert.equal(stored.quotaLimit, 500)
  assert.equal(stored.overageEnabled, true, '超额字段必须进池子，否则池子会把超额账号判成耗尽')
  assert.equal(stored.overageCap, 10000)
})

test('全部账号都不可用 → 池子留空，getNextAccount 返回 null', () => {
  const { pool, skipped } = syncIntoPool([
    acc('a', { quotaUsed: 500, quotaLimit: 500 }),
    acc('b', { quotaUsed: 300, quotaLimit: 300 })
  ])
  assert.deepEqual(skipped, ['a', 'b'])
  assert.equal(pool.size, 0)
  assert.equal(pool.getNextAccount(), null)
})

test('额度恢复后重新同步 → 账号回到池子', () => {
  const exhausted = acc('a', { quotaUsed: 500, quotaLimit: 500 })
  const first = syncIntoPool([exhausted, acc('b')])
  assert.equal(first.pool.size, 1)

  // 月度重置，用量归零后再同步一次
  const { usable } = filterSyncableAccounts([acc('a', { quotaUsed: 0, quotaLimit: 500 }), acc('b')])
  first.pool.syncAccounts(usable.map(toPoolAccount))

  assert.equal(first.pool.size, 2)
  assert.deepEqual(rotate(first.pool), ['a', 'b'])
})

test('402 打上的耗尽标记活过重同步，不会被额度数据洗掉', () => {
  const { pool } = syncIntoPool([acc('a', { quotaUsed: 10, quotaLimit: 500 }), acc('b')])
  // a 撞了 402
  pool.recordError('a', 'recoverable', 402)
  assert.equal(pool.isQuotaExhausted(pool.getAccount('a')!), true)

  // 渲染进程的用量数据还是旧的（显示还有余量），重新同步
  const { usable } = filterSyncableAccounts([acc('a', { quotaUsed: 10, quotaLimit: 500 }), acc('b')])
  pool.syncAccounts(usable.map(toPoolAccount))

  assert.equal(pool.isQuotaExhausted(pool.getAccount('a')!), true, '上游的 402 是实锤，不能被本地陈旧用量覆盖')
  assert.deepEqual(rotate(pool), ['b'])
})
