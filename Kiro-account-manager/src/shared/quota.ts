/**
 * 额度耗尽判定 —— 主进程与渲染进程唯一的一份实现。
 *
 * 为什么必须共享：这套判定同时被三个地方使用，任何一处漂移都会出事——
 *  1. 同步准入过滤（accountSyncFilter）决定账号进不进反代池
 *  2. 账号池轮询（AccountPool.isQuotaExhausted）决定账号选不选得中
 *  3. 渲染进程的同步签名决定"额度状态翻转了要不要重新同步"
 *
 * 之前 1 认超额、2 只认基础额度，结果准入层放行的超额账号在池子里被判成耗尽，
 * 一次都轮不到；3 因为只记录"是否超过基础额度"，超额真用完时签名不变，不会触发重同步。
 *
 * 保守原则：**没有额度数据时一律视为未耗尽**。limit 缺失/<=0 通常意味着还没轮询到
 * 上游用量，而不是"额度为零"，误判会把好账号踢出池子。
 */

export interface QuotaSnapshot {
  /** 本周期已用额度（credits） */
  quotaUsed?: number
  /** 本周期基础额度上限；<=0 / 缺失视为"无额度数据" */
  quotaLimit?: number
  /** 是否开启超额：开了之后用满基础额度仍能继续请求（按次计费） */
  overageEnabled?: boolean
  /** 超额上限（credits）；开了超额但上限未知时视为无上限 */
  overageCap?: number
}

function finiteOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 有效额度上限 = 账号真正能用到多少才会被上游拒。
 *
 * @returns 具体数值；`Infinity` 表示开了超额但上限未知（按无上限处理）；
 *          `undefined` 表示没有额度数据，调用方应当放行。
 */
export function effectiveQuotaLimit(quota: QuotaSnapshot): number | undefined {
  const base = finiteOrUndefined(quota.quotaLimit)
  if (base === undefined || base <= 0) return undefined

  if (quota.overageEnabled !== true) return base

  const cap = finiteOrUndefined(quota.overageCap)
  if (cap === undefined || cap <= 0) return Infinity
  return base + cap
}

/** 额度是否已耗尽（含超额）。无额度数据返回 false —— 见文件头的保守原则。 */
export function isQuotaExhausted(quota: QuotaSnapshot): boolean {
  const limit = effectiveQuotaLimit(quota)
  if (limit === undefined || limit === Infinity) return false
  return (finiteOrUndefined(quota.quotaUsed) ?? 0) >= limit
}

/**
 * 额度状态签名：**唯一**能代表"耗尽与否会不会变"的字符串。
 *
 * 渲染进程用它判断要不要重新同步账号池。必须由本模块产出，不能在调用方现搓——
 * 现搓过一次，漏掉了超额上限那一维，导致超额账号真用完后不会触发重同步。
 */
export function quotaStateSignature(quota: QuotaSnapshot): string {
  const limit = effectiveQuotaLimit(quota)
  if (limit === undefined) return 'n'          // 无额度数据
  if (limit === Infinity) return 'u'           // 超额无上限，永不耗尽
  return isQuotaExhausted(quota) ? 'x' : 'o'   // 已耗尽 / 有余量
}
