/**
 * usage domain zod schemas (names derived from map keys: usageStatsRequestSchema /
 * usageStatsValueSchema).
 */

import { z } from 'zod'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'
import type { UsageHeatmapDay, UsageModelStat, UsageTrendDay } from './usage.ts'

/** Maximum number of days the usage API will aggregate. */
export const USAGE_MAX_RANGE_DAYS = 366

/** usage.stats request payload. */
export const usageStatsRequestSchema = z.object({
  days: z.number().int().min(1).max(USAGE_MAX_RANGE_DAYS).optional(),
}) satisfies z.ZodType<Wire<RequestPayload<'usage.stats'>>>

/** One model's token share. */
export const usageModelStatSchema: z.ZodType<Wire<UsageModelStat>> = z.object({
  id: z.string(),
  tokens: z.number().int().nonnegative(),
  share: z.number().min(0).max(1),
})

/** One daily trend entry. */
export const usageTrendDaySchema: z.ZodType<Wire<UsageTrendDay>> = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  tokens: z.number().int().nonnegative(),
  models: z.record(z.string(), z.number().int().nonnegative()),
})

/** One heatmap day. */
export const usageHeatmapDaySchema: z.ZodType<Wire<UsageHeatmapDay>> = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  messages: z.number().int().nonnegative(),
})

/** usage.stats response value. */
export const usageStatsValueSchema: z.ZodType<Wire<ResponseValue<'usage.stats'>>> = z.object({
  generatedAt: z.number(),
  range: z.object({
    days: z.number().int().min(1).max(USAGE_MAX_RANGE_DAYS),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
  totals: z.object({
    tokens: z.number().int().nonnegative(),
    sessions: z.number().int().nonnegative(),
    messages: z.number().int().nonnegative(),
    activeDays: z.number().int().nonnegative(),
  }),
  streak: z.number().int().nonnegative(),
  topModel: usageModelStatSchema.nullable(),
  models: z.array(usageModelStatSchema),
  trend: z.array(usageTrendDaySchema),
  heatmap: z.array(usageHeatmapDaySchema),
}) satisfies z.ZodType<Wire<ResponseValue<'usage.stats'>>>
