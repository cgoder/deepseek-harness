/**
 * Pure usage-stat aggregation over durable session event logs.
 *
 * The Web usage page mirrors the pi-web-ct statistics panel: daily token
 * totals, model shares, message activity, and a 26-week heatmap. This module
 * keeps the aggregation host-side and free of wire schemas so the API proxy
 * can call it from the implementation.
 */

import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { UsageStats } from './api/usage.ts'

/** One session's event log for aggregation. */
export interface UsageSessionSource {
  readonly id: SessionId
  readonly events: readonly SessionEvent[]
}

/** Disjoint provider token buckets. */
interface TokenBuckets {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/** Per-day aggregate. */
interface DayAggregate {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  messages: number
  models: Map<string, number>
  sessionIds: Set<SessionId>
}

/** One step's latest usage sample (chunk usage is replaced by assistant/message usage). */
interface StepUsageSample {
  usage: TokenUsage
  model: string
  date: string
}

function bucketsOf(usage: TokenUsage): TokenBuckets {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
  }
}

function totalTokens(buckets: TokenBuckets): number {
  return buckets.inputTokens + buckets.outputTokens + buckets.cacheReadTokens + buckets.cacheWriteTokens
}

function addBuckets(target: TokenBuckets, buckets: TokenBuckets): void {
  target.inputTokens += buckets.inputTokens
  target.outputTokens += buckets.outputTokens
  target.cacheReadTokens += buckets.cacheReadTokens
  target.cacheWriteTokens += buckets.cacheWriteTokens
}

function subtractBuckets(target: TokenBuckets, buckets: TokenBuckets): void {
  target.inputTokens -= buckets.inputTokens
  target.outputTokens -= buckets.outputTokens
  target.cacheReadTokens -= buckets.cacheReadTokens
  target.cacheWriteTokens -= buckets.cacheWriteTokens
}

/** Local calendar date key in YYYY-MM-DD form. */
export function usageDateKey(time: number): string {
  const date = new Date(time)
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

function startOfToday(): Date {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate())
}

/** Enumerate local dates from start through end inclusive. */
function enumerateDates(start: Date, end: Date): string[] {
  const dates: string[] = []
  for (let cursor = new Date(start); cursor <= end; cursor = addDays(cursor, 1)) {
    dates.push(usageDateKey(cursor.getTime()))
  }
  return dates
}

function dayOf(map: Map<string, DayAggregate>, date: string): DayAggregate {
  let day = map.get(date)
  if (day === undefined) {
    day = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      messages: 0,
      models: new Map<string, number>(),
      sessionIds: new Set<SessionId>(),
    }
    map.set(date, day)
  }
  return day
}

function addTokenSample(
  days: Map<string, DayAggregate>,
  date: string,
  model: string,
  usage: TokenUsage,
  sessionId: SessionId,
): void {
  const day = dayOf(days, date)
  const buckets = bucketsOf(usage)
  addBuckets(day, buckets)
  day.models.set(model, (day.models.get(model) ?? 0) + totalTokens(buckets))
  day.sessionIds.add(sessionId)
}

function removeTokenSample(
  days: Map<string, DayAggregate>,
  date: string,
  model: string,
  usage: TokenUsage,
): void {
  const day = days.get(date)
  if (day === undefined) return
  const buckets = bucketsOf(usage)
  subtractBuckets(day, buckets)
  const updated = Math.max(0, (day.models.get(model) ?? 0) - totalTokens(buckets))
  if (updated === 0) day.models.delete(model)
  else day.models.set(model, updated)
}

function addMessage(days: Map<string, DayAggregate>, date: string, sessionId: SessionId): void {
  const day = dayOf(days, date)
  day.messages += 1
  day.sessionIds.add(sessionId)
}

function modelOfEvent(event: SessionEvent, fallback: string | undefined): string {
  if (event.type === 'assistant/message') return event.data.message.source.model
  return fallback ?? 'unknown'
}

function stepKey(turn: number, step: number): string {
  return `${turn}:${step}`
}

/**
 * Compute aggregate usage statistics from one or more session logs.
 * @param sessions - the session event sources to aggregate.
 * @param days - requested range length (clamped by the API schema).
 * @returns the usage stats payload.
 */
export function computeUsageStats(
  sessions: readonly UsageSessionSource[],
  days: number,
): UsageStats {
  const daysMap = new Map<string, DayAggregate>()
  const today = startOfToday()
  const rangeStart = addDays(today, -(days - 1))

  for (const session of sessions) {
    const steps = new Map<string, StepUsageSample>()
    let fallbackModel: string | undefined

    for (const event of session.events) {
      const date = usageDateKey(event.time)

      if (event.type === 'request/header') {
        fallbackModel = event.data.header.config.model
      } else if (event.type === 'request/context') {
        fallbackModel = event.data.model
      } else if (event.type === 'assistant/chunk' && event.data.chunk.type === 'usage') {
        const key = stepKey(event.data.turn, event.data.step)
        const previous = steps.get(key)
        if (previous !== undefined) {
          removeTokenSample(daysMap, previous.date, previous.model, previous.usage)
        }
        const model = previous?.model ?? fallbackModel ?? 'unknown'
        const sample: StepUsageSample = { usage: event.data.chunk.usage, model, date }
        steps.set(key, sample)
        addTokenSample(daysMap, date, model, sample.usage, session.id)
      } else if (event.type === 'assistant/message') {
        if (event.surfaceOp === 'append') addMessage(daysMap, date, session.id)
        if (event.data.usage !== undefined) {
          const key = stepKey(event.data.turn, event.data.step)
          const previous = steps.get(key)
          if (previous !== undefined) {
            removeTokenSample(daysMap, previous.date, previous.model, previous.usage)
          }
          const model = modelOfEvent(event, fallbackModel)
          const sample: StepUsageSample = { usage: event.data.usage, model, date }
          steps.set(key, sample)
          addTokenSample(daysMap, date, model, sample.usage, session.id)
        }
      } else if (event.type === 'user/message' && event.surfaceOp === 'append') {
        addMessage(daysMap, date, session.id)
      }
    }
  }

  const rangeStartKey = usageDateKey(rangeStart.getTime())
  const todayKey = usageDateKey(today.getTime())

  let tokens = 0
  let messages = 0
  let activeDays = 0
  const sessionsInRange = new Set<SessionId>()
  const modelsInRange = new Map<string, number>()

  for (const [date, day] of daysMap) {
    if (date < rangeStartKey || date > todayKey) continue
    tokens += totalTokens(day)
    messages += day.messages
    if (day.messages > 0) activeDays += 1
    for (const id of day.sessionIds) sessionsInRange.add(id)
    for (const [model, value] of day.models) {
      modelsInRange.set(model, (modelsInRange.get(model) ?? 0) + value)
    }
  }

  const models = [...modelsInRange.entries()]
    .map(([id, value]) => ({ id, tokens: value, share: tokens > 0 ? value / tokens : 0 }))
    .sort((a, b) => b.tokens - a.tokens || a.id.localeCompare(b.id))
  const topModel = models[0] ?? null

  const trend = enumerateDates(rangeStart, today).map((date) => {
    const day = daysMap.get(date)
    return {
      date,
      tokens: day === undefined ? 0 : totalTokens(day),
      models: day === undefined ? {} : Object.fromEntries(day.models),
    }
  })

  const heatmapStart = addDays(today, -(26 * 7 - 1))
  const heatmap = enumerateDates(heatmapStart, today).map(date => ({
    date,
    messages: daysMap.get(date)?.messages ?? 0,
  }))

  // Streak: count consecutive active days ending today; if today is quiet,
  // allow a streak that ended yesterday (the pi-web-ct convention).
  const activeDates = new Set(
    [...daysMap.entries()].filter(([, day]) => day.messages > 0).map(([date]) => date),
  )
  let streak = 0
  let cursor = activeDates.has(todayKey) ? today : activeDates.has(usageDateKey(addDays(today, -1).getTime()))
    ? addDays(today, -1)
    : undefined
  while (cursor !== undefined && activeDates.has(usageDateKey(cursor.getTime()))) {
    streak += 1
    cursor = addDays(cursor, -1)
  }

  return {
    generatedAt: Date.now(),
    range: { days, startDate: rangeStartKey },
    totals: {
      tokens,
      sessions: sessionsInRange.size,
      messages,
      activeDays,
    },
    streak,
    topModel,
    models,
    trend,
    heatmap,
  }
}
