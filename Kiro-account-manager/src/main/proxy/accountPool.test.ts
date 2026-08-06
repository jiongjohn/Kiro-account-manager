import test from 'node:test'
import assert from 'node:assert/strict'
import { AccountPool, ErrorType } from './accountPool.ts'
import type { ProxyAccount } from './types.ts'

function acc(id: string, extra: Partial<ProxyAccount> = {}): ProxyAccount {
  return {
    id,
    email: `${id}@x.com`,
    accessToken: `token-${id}`,
    ...extra
  } as ProxyAccount
}

test('syncAccounts：新增 / 移除 / 保留', () => {
  const pool = new AccountPool()
  pool.addAccount(acc('a'))
  pool.addAccount(acc('b'))

  const r = pool.syncAccounts([acc('a'), acc('c')])
  assert.deepEqual(r, { added: 1, updated: 1, removed: 1 })
  assert.deepEqual(pool.getAllAccounts().map(a => a.id).sort(), ['a', 'c'])
})

test('syncAccounts：保留 402 耗尽标记（重同步不再让耗尽账号满血复活）', () => {
  const pool = new AccountPool()
  pool.addAccount(acc('a'))
  pool.addAccount(acc('b'))

  // a 撞了 402，被标记耗尽
  assert.equal(pool.recordError('a', ErrorType.RECOVERABLE, 402), true)
  assert.equal(pool.isQuotaExhausted(pool.getAccount('a')!), true)

  // 重同步（比如用户改了分组）
  pool.syncAccounts([acc('a'), acc('b')])

  assert.equal(pool.isQuotaExhausted(pool.getAccount('a')!), true, '耗尽标记必须活过重同步')
  assert.equal(pool.getAccount('a')!.errorCount, 1, '断路器计数必须活过重同步')
})

test('syncAccounts：保留封禁标记', () => {
  const pool = new AccountPool()
  pool.addAccount(acc('a'))
  pool.markSuspended('a', 'TEMPORARILY_SUSPENDED', 'banned')

  pool.syncAccounts([acc('a')])

  const after = pool.getAccount('a')!
  assert.equal(pool.isSuspended(after), true)
  assert.equal(after.suspendReason, 'TEMPORARILY_SUSPENDED')
  assert.equal(after.isAvailable, false)
})

test('syncAccounts：undefined 字段不覆盖已有值（proxyUrl 走另一条 IPC，不能被擦掉）', () => {
  const pool = new AccountPool()
  pool.addAccount(acc('a', { proxyUrl: 'http://127.0.0.1:7890' }))

  // 渲染进程的同步载荷不含 proxyUrl
  pool.syncAccounts([acc('a')])

  assert.equal(pool.getAccount('a')!.proxyUrl, 'http://127.0.0.1:7890')
})

test('syncAccounts：已定义字段正常覆盖（token 刷新写回池子）', () => {
  const pool = new AccountPool()
  pool.addAccount(acc('a', { expiresAt: 1000 }))

  pool.syncAccounts([acc('a', { accessToken: 'token-new', expiresAt: 9999 })])

  const after = pool.getAccount('a')!
  assert.equal(after.accessToken, 'token-new')
  assert.equal(after.expiresAt, 9999)
})

test('syncAccounts：token 换新可以解除 markNeedsRefresh 造成的不可用', () => {
  const pool = new AccountPool()
  pool.addAccount(acc('a'))
  pool.markNeedsRefresh('a')
  assert.equal(pool.getAccount('a')!.isAvailable, false)

  // 同一个 token 重同步：维持不可用
  pool.syncAccounts([acc('a')])
  assert.equal(pool.getAccount('a')!.isAvailable, false)

  // 新 token 到位：恢复可用
  pool.syncAccounts([acc('a', { accessToken: 'token-fresh' })])
  assert.equal(pool.getAccount('a')!.isAvailable, true)
})

test('syncAccounts：被封禁的账号即便换了 token 也不恢复可用', () => {
  const pool = new AccountPool()
  pool.addAccount(acc('a'))
  pool.markSuspended('a', 'TEMPORARILY_SUSPENDED')

  pool.syncAccounts([acc('a', { accessToken: 'token-fresh' })])

  assert.equal(pool.getAccount('a')!.isAvailable, false)
})

test('syncAccounts：账号变少后轮询指针不越界', () => {
  const pool = new AccountPool()
  pool.addAccount(acc('a'))
  pool.addAccount(acc('b'))
  pool.addAccount(acc('c'))
  // 把指针推到尾部
  pool.recordSuccess('c')

  pool.syncAccounts([acc('a')])

  const next = pool.getNextAccount()
  assert.equal(next?.id, 'a')
})

test('syncAccounts：同步空列表等于清空', () => {
  const pool = new AccountPool()
  pool.addAccount(acc('a'))
  const r = pool.syncAccounts([])
  assert.deepEqual(r, { added: 0, updated: 0, removed: 1 })
  assert.equal(pool.size, 0)
  assert.equal(pool.getNextAccount(), null)
})

test('耗尽账号不参与轮询，availableCount 不计入', () => {
  const pool = new AccountPool()
  pool.addAccount(acc('a', { quotaUsed: 500, quotaLimit: 500 }))
  pool.addAccount(acc('b'))

  assert.equal(pool.availableCount, 1)
  assert.equal(pool.getNextAccount()?.id, 'b')
  assert.equal(pool.getQuotaStatus().exhausted, 1)
})
