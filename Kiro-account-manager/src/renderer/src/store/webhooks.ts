import { create } from 'zustand'

/**
 * Webhook 通知中心
 *
 * 用于把关键事件（批量完成、风控触发、单账号注册成功/失败等）推送到外部 IM。
 * 内置常见 IM 的消息模板：钉钉 / 企微 / Telegram / Discord / 自定义 JSON。
 */

export type WebhookKind = 'dingtalk' | 'wechat-work' | 'telegram' | 'discord' | 'feishu' | 'custom'

export interface WebhookEntry {
  id: string
  kind: WebhookKind
  url: string
  label?: string
  enabled: boolean
  /** Telegram bot 模式需要 chat_id */
  telegramChatId?: string
  /** 自定义模式的 JSON 模板，{{title}} {{message}} {{level}} 占位符 */
  customTemplate?: string
  /** 订阅哪些事件 */
  events: WebhookEvent[]
  createdAt: number
}

export type WebhookEvent =
  | 'batch-completed'      // 批量任务完成
  | 'batch-error'          // 批量任务严重错误
  | 'risk-warning'         // 风控警告触发
  | 'account-banned'       // 账号被封禁
  | 'register-success'     // 单账号注册成功
  | 'register-failed'      // 单账号注册失败
  | 'token-expired'        // Token 过期/刷新失败
  | 'usage-warning'        // API Key 用量达到阈值（默认 90%）
  | 'account-pool-warning' // 账号池配额耗尽 / 可用账号低于阈值
  | 'account-usage-warning' // 上游账号月度额度用量达到阈值（默认 90%）

export const ALL_WEBHOOK_EVENTS: { value: WebhookEvent; label: string; labelEn: string }[] = [
  { value: 'batch-completed', label: '批量任务完成', labelEn: 'Batch completed' },
  { value: 'batch-error', label: '批量任务严重错误', labelEn: 'Batch error' },
  { value: 'risk-warning', label: '风控警告触发', labelEn: 'Risk warning' },
  { value: 'account-banned', label: '账号被封禁', labelEn: 'Account banned' },
  { value: 'register-success', label: '注册成功（单账号）', labelEn: 'Register success' },
  { value: 'register-failed', label: '注册失败（单账号）', labelEn: 'Register failed' },
  { value: 'token-expired', label: 'Token 过期/刷新失败', labelEn: 'Token expired' },
  { value: 'usage-warning', label: '下游 Key 用量达到阈值（90%）', labelEn: 'API Key usage (90%)' },
  { value: 'account-pool-warning', label: '账号池配额报警', labelEn: 'Account pool alert' },
  { value: 'account-usage-warning', label: '上游账号额度达到阈值（90%）', labelEn: 'Account usage (90%)' }
]

export interface WebhookMessage {
  title: string
  message: string
  level: 'info' | 'warn' | 'error' | 'success'
  /** 可选的额外字段（追加到 message 后） */
  fields?: Record<string, string | number>
}

interface WebhooksState {
  webhooks: Map<string, WebhookEntry>
}

interface WebhooksActions {
  addWebhook: (input: Omit<WebhookEntry, 'id' | 'createdAt'>) => string
  updateWebhook: (id: string, updates: Partial<WebhookEntry>) => void
  removeWebhook: (id: string) => void
  toggleWebhook: (id: string) => void
  /** 触发某个事件：自动给所有订阅了该事件的启用 webhook 发推送 */
  triggerEvent: (event: WebhookEvent, payload: WebhookMessage) => Promise<void>
  /** 测试单个 webhook（发一条测试消息） */
  testWebhook: (id: string) => Promise<{ success: boolean; error?: string }>
  /** 持久化加载（在 store 初始化时调用） */
  loadFromStorage: () => void
  saveToStorage: () => void
}

type WebhooksStore = WebhooksState & WebhooksActions

const STORAGE_KEY = 'kiro-webhooks'

export const useWebhookStore = create<WebhooksStore>()((set, get) => ({
  webhooks: new Map(),

  addWebhook: (input) => {
    const id = crypto.randomUUID()
    const entry: WebhookEntry = {
      ...input,
      id,
      createdAt: Date.now()
    }
    set((state) => {
      const next = new Map(state.webhooks)
      next.set(id, entry)
      return { webhooks: next }
    })
    get().saveToStorage()
    return id
  },

  updateWebhook: (id, updates) => {
    set((state) => {
      const next = new Map(state.webhooks)
      const existing = next.get(id)
      if (existing) next.set(id, { ...existing, ...updates })
      return { webhooks: next }
    })
    get().saveToStorage()
  },

  removeWebhook: (id) => {
    set((state) => {
      const next = new Map(state.webhooks)
      next.delete(id)
      return { webhooks: next }
    })
    get().saveToStorage()
  },

  toggleWebhook: (id) => {
    set((state) => {
      const next = new Map(state.webhooks)
      const existing = next.get(id)
      if (existing) next.set(id, { ...existing, enabled: !existing.enabled })
      return { webhooks: next }
    })
    get().saveToStorage()
  },

  triggerEvent: async (event, payload) => {
    const webhooks = Array.from(get().webhooks.values())
      .filter((w) => w.enabled && w.events.includes(event))
    if (webhooks.length === 0) return
    await Promise.allSettled(webhooks.map((w) => sendWebhook(w, payload)))
  },

  testWebhook: async (id) => {
    const webhook = get().webhooks.get(id)
    if (!webhook) return { success: false, error: 'Webhook 不存在' }
    try {
      await sendWebhook(webhook, {
        title: '🧪 测试通知',
        message: '这是来自 Kiro 账号管理器的测试消息。如果你看到这条消息，说明 Webhook 配置正确。',
        level: 'info',
        fields: { 时间: new Date().toLocaleString('zh-CN') }
      })
      return { success: true }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },

  loadFromStorage: () => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const arr = JSON.parse(raw) as WebhookEntry[]
      if (!Array.isArray(arr)) return
      const map = new Map<string, WebhookEntry>()
      for (const w of arr) map.set(w.id, w)
      set({ webhooks: map })
    } catch (err) {
      console.warn('[Webhook] Load failed:', err)
    }
  },

  saveToStorage: () => {
    try {
      const arr = Array.from(get().webhooks.values())
      localStorage.setItem(STORAGE_KEY, JSON.stringify(arr))
    } catch (err) {
      console.warn('[Webhook] Save failed:', err)
    }
  }
}))

// ==================== Webhook 发送实现 ====================

/** C9: 每个 webhook 的最近发送时间戳队列（用于本地速率限制） */
const sendTimestamps = new Map<string, number[]>()
const MAX_PER_MINUTE = 20  // 每个 webhook 最多每分钟 20 条
const RETRY_COUNT = 3
const RETRY_DELAY_BASE_MS = 1500  // 指数退避基数

/**
 * 检查并记录速率：超过阈值时返回 false，调用方应跳过本次发送
 */
function checkAndRecordRate(webhookId: string): boolean {
  const now = Date.now()
  const arr = sendTimestamps.get(webhookId) || []
  // 清理 1 分钟外
  const filtered = arr.filter((t) => now - t < 60_000)
  if (filtered.length >= MAX_PER_MINUTE) {
    sendTimestamps.set(webhookId, filtered)
    return false
  }
  filtered.push(now)
  sendTimestamps.set(webhookId, filtered)
  return true
}

/**
 * 校验「HTTP 200 但业务层失败」的情况。
 * 飞书 / 钉钉 / 企微 / Telegram 即使配置错误（安全设置、IP 白名单、关键词等）
 * 也返回 HTTP 200，真实成败在响应体的 code/errcode 字段里。只看 resp.ok 会把
 * 这些失败误判成功（"测试成功"假阳性）。
 * 返回 null = 成功；返回字符串 = 失败原因（含错误码，便于定位）。
 */
function parseProviderBizError(kind: WebhookKind, bodyText: string): string | null {
  // Discord 成功返回 204 无 body；custom 模板无统一约定 —— 不解析
  if (kind === 'discord' || kind === 'custom') return null
  let data: Record<string, unknown>
  try {
    if (!bodyText) return null
    data = JSON.parse(bodyText) as Record<string, unknown>
  } catch {
    return null // 非 JSON 响应，无法判定，按 HTTP 成功处理
  }
  switch (kind) {
    case 'feishu': {
      // 成功：code===0（新版）或 StatusCode===0（旧版）；缺字段也按成功
      const code = (data.code ?? data.StatusCode) as number | undefined
      if (code === 0 || code === undefined) return null
      return `飞书拒绝 code=${code} msg=${(data.msg ?? data.StatusMessage ?? '') as string}`
    }
    case 'dingtalk':
    case 'wechat-work': {
      const errcode = data.errcode as number | undefined
      if (errcode === 0 || errcode === undefined) return null
      return `${kind} 拒绝 errcode=${errcode} errmsg=${(data.errmsg ?? '') as string}`
    }
    case 'telegram': {
      if (data.ok === true) return null
      return `Telegram 拒绝 code=${(data.error_code ?? '') as string} desc=${(data.description ?? '') as string}`
    }
    default:
      return null
  }
}

/**
 * 按 webhook 类型构造消息体并 POST（含重试 + 速率限制）
 * 网络错误不会抛到调用方（仅 console.warn），避免影响主业务流程
 */
async function sendWebhook(webhook: WebhookEntry, payload: WebhookMessage): Promise<void> {
  // C9: 速率限制
  if (!checkAndRecordRate(webhook.id)) {
    console.warn(`[Webhook] ${webhook.kind} ${webhook.label || webhook.id} rate limit exceeded (>${MAX_PER_MINUTE}/min), drop`)
    return
  }

  const body = buildWebhookBody(webhook, payload)
  const url = webhook.kind === 'telegram'
    ? buildTelegramUrl(webhook)
    : webhook.url

  // C9: 重试逻辑（指数退避）
  let lastError: unknown
  for (let attempt = 0; attempt <= RETRY_COUNT; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_DELAY_BASE_MS * Math.pow(2, attempt - 1)
      await new Promise((resolve) => setTimeout(resolve, delay))
      console.log(`[Webhook] Retry ${attempt}/${RETRY_COUNT} for ${webhook.kind} ${webhook.label || webhook.id}`)
    }
    try {
      // 经主进程发送，绕开渲染进程 CORS（飞书/钉钉等 hook 不回 CORS 头，渲染进程直发会 "Failed to fetch"）
      const resp = await window.api.webhookSend({ url, body, timeoutMs: 8000 })
      if (resp.ok) {
        // HTTP 通了还要看业务层是否真的接受（飞书/钉钉/企微/TG 用响应体 code 表示成败）
        const bizErr = parseProviderBizError(webhook.kind, resp.body)
        if (!bizErr) {
          if (attempt > 0) {
            console.log(`[Webhook] ${webhook.kind} ${webhook.label || webhook.id} succeeded on retry ${attempt}`)
          }
          return
        }
        // 业务层拒绝（安全设置/IP 白名单/关键词等），重试无意义，直接结束
        lastError = new Error(bizErr)
        break
      }
      // status=0 = 主进程网络层失败（含超时），可重试
      if (resp.status === 0) {
        lastError = new Error(resp.error || 'Network error')
      } else if (resp.status >= 400 && resp.status < 500 && resp.status !== 408 && resp.status !== 429) {
        // 4xx 客户端错误（除 408/429）不重试
        lastError = new Error(`HTTP ${resp.status}`)
        break
      } else {
        lastError = new Error(`HTTP ${resp.status}`)
      }
    } catch (err) {
      lastError = err
    }
  }
  // 最终失败：抛出让调用方（测试按钮 / allSettled 事件流）能看到真实原因，不再静默吞掉
  const reason = lastError instanceof Error ? lastError.message : String(lastError)
  console.warn(`[Webhook] ${webhook.kind} ${webhook.label || webhook.id} failed: ${reason}`)
  throw lastError instanceof Error ? lastError : new Error(reason)
}

function buildTelegramUrl(webhook: WebhookEntry): string {
  // Telegram 的 URL 直接是 https://api.telegram.org/bot<token>/sendMessage
  return webhook.url.endsWith('/sendMessage') ? webhook.url : `${webhook.url.replace(/\/$/, '')}/sendMessage`
}

function buildWebhookBody(webhook: WebhookEntry, payload: WebhookMessage): unknown {
  const icon = ({ info: 'ℹ️', warn: '⚠️', error: '❌', success: '✅' } as const)[payload.level]
  const fieldsText = payload.fields
    ? '\n' + Object.entries(payload.fields).map(([k, v]) => `**${k}**: ${v}`).join('\n')
    : ''
  const plainFields = payload.fields
    ? '\n' + Object.entries(payload.fields).map(([k, v]) => `${k}: ${v}`).join('\n')
    : ''
  const fullText = `${icon} ${payload.title}\n\n${payload.message}${plainFields}`

  switch (webhook.kind) {
    case 'dingtalk':
      // 钉钉机器人 markdown
      return {
        msgtype: 'markdown',
        markdown: {
          title: payload.title,
          text: `### ${icon} ${payload.title}\n\n${payload.message}${fieldsText}`
        }
      }
    case 'wechat-work':
      // 企业微信机器人 markdown
      return {
        msgtype: 'markdown',
        markdown: {
          content: `## ${icon} ${payload.title}\n\n${payload.message}${fieldsText}`
        }
      }
    case 'feishu':
      // 飞书机器人 text
      return {
        msg_type: 'text',
        content: { text: fullText }
      }
    case 'telegram':
      return {
        chat_id: webhook.telegramChatId,
        text: fullText,
        parse_mode: 'Markdown'
      }
    case 'discord':
      // Discord webhook
      return {
        username: 'Kiro Account Manager',
        embeds: [{
          title: `${icon} ${payload.title}`,
          description: payload.message,
          color: payload.level === 'error' ? 0xff0000
            : payload.level === 'warn' ? 0xffaa00
            : payload.level === 'success' ? 0x00ff00
            : 0x4a9eff,
          fields: payload.fields
            ? Object.entries(payload.fields).map(([name, value]) => ({ name, value: String(value), inline: true }))
            : undefined,
          timestamp: new Date().toISOString()
        }]
      }
    case 'custom':
    default: {
      if (webhook.customTemplate) {
        // 简易模板替换
        try {
          const tpl = webhook.customTemplate
            .replace(/\{\{title\}\}/g, escapeJsonString(payload.title))
            .replace(/\{\{message\}\}/g, escapeJsonString(payload.message))
            .replace(/\{\{level\}\}/g, payload.level)
            .replace(/\{\{icon\}\}/g, icon)
          return JSON.parse(tpl)
        } catch {
          // 模板解析失败：退回简单 JSON
        }
      }
      return {
        title: payload.title,
        message: payload.message,
        level: payload.level,
        fields: payload.fields,
        timestamp: new Date().toISOString()
      }
    }
  }
}

function escapeJsonString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')
}
