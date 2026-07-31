// Kiro 用量账本：按「日 × 账号 × API Key × 模型 × 来源IP」聚合每请求的 credits/token，
// 定期原子落盘，供 auto-coding 大盘按日拉取。
//
// 刻意不 import electron：本文件用 `node --test` 直跑 .ts 源码做单测，
// userData 目录由调用方（main/index.ts）通过 initialize(dir) 传入。
// 也因此错误只走 console.error 而不用 proxyLogger —— logger.ts 顶层 import electron，
// 一引入本文件就跑不了 node --test。
//
// 落盘策略：本模块挂在反代响应回调上，而反代转发的是流式 SSE，Node 单线程里同步写盘
// 会把所有在飞的流一起冻住（实测 20000 行 JSON.stringify + writeFileSync 约 18ms，
// 最坏 180000 行 156ms）。所以阈值触发的落盘一律 setImmediate + fs.promises 异步做，
// 只有 stop() / initialize() 这两个「等不了 promise」的场合才用 flushSync()。
import fs from 'fs'
import path from 'path'

/** 单日键数上限：超出后新组合归入只保模型维度的 __overflow__ 桶，防高基数撑爆内存 */
export const DEFAULT_MAX_KEYS_PER_DAY = 2000
/** 账本保留天数：读盘时和进程内周期裁剪都用它 */
export const DEFAULT_RETAIN_DAYS = 90
/** 裁剪闸门间隔 1 小时：长跑进程必须在进程内裁，不能只靠重启 */
export const PRUNE_INTERVAL_MS = 60 * 60 * 1000
/** 落盘失败后的退避窗口：期间不再由 add() 触发重试，交给周期定时器 */
export const FLUSH_RETRY_COOLDOWN_MS = 60_000
const LEDGER_FILE = 'kiro-usage-ledger.json'
const OVERFLOW = '__overflow__'
const LEDGER_VERSION = 1
const DAY_MS = 24 * 3600 * 1000
// 月/日必须真实：宽松的 \d{2} 会让 "2026-99-99" 过关，而 '9' > '0' 使它躲过所有裁剪、
// '9' > '1' 又使 query() 永远查不到——和 "NaN-NaN-NaN" 同一形态的不死不可见行，换条路进来。
const DAY_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/

const pad2 = (n: number): string => String(n).padStart(2, '0')

/**
 * 把任何来源的数值净化成有限数字。
 * 必须做：这些值进的是**累加行**，一次污染永久留存——上游 kiroApi 取 token 时没有
 * typeof 守卫（kiroApi.ts:1786），字符串进来后 `row.inputTokens += '100'` 会把整行变成
 * 字符串并写进大盘读的文件；缺字段则 `undefined += n` 得 NaN，JSON 序列化成 null，
 * 下次 load 回来历史静默清零。沿用同目录 clientConfig.ts:266 的 Number.isFinite 范式。
 */
function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** credits 收敛到 6 位小数：纯为观感（0.1+0.2 会写出 0.30000000000000004），6 位正好对上下游 Numeric(18,6)。内部累加保持全精度 */
function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6
}

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
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** 磁盘上的一行不可信：逐字段归一，day 不合法就整行丢掉（顺手挡住 "NaN-NaN-NaN" 之类回流） */
function sanitizeRow(raw: unknown): LedgerRow | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const day = typeof r.day === 'string' ? r.day : ''
  if (!DAY_RE.test(day)) return null
  const str = (v: unknown, dflt: string): string => (typeof v === 'string' && v ? v : dflt)
  return {
    day,
    accountId: str(r.accountId, 'unknown'),
    apiKeyId: str(r.apiKeyId, 'anonymous'),
    model: str(r.model, 'unknown'),
    clientIP: str(r.clientIP, 'unknown'),
    requests: num(r.requests),
    success: num(r.success),
    failed: num(r.failed),
    rateLimited: num(r.rateLimited),
    unavailable: num(r.unavailable),
    inputTokens: num(r.inputTokens),
    outputTokens: num(r.outputTokens),
    cacheReadTokens: num(r.cacheReadTokens),
    cacheWriteTokens: num(r.cacheWriteTokens),
    reasoningTokens: num(r.reasoningTokens),
    credits: num(r.credits),
    responseTimeMsSum: num(r.responseTimeMsSum),
    firstAt: num(r.firstAt),
    lastAt: num(r.lastAt)
  }
}

export class UsageLedger {
  private rows = new Map<string, LedgerRow>()
  private keysPerDay = new Map<string, number>()
  private readonly maxKeysPerDay: number
  private readonly retainDays: number
  private filePath: string | null = null
  private pending = 0
  private flushing = false
  private flushScheduled = false
  private flushGeneration = 0
  private flushFailedAt = 0
  private lastFailureLogAt = 0
  private lastPrune = 0
  /** 持续故障时的日志复打间隔 */
  private static readonly FAILURE_RELOG_MS = 5 * 60_000
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
   * 读盘 + 裁剪闸门复位 + 启动周期 flush。
   * @param dir  userData 目录（由 main 进程传入，本模块不依赖 electron）
   * @param now  仅测试注入；生产不传
   */
  initialize(dir: string, now?: number): void {
    const at = now ?? Date.now()
    // 重入（代理重启 / 端口切换 / 设置变更时 main 会重走 init）：先把未落盘增量同步写掉，
    // 否则紧随的 load() 会 clear 掉最多 flushEveryChanges 个请求的账。必须同步版——
    // 异步会和 load() 抢同一个文件。
    this.flushSync()
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch (e) {
      console.error('[UsageLedger] mkdir failed:', (e as Error).message)
    }
    this.filePath = path.join(dir, LEDGER_FILE)
    this.lastPrune = at
    this.load(at)
    if (this.timer) clearInterval(this.timer)
    this.timer = setInterval(() => {
      this.pruneIfNeeded(Date.now())
      void this.flush()
    }, this.flushIntervalMs)
    // 别让定时器吊住进程退出（测试里尤其重要）
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  add(input: LedgerAddInput): void {
    const at = num(input.at) || Date.now()
    const status = num(input.status)
    const day = dayOf(at)
    const accountId = input.accountId || 'unknown'
    const apiKeyId = input.apiKeyId || 'anonymous'
    const model = input.model || 'unknown'
    const clientIP = input.clientIP || 'unknown'

    let key = `${day}|${accountId}|${apiKeyId}|${model}|${clientIP}`
    let row = this.rows.get(key)
    if (!row) {
      if ((this.keysPerDay.get(day) ?? 0) >= this.maxKeysPerDay) {
        // overflow 桶的 clientIP 用 '-' 而非 'unknown' 是刻意的：区分「被折叠掉」与
        // 「本来就没上报」。这一行里只有 day 和 model 两个维度可信。
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

    const ok = status >= 200 && status < 300
    row.requests += 1
    if (ok) row.success += 1
    else row.failed += 1
    if (status === 429) row.rateLimited += 1
    if (status === 503) row.unavailable += 1
    row.inputTokens += num(input.inputTokens)
    row.outputTokens += num(input.outputTokens)
    row.cacheReadTokens += num(input.cacheReadTokens)
    row.cacheWriteTokens += num(input.cacheWriteTokens)
    row.reasoningTokens += num(input.reasoningTokens)
    row.credits += num(input.credits)
    row.responseTimeMsSum += num(input.responseTimeMs)
    if (row.firstAt === 0 || at < row.firstAt) row.firstAt = at
    if (at > row.lastAt) row.lastAt = at
    this.markDirty()
  }

  // TODO 现在是 O(全部行) 全扫：大盘按天拉取、行数几千，微秒级，够用。
  // 若行数进 10 万量级或改成秒级轮询，按 day 建二级索引 Map<day, Map<key, row>>，
  // 顺带 flush() 可改成按天分片、只重写变更过的天。
  query(from: string, to: string): LedgerRow[] {
    const out: LedgerRow[] = []
    for (const row of this.rows.values()) {
      if (row.day >= from && row.day <= to) out.push({ ...row, credits: round6(row.credits) })
    }
    return out
  }

  /**
   * 异步落盘（阈值触发与周期定时器都走这条）；无变更或正在写则跳过。
   * 绝不抛错——账本坏掉不能拖垮反代。
   */
  async flush(): Promise<void> {
    if (!this.filePath || this.pending === 0 || this.flushing) return
    this.flushing = true
    const gen = ++this.flushGeneration
    const flushed = this.pending          // 快照：写盘期间新来的 add() 不能被抹掉
    const target = this.filePath
    const tmp = `${target}.tmp.${process.pid}`
    try {
      await fs.promises.writeFile(tmp, this.serialize(), 'utf-8')
      if (gen !== this.flushGeneration) {
        // 写盘期间 flushSync 已经把更新的快照 rename 上去了。两份 payload 都完整，
        // 但我们手里这份更旧——盖回去就是一次无日志、无重试的静默回滚（详见 N1 时序）。
        void fs.promises.unlink(tmp).catch(() => {})
        return                            // 刻意不 settleSuccess：这批增量没落地，pending 要留着
      }
      await fs.promises.rename(tmp, target)   // 同目录 rename 是原子的，避免半截文件
      this.settleSuccess(flushed)
    } catch (e) {
      this.settleFailure(e, tmp)
    } finally {
      this.flushing = false
    }
  }

  /**
   * ⚠️ 绝不可在响应路径调用：同步全量落盘会冻住所有在飞的 SSE 流（见文件头 C1，20000 行实测 17.6ms）。
   * 只给 stop()（进程要退出，等不了 promise）和 initialize() 重入用。
   * 这是 C1 唯一的回归入口——在 emitResponse() 里手滑调一次，ms 级尖刺就原封不动回来，且没有测试会报警。
   */
  flushSync(): void {
    if (!this.filePath || this.pending === 0) return
    const flushed = this.pending
    // 抢生效权：在飞的异步 flush 发现 generation 变了就自愿放弃 rename，不拿旧快照盖我们这份新的
    this.flushGeneration += 1
    // tmp 名带 .sync 后缀：万一异步 flush 正在写它那个 tmp，两边不能踩同一个文件，
    // 否则交错内容 rename 过去就是坏账本。
    const tmp = `${this.filePath}.tmp.${process.pid}.sync`
    try {
      fs.writeFileSync(tmp, this.serialize(), 'utf-8')
      fs.renameSync(tmp, this.filePath)
      this.settleSuccess(flushed)
    } catch (e) {
      this.settleFailure(e, tmp)
    }
  }

  /**
   * 退出前调用：停周期定时器 + 最后一次同步落盘。
   * 注意：stop() 之后仍接受 add()，且攒够阈值仍会异步落盘，只是不再周期落盘——
   * 停机过程中还有在飞的请求，继续记账比丢账好。读代码的人容易以为 stop 了就丢弃。
   */
  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    this.flushSync()
  }

  /**
   * 周期裁掉超过保留期的天。这个 Electron App 在 132 上常驻、几个月不重启是常态，
   * 若只在 initialize() 裁一次，第 200 天内存里就躺着 200 天的行——这也是 flush 越来越慢的根因。
   * 「时间戳闸门 + 周期扫」的范式照 promptCacheTracker.pruneIfNeeded 写，热路径零开销。
   * @param now 由 initialize() 的定时器传入；测试注入
   */
  pruneIfNeeded(now: number): void {
    if (now - this.lastPrune < PRUNE_INTERVAL_MS) return
    this.lastPrune = now
    const cutoff = dayOf(now - this.retainDays * DAY_MS)
    let removed = 0
    for (const [key, row] of this.rows) {
      if (row.day < cutoff) {
        this.rows.delete(key)
        removed += 1
      }
    }
    for (const day of this.keysPerDay.keys()) {
      if (day < cutoff) this.keysPerDay.delete(day)
    }
    // 有删除就标脏，让文件跟着缩；否则只有内存变小、磁盘照旧
    if (removed > 0) this.pending += 1
  }

  private serialize(): string {
    const rows = [...this.rows.values()].map(row => ({ ...row, credits: round6(row.credits) }))
    return JSON.stringify({ version: LEDGER_VERSION, rows })
  }

  private settleSuccess(flushed: number): void {
    // 必须减去发起时的快照，不能置 0：否则异步写盘期间来的 add() 会被静默丢掉
    this.pending = Math.max(0, this.pending - flushed)
    if (this.flushFailedAt !== 0) {
      // 恢复必须留痕：否则运维只看到一条孤立的失败日志，无法判断当前是好是坏
      console.error('[UsageLedger] flush recovered')
      // 复打闸门一并复位：恢复之后再失败必须立刻出声，不能被上一轮的 5 分钟窗口吞掉
      this.lastFailureLogAt = 0
    }
    this.flushFailedAt = 0
  }

  private settleFailure(e: unknown, tmp: string): void {
    // 清掉半截 tmp，否则写盘失败会在 userData 里留一个 MB 级孤儿文件长期不动
    void fs.promises.unlink(tmp).catch(() => {})
    const now = Date.now()
    this.flushFailedAt = now
    // 首次失败必打；之后每 5 分钟复打一次。只打一次的话长期故障就完全静默了，
    // 而这个模块存在的意义就是给运维提供可见性，自己哑掉是最坏的失败模式。
    // 复打闸门必须用独立的 lastFailureLogAt：flushFailedAt 兼着退避闸门 + 失败态标志两职，再塞一职会破坏退避。
    if (now - this.lastFailureLogAt < UsageLedger.FAILURE_RELOG_MS) return
    this.lastFailureLogAt = now
    console.error('[UsageLedger] flush failed, backing off:', (e as Error).message)
  }

  /** 攒够阈值就把落盘挪出当前请求（setImmediate），绝不在响应回调里同步写盘 */
  private markDirty(): void {
    this.pending += 1
    if (this.pending < this.flushEveryChanges) return
    // 两个旗标各管一段，别混：flushScheduled 管同一 tick 内的 burst（此时 flush() 还没跑，
    // flushing 必然是 false）；flushing 管后续 tick 里落在写盘窗口内的 add。
    if (this.flushScheduled || this.flushing) return
    // 失败退避：期间不由 add() 触发重试，避免每个请求都重试一次全量落盘（重试风暴）
    if (Date.now() - this.flushFailedAt < FLUSH_RETRY_COOLDOWN_MS) return
    this.flushScheduled = true
    setImmediate(() => {
      this.flushScheduled = false
      void this.flush()
    })
  }

  private load(now: number): void {
    this.rows.clear()
    this.keysPerDay.clear()
    this.pending = 0    // 内存与磁盘刚对齐，旧计数必须归零（否则失败退避的判断也会失真）
    if (!this.filePath || !fs.existsSync(this.filePath)) return
    const cutoff = dayOf(now - this.retainDays * DAY_MS)
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as {
        version?: unknown
        rows?: unknown
      }
      if (num(parsed.version) !== LEDGER_VERSION) {
        // 不硬拒：版本回滚不该丢历史，留痕后照常净化读入
        console.error(
          `[UsageLedger] unexpected ledger version ${String(parsed.version)}, expected ${LEDGER_VERSION}; reading anyway`
        )
      }
      for (const raw of Array.isArray(parsed.rows) ? parsed.rows : []) {
        const row = sanitizeRow(raw)
        if (!row || row.day < cutoff) continue
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
