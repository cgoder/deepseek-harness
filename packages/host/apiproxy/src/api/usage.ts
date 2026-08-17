/**
 * usage domain contract. The stats method aggregates durable session logs into
 * the token/message/activity figures shown by the Web usage page.
 */

import type { RpcRequest, RpcResponse } from './rpc.ts'

/** One model's token share within a range. */
export interface UsageModelStat {
  /** Provider-owned model id. */
  id: string
  /** Tokens attributed to this model in the selected range. */
  tokens: number
  /** Share of total range tokens, 0..1. */
  share: number
}

/** One day's token and message totals in a daily series. */
export interface UsageTrendDay {
  /** Local calendar date in YYYY-MM-DD form. */
  date: string
  /** Total provider-reported tokens attributed to that day. */
  tokens: number
  /** Tokens by model id for that day (top-N bucketing is client-side). */
  models: Record<string, number>
}

/** One day's message count in the fixed heatmap window. */
export interface UsageHeatmapDay {
  /** Local calendar date in YYYY-MM-DD form. */
  date: string
  /** Appended user/assistant message count for that day. */
  messages: number
}

/** Aggregated token usage statistics for the Web usage page. */
export interface UsageStats {
  /** Server time when the aggregate was produced. */
  generatedAt: number
  /** The requested/actual range. */
  range: { days: number; startDate: string }
  /** Range totals. */
  totals: {
    /** Sum of provider-reported token buckets (input + cache + output). */
    tokens: number
    /** Distinct sessions with activity in the range. */
    sessions: number
    /** Appended user/assistant messages in the range. */
    messages: number
    /** Days with at least one message in the range. */
    activeDays: number
  }
  /** Consecutive active days ending today (or yesterday when today is quiet). */
  streak: number
  /** Highest-token model in the range; null when there are no tokens. */
  topModel: UsageModelStat | null
  /** Model token totals, descending by tokens. */
  models: UsageModelStat[]
  /** Zero-filled daily token series from range start through today. */
  trend: UsageTrendDay[]
  /** Fixed 26-week message-count heatmap ending today. */
  heatmap: UsageHeatmapDay[]
}

/** Usage domain unary methods (the map key usage.stats). */
export interface UsageApi {
  /**
   * Returns aggregate token/message statistics over the requested number of
   * days (clamped to 1..366; default 30).
   */
  stats(
    request: RpcRequest<{ days?: number }>,
    signal?: AbortSignal,
  ): Promise<RpcResponse<UsageStats>>
}
