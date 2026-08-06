/**
 * 上游 5xx 重试判定
 *
 * Kiro 上游偶发 500/502/503/504（网关抖动、后端扩缩容），这类错误重试一次通常就好了，
 * 直接甩给客户端会让 Claude Code / Cursor 这类工具当场报错中断。
 *
 * 判定必须基于**解析出来的状态码**，不能用 `msg.includes('500')`：
 * 错误消息里带着上游响应体，body 里出现 "500"（比如 max_tokens: 500）会误判成 5xx 无限重试。
 */

/** 默认最多重试 2 次（即一次请求最多打 3 次上游） */
export const DEFAULT_MAX_SERVER_ERROR_RETRIES = 2

/**
 * 从错误消息里提取上游 HTTP 状态码。
 * 主格式是 kiroApi 自己抛的 `API error 503: <body>` / `Auth error 403: <body>`，
 * 另外兼容 `HTTP 503` / `status 503` 这两种常见写法。取不到返回 undefined。
 */
export function extractUpstreamStatus(error: unknown): number | undefined {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  if (!message) return undefined

  const patterns = [
    /\b(?:API|Auth) error (\d{3})\b/,
    /\bHTTP\s*(\d{3})\b/i,
    /\bstatus(?:\s+code)?[:\s]+(\d{3})\b/i
  ]
  for (const re of patterns) {
    const m = message.match(re)
    if (m) {
      const code = parseInt(m[1], 10)
      if (code >= 100 && code <= 599) return code
    }
  }
  return undefined
}

/**
 * 是否属于"值得重试的上游服务端错误"。
 * 5xx 里排掉 501 / 505：这两个是确定性的协议层拒绝，重试多少次结果都一样，
 * 只会白白让客户端多等几秒。
 */
export function isRetryableServerError(error: unknown): boolean {
  const status = extractUpstreamStatus(error)
  if (status === undefined) return false
  if (status < 500 || status > 599) return false
  return status !== 501 && status !== 505
}

/** 第 n 次重试（n 从 1 起）前的等待时长：线性退避，与既有 callWithRetry 的节奏一致 */
export function serverErrorRetryDelay(retryIndex: number, baseMs: number): number {
  const n = Math.max(1, Math.floor(retryIndex))
  return Math.max(0, baseMs) * n
}

/** 一次流式尝试的结果：是否已经往客户端吐过内容 + 失败原因（null 表示成功） */
export interface StreamAttemptResult {
  emitted: boolean
  failure: Error | null
}

export interface RetryStreamOptions {
  /** 跑一次上游流式请求 */
  attempt: () => Promise<StreamAttemptResult>
  /** 最多重试几次（不含首次） */
  maxRetries: number
  /** 退避基数 */
  baseDelayMs: number
  /** 等待实现（由调用方注入，便于串接 AbortSignal / 测试里跳过真实定时器）；抛错表示被中止 */
  wait: (ms: number) => Promise<void>
  /** 客户端是否已断开 */
  isAborted?: () => boolean
  onRetry?: (retryIndex: number, delayMs: number, error: Error) => void
  onGiveUp?: (retries: number, error: Error) => void
}

/**
 * 流式请求的 5xx 重试循环。
 *
 * 放弃重试的四个条件，任一命中就把错误交回调用方：
 *  1. `emitted` —— 已经往客户端吐过内容，流没法回退重来
 *  2. 客户端已断开
 *  3. 不是可重试的 5xx
 *  4. 重试次数用尽
 *
 * @returns 最终的失败错误；null 表示成功
 */
export async function retryStreamOnServerError(opts: RetryStreamOptions): Promise<Error | null> {
  const maxRetries = Math.max(0, Math.floor(opts.maxRetries))
  let retries = 0

  for (;;) {
    const { emitted, failure } = await opts.attempt()
    if (!failure) return null

    const giveUp =
      emitted ||
      opts.isAborted?.() === true ||
      !isRetryableServerError(failure) ||
      retries >= maxRetries
    if (giveUp) {
      if (retries > 0 && !emitted) opts.onGiveUp?.(retries, failure)
      return failure
    }

    retries++
    const delay = serverErrorRetryDelay(retries, opts.baseDelayMs)
    opts.onRetry?.(retries, delay, failure)
    try {
      await opts.wait(delay)
    } catch (abortError) {
      return abortError as Error
    }
  }
}
