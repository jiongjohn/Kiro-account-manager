// Kiro 用量账本：按「日 × 账号 × API Key × 模型 × 来源IP」聚合每请求的 credits/token，
// 定期原子落盘，供 auto-coding 大盘按日拉取。
//
// 刻意不 import electron：本文件用 `node --test` 直跑 .ts 源码做单测，
// userData 目录由调用方（main/index.ts）通过 initialize(dir) 传入。
import fs from 'fs'
import path from 'path'

/** 单日键数上限：超出后新组合归入只保模型维度的 __overflow__ 桶，防高基数撑爆内存 */
export const DEFAULT_MAX_KEYS_PER_DAY = 2000
/** 账本保留天数：读盘时裁掉更早的天 */
export const DEFAULT_RETAIN_DAYS = 90
const LEDGER_FILE = 'kiro-usage-ledger.json'
const OVERFLOW = '__overflow__'

export interface LedgerRow {
  day: string            // YYYY-MM-DD（宿主机本地时区）
  accountId: string
  apiKeyId: string
  model: string
  clientIP: string
  requests: number
  success: number
  failed: number
  rateLimited: number    // status 429
  unavailable: number    // status 503
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  credits: number
  /** 耗时**总和**，不是均值：均值不能跨行再平均，由消费方除以 requests */
  responseTimeMsSum: number
  firstAt: number
  lastAt: number
}

export interface LedgerAddInput {
  accountId?: string
  apiKeyId?: string
  model?: string
  clientIP?: string
  status: number
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
  credits?: number
  responseTimeMs?: number
  /** 仅测试注入；生产不传，取 Date.now() */
  at?: number
}

export interface UsageLedgerOptions {
  maxKeysPerDay?: number
  retainDays?: number
}

/** 本地时区的 YYYY-MM-DD。不用 toISOString()——那是 UTC，会把 08:00 前的请求算到前一天 */
export function dayOf(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export class UsageLedger {
  private rows = new Map<string, LedgerRow>()
  private keysPerDay = new Map<string, number>()
  private readonly maxKeysPerDay: number
  private readonly retainDays: number

  constructor(opts: UsageLedgerOptions = {}) {
    this.maxKeysPerDay = opts.maxKeysPerDay ?? DEFAULT_MAX_KEYS_PER_DAY
    this.retainDays = opts.retainDays ?? DEFAULT_RETAIN_DAYS
  }

  add(input: LedgerAddInput): void {
    const at = input.at ?? Date.now()
    const day = dayOf(at)
    const accountId = input.accountId || 'unknown'
    const apiKeyId = input.apiKeyId || 'anonymous'
    const model = input.model || 'unknown'
    const clientIP = input.clientIP || 'unknown'

    let key = `${day}|${accountId}|${apiKeyId}|${model}|${clientIP}`
    let row = this.rows.get(key)
    if (!row) {
      if ((this.keysPerDay.get(day) ?? 0) >= this.maxKeysPerDay) {
        key = `${day}|${OVERFLOW}|${OVERFLOW}|${model}|-`
        row = this.rows.get(key)
        if (!row) {
          row = this.newRow(day, OVERFLOW, OVERFLOW, model, '-')
          this.rows.set(key, row)   // overflow 桶不计入 keysPerDay，否则会无限增桶
        }
      } else {
        row = this.newRow(day, accountId, apiKeyId, model, clientIP)
        this.rows.set(key, row)
        this.keysPerDay.set(day, (this.keysPerDay.get(day) ?? 0) + 1)
      }
    }

    const ok = input.status >= 200 && input.status < 300
    row.requests += 1
    if (ok) row.success += 1
    else row.failed += 1
    if (input.status === 429) row.rateLimited += 1
    if (input.status === 503) row.unavailable += 1
    row.inputTokens += input.inputTokens || 0
    row.outputTokens += input.outputTokens || 0
    row.cacheReadTokens += input.cacheReadTokens || 0
    row.cacheWriteTokens += input.cacheWriteTokens || 0
    row.reasoningTokens += input.reasoningTokens || 0
    row.credits += input.credits || 0
    row.responseTimeMsSum += input.responseTimeMs || 0
    if (row.firstAt === 0 || at < row.firstAt) row.firstAt = at
    if (at > row.lastAt) row.lastAt = at
  }

  query(from: string, to: string): LedgerRow[] {
    const out: LedgerRow[] = []
    for (const row of this.rows.values()) {
      if (row.day >= from && row.day <= to) out.push({ ...row })
    }
    return out
  }

  private newRow(day: string, accountId: string, apiKeyId: string, model: string, clientIP: string): LedgerRow {
    return {
      day, accountId, apiKeyId, model, clientIP,
      requests: 0, success: 0, failed: 0, rateLimited: 0, unavailable: 0,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      reasoningTokens: 0, credits: 0, responseTimeMsSum: 0, firstAt: 0, lastAt: 0
    }
  }
}

export const usageLedger = new UsageLedger()
