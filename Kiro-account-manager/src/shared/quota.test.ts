import test from 'node:test'
import assert from 'node:assert/strict'
import { effectiveQuotaLimit, isQuotaExhausted, quotaStateSignature } from './quota.ts'

test('有效上限：没开超额就是基础额度', () => {
  assert.equal(effectiveQuotaLimit({ quotaLimit: 500 }), 500)
  assert.equal(effectiveQuotaLimit({ quotaLimit: 500, overageEnabled: false, overageCap: 10000 }), 500)
})

test('有效上限：开了超额且 cap 有效 = 基础 + cap', () => {
  assert.equal(effectiveQuotaLimit({ quotaLimit: 500, overageEnabled: true, overageCap: 10000 }), 10500)
})

test('有效上限：开了超额但 cap 未知 = 无上限', () => {
  assert.equal(effectiveQuotaLimit({ quotaLimit: 500, overageEnabled: true }), Infinity)
  assert.equal(effectiveQuotaLimit({ quotaLimit: 500, overageEnabled: true, overageCap: 0 }), Infinity)
  assert.equal(effectiveQuotaLimit({ quotaLimit: 500, overageEnabled: true, overageCap: NaN }), Infinity)
})

test('有效上限：无额度数据返回 undefined', () => {
  assert.equal(effectiveQuotaLimit({}), undefined)
  assert.equal(effectiveQuotaLimit({ quotaLimit: 0 }), undefined)
  assert.equal(effectiveQuotaLimit({ quotaLimit: -1 }), undefined)
  assert.equal(effectiveQuotaLimit({ quotaLimit: NaN }), undefined)
  assert.equal(effectiveQuotaLimit({ quotaUsed: 999 }), undefined)
})

test('耗尽判定：普通账号', () => {
  assert.equal(isQuotaExhausted({ quotaUsed: 499, quotaLimit: 500 }), false)
  assert.equal(isQuotaExhausted({ quotaUsed: 500, quotaLimit: 500 }), true)
  assert.equal(isQuotaExhausted({ quotaUsed: 612, quotaLimit: 500 }), true)
})

test('耗尽判定：超额账号在 base..base+cap 之间不算耗尽', () => {
  const q = { quotaLimit: 500, overageEnabled: true, overageCap: 10000 }
  assert.equal(isQuotaExhausted({ ...q, quotaUsed: 600 }), false)
  assert.equal(isQuotaExhausted({ ...q, quotaUsed: 10499 }), false)
  assert.equal(isQuotaExhausted({ ...q, quotaUsed: 10500 }), true)
  assert.equal(isQuotaExhausted({ ...q, quotaUsed: 99999 }), true)
})

test('耗尽判定：超额无上限时永不耗尽', () => {
  assert.equal(isQuotaExhausted({ quotaUsed: 1e9, quotaLimit: 500, overageEnabled: true }), false)
})

test('耗尽判定：无额度数据放行', () => {
  assert.equal(isQuotaExhausted({}), false)
  assert.equal(isQuotaExhausted({ quotaUsed: 999, quotaLimit: 0 }), false)
})

test('耗尽判定：used 缺失按 0 处理', () => {
  assert.equal(isQuotaExhausted({ quotaLimit: 500 }), false)
  assert.equal(isQuotaExhausted({ quotaUsed: NaN, quotaLimit: 500 }), false)
})

test('签名：跨过基础额度会翻转（普通账号）', () => {
  const a = quotaStateSignature({ quotaUsed: 499, quotaLimit: 500 })
  const b = quotaStateSignature({ quotaUsed: 500, quotaLimit: 500 })
  assert.notEqual(a, b)
})

test('签名：超额账号跨过基础额度不翻转，跨过超额上限才翻转', () => {
  const q = { quotaLimit: 500, overageEnabled: true, overageCap: 10000 }
  const under = quotaStateSignature({ ...q, quotaUsed: 400 })
  const overBase = quotaStateSignature({ ...q, quotaUsed: 600 })
  const overCap = quotaStateSignature({ ...q, quotaUsed: 10500 })

  assert.equal(under, overBase, '还有超额余量，不该触发重同步')
  assert.notEqual(overBase, overCap, '超额真用完了，必须触发重同步把账号踢出池子')
})

test('签名：关掉超额会翻转（用户手动关超额后账号应立刻被踢出）', () => {
  const on = quotaStateSignature({ quotaUsed: 600, quotaLimit: 500, overageEnabled: true, overageCap: 10000 })
  const off = quotaStateSignature({ quotaUsed: 600, quotaLimit: 500, overageEnabled: false, overageCap: 10000 })
  assert.notEqual(on, off)
})

test('签名：额度重置后从耗尽翻回可用', () => {
  const exhausted = quotaStateSignature({ quotaUsed: 500, quotaLimit: 500 })
  const reset = quotaStateSignature({ quotaUsed: 0, quotaLimit: 500 })
  assert.notEqual(exhausted, reset)
})

test('签名：无额度数据自成一档，拿到数据后会翻转', () => {
  assert.equal(quotaStateSignature({}), 'n')
  assert.notEqual(quotaStateSignature({}), quotaStateSignature({ quotaUsed: 0, quotaLimit: 500 }))
})
