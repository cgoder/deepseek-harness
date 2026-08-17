/**
 * Usage settings section: token/message statistics aggregated from durable
 * session logs. The page mirrors the pi-web-ct usage panel with a lighter
 * implementation: totals, model shares, a daily token trend, and a message
 * heatmap.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { IApiClient, UsageStats } from '@deepseek-ai/dsh-api-remotes/client'
import type { en } from './locales.ts'
import styles from './UsageSection.module.css'

/** Injected dependencies of {@link UsageSection}. */
export interface UsageSectionInjected {
  /** Wire face for usage aggregation. */
  api: Pick<IApiClient, 'usage'>
  /** Section copy. */
  t: (key: keyof typeof en) => string
}

/** Props delivered by the slot outlet. */
export type UsageSectionProps = Partial<UsageSectionInjected>

const RANGE_DAYS = [7, 30] as const
const HEAT_LEVELS = 5
const TOP_SERIES = 5
const TREND_HEIGHT_PX = 120

/** Series ramp using existing design tokens so charts are visible in both themes. */
const SERIES_COLORS = [
  'var(--dsw-alias-brand-primary)',
  'var(--dsw-alias-state-business-primary)',
  'var(--dsw-alias-state-success-primary)',
  'var(--dsw-alias-state-warn-primary)',
  'var(--dsw-alias-state-error-primary)',
  'var(--dsw-alias-label-tertiary)',
]

/** Heatmap ramp from transparent to the brand color. */
const HEAT_COLORS = [
  'transparent',
  'color-mix(in oklab, var(--dsw-alias-brand-primary) 18%, var(--dsw-alias-bg-layer-2))',
  'color-mix(in oklab, var(--dsw-alias-brand-primary) 36%, var(--dsw-alias-bg-layer-2))',
  'color-mix(in oklab, var(--dsw-alias-brand-primary) 58%, var(--dsw-alias-bg-layer-2))',
  'var(--dsw-alias-brand-primary)',
]

function fmtTokens(n: number): string {
  if (n >= 1e8) return `${(n / 1e8).toFixed(1)}亿`
  if (n >= 1e4) return `${(n / 1e4).toFixed(1)}万`
  return String(n)
}

function fmtNumber(n: number): string {
  return n.toLocaleString()
}

function heatLevel(messages: number, max: number): number {
  if (messages <= 0) return 0
  return Math.min(HEAT_LEVELS - 1, Math.ceil((messages / Math.max(1, max)) * (HEAT_LEVELS - 1)))
}

/**
 * Render the Usage section.
 * @param props - slot-delivered injected dependencies.
 * @returns the section, or null while the shell has not injected yet.
 */
export function UsageSection(props: UsageSectionProps): ReactNode {
  const { api, t } = props
  const [days, setDays] = useState<7 | 30>(30)
  const [data, setData] = useState<UsageStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (range: 7 | 30) => {
    if (api === undefined) return
    setLoading(true)
    setError(null)
    try {
      const response = await api.usage.stats({ days: range })
      if (!response.result.ok) throw new Error(response.result.error.message)
      setData(response.result.value)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [api])

  useEffect(() => {
    void load(days)
  }, [days, load])

  const series = useMemo(() => {
    if (data === undefined || data === null) return [] as string[]
    const ids = data.models.slice(0, TOP_SERIES).map(model => model.id)
    if (data.models.length > TOP_SERIES) ids.push('__other__')
    return ids
  }, [data])

  const trendMax = useMemo(() => Math.max(1, ...(data?.trend.map(day => day.tokens) ?? [1])), [data])
  const heatMax = useMemo(() => Math.max(1, ...(data?.heatmap.map(day => day.messages) ?? [1])), [data])

  if (api === undefined || t === undefined) return null

  return (
    <div className={styles.section}>
      <div className={styles.header}>
        <div>
          <h2 className={styles.title}>{t('usage.title')}</h2>
          <p className={styles.intro}>{t('usage.description')}</p>
        </div>
        <div className={styles.actions}>
          <div className={styles.segmented}>
            {RANGE_DAYS.map(option => (
              <button
                key={option}
                type="button"
                className={option === days ? styles.segmentActive : styles.segment}
                onClick={() => { setDays(option) }}
              >
                {option}D
              </button>
            ))}
          </div>
          <button type="button" className={styles.refresh} onClick={() => { void load(days) }}>
            {t('usage.refresh')}
          </button>
        </div>
      </div>

      {error !== null && <p className={styles.error}>{error}</p>}
      {loading && data === null && <p className={styles.notice}>{t('usage.loading')}</p>}
      {!loading && data === null && !error && <p className={styles.notice}>{t('usage.empty')}</p>}

      {data !== null && (
        <>
          <div className={styles.cards}>
            <div className={styles.card}><span className={styles.cardLabel}>{t('usage.tokens')}</span><span className={styles.cardValue}>{fmtTokens(data.totals.tokens)}</span></div>
            <div className={styles.card}><span className={styles.cardLabel}>{t('usage.sessions')}</span><span className={styles.cardValue}>{fmtNumber(data.totals.sessions)}</span></div>
            <div className={styles.card}><span className={styles.cardLabel}>{t('usage.messages')}</span><span className={styles.cardValue}>{fmtNumber(data.totals.messages)}</span></div>
            <div className={styles.card}><span className={styles.cardLabel}>{t('usage.activeDays')}</span><span className={styles.cardValue}>{fmtNumber(data.totals.activeDays)}</span></div>
            <div className={styles.card}><span className={styles.cardLabel}>{t('usage.streak')}</span><span className={styles.cardValue}>{fmtNumber(data.streak)}</span></div>
            <div className={styles.card}><span className={styles.cardLabel}>{t('usage.topModel')}</span><span className={styles.cardValue}>{data.topModel?.id ?? '—'}</span></div>
          </div>

          <div className={styles.panel}>
            <h3 className={styles.panelTitle}>{t('usage.modelBreakdown')}</h3>
            <div className={styles.modelList}>
              {data.models.length === 0 && <span className={styles.muted}>{t('usage.empty')}</span>}
              {data.models.map(model => (
                <div key={model.id} className={styles.modelRow}>
                  <span className={styles.modelName}>{model.id}</span>
                  <span className={styles.modelTokens}>{fmtTokens(model.tokens)}</span>
                  <span className={styles.modelShare}>{Math.round(model.share * 100)}%</span>
                </div>
              ))}
            </div>
          </div>

          <div className={styles.panel}>
            <h3 className={styles.panelTitle}>{t('usage.trend')}</h3>
            <div className={styles.trend} style={{ height: TREND_HEIGHT_PX }}>
              {data.trend.map((day) => {
                const topIds = new Set(series.filter(id => id !== '__other__'))
                const daySeries = series.length === 0 ? [] : series.map(id => id === '__other__'
                  ? Object.entries(day.models)
                    .filter(([model]) => !topIds.has(model))
                    .reduce((sum, [, value]) => sum + value, 0)
                  : day.models[id] ?? 0)
                const total = day.tokens
                return (
                  <div key={day.date} className={styles.trendColumn} title={`${day.date}: ${fmtTokens(total)}`}>
                    {total > 0 && daySeries.map((value, index) => value > 0 ? (
                      <div
                        key={series[index] ?? index}
                        className={styles.trendSegment}
                        style={{
                          height: `${Math.max(2, (value / trendMax) * TREND_HEIGHT_PX)}px`,
                          background: SERIES_COLORS[index % SERIES_COLORS.length],
                        }}
                      />
                    ) : null)}
                  </div>
                )
              })}
            </div>
          </div>

          <div className={styles.panel}>
            <h3 className={styles.panelTitle}>{t('usage.heatmap')}</h3>
            <div className={styles.heatmap}>
              {data.heatmap.map(day => (
                <div
                  key={day.date}
                  className={styles.heatCell}
                  style={{ background: HEAT_COLORS[heatLevel(day.messages, heatMax)] }}
                  title={`${day.date}: ${day.messages}`}
                />
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
