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
  flushIntervalMs?: number
  flushEveryChanges?: number
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
  private filePath: string | null = null
  private pending = 0
  private timer: NodeJS.Timeout | null = null
  private readonly flushIntervalMs: number
  private readonly flushEveryChanges: number

  constructor(opts: UsageLedgerOptions = {}) {
    this.maxKeysPerDay = opts.maxKeysPerDay ?? DEFAULT_MAX_KEYS_PER_DAY
    this.retainDays = opts.retainDays ?? DEFAULT_RETAIN_DAYS
    this.flushIntervalMs = opts.flushIntervalMs ?? 30_000
    this.flushEveryChanges = opts.flushEveryChanges ?? 200
  }

  /**
   * 读盘 + 裁剪 + 启动周期 flush。
   * @param dir  userData 目录（由 main 进程传入，本模块不依赖 electron）
   * @param now  仅测试注入；生产不传
   */
  initialize(dir: string, now?: number): void {
    this.filePath = path.join(dir, LEDGER_FILE)
    this.load(now ?? Date.now())
    if (this.timer) clearInterval(this.timer)
    this.timer = setInterval(() => this.flush(), this.flushIntervalMs)
    // 别让定时器吊住进程退出（测试里尤其重要）
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  /** 立即落盘；无变更则跳过。绝不抛错——账本坏掉不能拖垮反代 */
  flush(): void {
    if (!this.filePath || this.pending === 0) return
    try {
      const payload = JSON.stringify({ version: 1, rows: [...this.rows.values()] })
      const tmp = `${this.filePath}.tmp`
      fs.writeFileSync(tmp, payload, 'utf-8')
      fs.renameSync(tmp, this.filePath)      // 同目录 rename 是原子的，避免半截文件
      this.pending = 0
    } catch (e) {
      console.error('[UsageLedger] flush failed:', (e as Error).message)
    }
  }

  /** 退出前调用：停定时器 + 最后一次落盘 */
  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    this.flush()
  }

  private markDirty(): void {
    this.pending += 1
    if (this.pending >= this.flushEveryChanges) this.flush()
  }

  private load(now: number): void {
    this.rows.clear()
    this.keysPerDay.clear()
    if (!this.filePath || !fs.existsSync(this.filePath)) return
    const cutoff = dayOf(now - this.retainDays * 24 * 3600 * 1000)
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as { rows?: LedgerRow[] }
      for (const row of parsed.rows ?? []) {
        if (!row?.day || row.day < cutoff) continue
        const key = `${row.day}|${row.accountId}|${row.apiKeyId}|${row.model}|${row.clientIP}`
        this.rows.set(key, row)
        if (row.accountId !== OVERFLOW) {
          this.keysPerDay.set(row.day, (this.keysPerDay.get(row.day) ?? 0) + 1)
        }
      }
    } catch (e) {
      // 文件损坏：宁可丢历史也要让反代正常起来；下一次 flush 会把文件重写成好的
      console.error('[UsageLedger] load failed, starting empty:', (e as Error).message)
      this.rows.clear()
      this.keysPerDay.clear()
    }
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
    this.markDirty()
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
