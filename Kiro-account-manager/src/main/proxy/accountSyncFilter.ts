/**
 * 账号同步准入过滤
 *
 * 同步到反代池之前，把「必然请求失败」的账号先剔掉：
 *  - 月度额度已耗尽（上游会回 402 MONTHLY_REQUEST_COUNT）
 *  - 被 Kiro 后端封禁（上游会回 AccountSuspendedException / 423）
 *
 * 放在主进程而不是渲染进程，是因为账号同步有两条路径（UI 手动/自动同步 +
 * 代理自启动时从 store 直读），策略必须只有一份，否则两条路会漂移。
 *
 * 额度耗尽的判定本身不在这里 —— 它由 shared/quota 提供，账号池轮询和渲染进程的
 * 同步签名共用同一份，避免"准入层放行、池子里又判成耗尽"这种自相矛盾。
 */
import { isQuotaExhausted, type QuotaSnapshot } from '../../shared/quota.ts'

/** 参与准入判断所需的最小字段集（渲染进程与自启动路径的账号形状不同，只取交集） */
export interface SyncCandidate extends QuotaSnapshot {
  id: string
  email?: string
  /** 账号最近一次错误文本，用于识别封禁 */
  lastError?: string
}

export type SkipReason = 'quota-exhausted' | 'banned'

export interface SkippedAccount {
  id: string
  email?: string
  reason: SkipReason
}

export interface SyncFilterResult<T> {
  usable: T[]
  skipped: SkippedAccount[]
}

/**
 * 从错误文本识别「账号被封禁」。
 * 与渲染进程 store 的 isBannedAccountError 保持同一套信号词；
 * 网络/token 类错误是临时故障，不算封禁，交给账号池的退避机制处理。
 */
export function isBannedAccountError(error?: string): boolean {
  if (!error) return false
  const e = error.toLowerCase()
  return (
    e.includes('accountsuspendedexception') ||
    e.includes('account suspended') ||
    e.includes('temporarily_suspended') ||
    e.includes('temporarily suspended') ||
    (e.includes('user id is') && e.includes('suspended')) ||
    e.includes('账户已封禁') ||
    e.includes('已封禁') ||
    /\b423\b/.test(e)
  )
}

/**
 * 拆分出「可同步」与「应跳过」两组。
 * 全部账号都不可用时 usable 为空数组 —— 调用方应让池子留空，
 * 让反代回明确的"无可用账号"，而不是回退成全量同步继续撞 402。
 */
export function filterSyncableAccounts<T extends SyncCandidate>(accounts: T[]): SyncFilterResult<T> {
  const usable: T[] = []
  const skipped: SkippedAccount[] = []

  for (const acc of accounts) {
    if (isBannedAccountError(acc.lastError)) {
      skipped.push({ id: acc.id, email: acc.email, reason: 'banned' })
      continue
    }
    if (isQuotaExhausted(acc)) {
      skipped.push({ id: acc.id, email: acc.email, reason: 'quota-exhausted' })
      continue
    }
    usable.push(acc)
  }

  return { usable, skipped }
}

/** 把跳过原因汇总成一行日志文本 */
export function describeSkipped(skipped: SkippedAccount[]): string {
  if (skipped.length === 0) return ''
  const exhausted = skipped.filter(s => s.reason === 'quota-exhausted').length
  const banned = skipped.filter(s => s.reason === 'banned').length
  const parts: string[] = []
  if (exhausted > 0) parts.push(`${exhausted} quota-exhausted`)
  if (banned > 0) parts.push(`${banned} banned`)
  return parts.join(', ')
}
