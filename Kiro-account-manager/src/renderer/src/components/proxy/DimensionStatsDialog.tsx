import { useState, useMemo } from 'react'
import { X, BarChart3, KeyRound, Globe, Cpu, Database } from 'lucide-react'
import { Button, Card, CardContent, CardHeader, CardTitle, Badge } from '../ui'

// 与 main/proxy/types.ts 的 DimensionStat / DimensionStats 保持一致
export interface DimensionStat {
  key: string
  label?: string
  requests: number
  successRequests: number
  failedRequests: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  credits: number
  lastUsed: number
}

export interface DimensionStats {
  byApiKey: Record<string, DimensionStat>
  byClientIP: Record<string, DimensionStat>
  byModel: Record<string, DimensionStat>
}

type DimensionTab = 'apiKey' | 'clientIP' | 'model'

interface DimensionStatsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  dimensionStats?: DimensionStats
  isEn: boolean
}

// 缓存命中率 = cacheRead / (input + cacheRead + cacheWrite)
// 即「本可作为输入的总 token 中，有多少是从缓存读取的」
function cacheHitRate(stat: DimensionStat): number {
  const denom = stat.inputTokens + stat.cacheReadTokens + stat.cacheWriteTokens
  if (denom <= 0) return 0
  return stat.cacheReadTokens / denom
}

function formatModel(model: string): string {
  return model.replace('anthropic.', '').replace('-v1:0', '')
}

function compactNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

export function DimensionStatsDialog({ open, onOpenChange, dimensionStats, isEn }: DimensionStatsDialogProps): React.ReactNode {
  const [activeTab, setActiveTab] = useState<DimensionTab>('apiKey')

  const tableFor = (tab: DimensionTab): Record<string, DimensionStat> => {
    if (!dimensionStats) return {}
    if (tab === 'apiKey') return dimensionStats.byApiKey
    if (tab === 'clientIP') return dimensionStats.byClientIP
    return dimensionStats.byModel
  }

  const rows = useMemo(() => {
    const table = tableFor(activeTab)
    return Object.values(table).sort((a, b) => b.requests - a.requests)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, dimensionStats])

  // 汇总命中率（当前维度所有行加总）
  const overall = useMemo(() => {
    let cacheRead = 0
    let input = 0
    let cacheWrite = 0
    let requests = 0
    for (const r of rows) {
      cacheRead += r.cacheReadTokens
      input += r.inputTokens
      cacheWrite += r.cacheWriteTokens
      requests += r.requests
    }
    const denom = input + cacheRead + cacheWrite
    return { requests, hitRate: denom > 0 ? cacheRead / denom : 0, cacheRead }
  }, [rows])

  if (!open) return null

  const tabs: { value: DimensionTab; label: string; labelEn: string; icon: typeof KeyRound }[] = [
    { value: 'apiKey', label: '按 API Key', labelEn: 'By API Key', icon: KeyRound },
    { value: 'clientIP', label: '按接入 IP', labelEn: 'By Client IP', icon: Globe },
    { value: 'model', label: '按模型', labelEn: 'By Model', icon: Cpu }
  ]

  const keyHeader = activeTab === 'apiKey'
    ? (isEn ? 'API Key' : 'API Key')
    : activeTab === 'clientIP'
      ? (isEn ? 'Client IP' : '接入 IP')
      : (isEn ? 'Model' : '模型')

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={() => onOpenChange(false)} />
      <Card className="relative w-[920px] max-h-[85vh] shadow-2xl border-0 overflow-hidden animate-in fade-in zoom-in-95 duration-200 glass-card-strong">
        <CardHeader className="pb-3 border-b sticky top-0 z-10">
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg flex items-center gap-2">
              <BarChart3 className="h-5 w-5 text-primary" />
              {isEn ? 'Dimensional Statistics' : '维度统计'}
            </CardTitle>
            <Button variant="ghost" size="icon" className="h-8 w-8 rounded-lg hover:bg-red-500 hover:text-white transition-colors" onClick={() => onOpenChange(false)}>
              <X className="h-4 w-4" />
            </Button>
          </div>

          {/* 汇总卡片 */}
          <div className="grid grid-cols-3 gap-4 mt-4">
            <div className="bg-primary/10 rounded-lg p-3">
              <div className="text-xs text-muted-foreground mb-1">{isEn ? 'Requests' : '请求数'}</div>
              <div className="text-xl font-bold text-primary">{overall.requests.toLocaleString()}</div>
            </div>
            <div className="bg-success/10 rounded-lg p-3">
              <div className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
                <Database className="h-3 w-3" />
                {isEn ? 'Cache Hit Rate' : '缓存命中率'}
              </div>
              <div className="text-xl font-bold text-success">{(overall.hitRate * 100).toFixed(1)}%</div>
            </div>
            <div className="bg-[var(--gradient-to)]/10 rounded-lg p-3">
              <div className="text-xs text-muted-foreground mb-1">{isEn ? 'Cache Read Tokens' : '缓存读取 Tokens'}</div>
              <div className="text-xl font-bold text-[var(--gradient-to)]">{compactNumber(overall.cacheRead)}</div>
            </div>
          </div>

          {/* Tab 切换 */}
          <div className="flex gap-2 mt-4">
            {tabs.map(tab => {
              const Icon = tab.icon
              return (
                <Button
                  key={tab.value}
                  variant={activeTab === tab.value ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setActiveTab(tab.value)}
                >
                  <Icon className="h-4 w-4 mr-1" />
                  {isEn ? tab.labelEn : tab.label}
                </Button>
              )
            })}
          </div>
        </CardHeader>

        <CardContent className="p-4 max-h-[calc(85vh-260px)] overflow-y-auto">
          {rows.length > 0 ? (
            <table className="w-full text-sm">
              <thead className="bg-muted/50 sticky top-0">
                <tr>
                  <th className="text-left p-2 font-medium">{keyHeader}</th>
                  <th className="text-right p-2 font-medium">{isEn ? 'Requests' : '请求'}</th>
                  <th className="text-right p-2 font-medium">{isEn ? 'Success' : '成功率'}</th>
                  <th className="text-right p-2 font-medium">{isEn ? 'In' : '输入'}</th>
                  <th className="text-right p-2 font-medium">{isEn ? 'Out' : '输出'}</th>
                  <th className="text-right p-2 font-medium">{isEn ? 'Cache Read' : '缓存读'}</th>
                  <th className="text-right p-2 font-medium">{isEn ? 'Hit Rate' : '命中率'}</th>
                  <th className="text-right p-2 font-medium">Credits</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {rows.map((stat) => {
                  const hr = cacheHitRate(stat)
                  const successRate = stat.requests > 0 ? (stat.successRequests / stat.requests) * 100 : 0
                  const display = activeTab === 'model'
                    ? formatModel(stat.key)
                    : (stat.label || stat.key)
                  return (
                    <tr key={stat.key} className="border-b border-muted/30 hover:bg-muted/30">
                      <td className="p-2 truncate max-w-[220px]" title={stat.key}>
                        {display}
                        {activeTab === 'apiKey' && stat.label && stat.label !== stat.key && (
                          <span className="ml-1 text-[10px] text-muted-foreground">({stat.key.slice(0, 8)})</span>
                        )}
                      </td>
                      <td className="p-2 text-right">{stat.requests.toLocaleString()}</td>
                      <td className="p-2 text-right">
                        <Badge variant="outline" className={successRate >= 99 ? 'text-success border-success/30' : successRate >= 90 ? '' : 'text-destructive border-destructive/30'}>
                          {successRate.toFixed(0)}%
                        </Badge>
                      </td>
                      <td className="p-2 text-right text-muted-foreground">{compactNumber(stat.inputTokens)}</td>
                      <td className="p-2 text-right text-muted-foreground">{compactNumber(stat.outputTokens)}</td>
                      <td className="p-2 text-right text-success">{compactNumber(stat.cacheReadTokens)}</td>
                      <td className="p-2 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <div className="w-12 h-1.5 bg-muted rounded-full overflow-hidden">
                            <div className="h-full bg-success" style={{ width: `${Math.min(100, hr * 100)}%` }} />
                          </div>
                          <span className="text-xs w-10 text-right">{(hr * 100).toFixed(0)}%</span>
                        </div>
                      </td>
                      <td className="p-2 text-right text-muted-foreground">{stat.credits.toFixed(4)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          ) : (
            <div className="flex items-center justify-center h-32 text-muted-foreground">
              {isEn ? 'No statistics yet. Stats accumulate as requests are proxied.' : '暂无统计数据，反代请求后开始累计'}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
