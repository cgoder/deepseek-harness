/** Shell chrome and General-nav dictionaries; feature rows own their copy. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'trigger': '设置',
  'title': '设置',
  'close': '关闭',
  'openDocument': '打开配置文件',
  'openDocument.error': '无法打开配置文件',
  'general.nav': '通用设置',
  'usage.nav': '使用统计',
  'usage.title': 'Token 使用统计',
  'usage.description': '基于本地会话日志聚合的 token 与消息用量。',
  'usage.loading': '加载中…',
  'usage.refresh': '刷新',
  'usage.empty': '暂无数据',
  'usage.tokens': 'Tokens',
  'usage.sessions': '会话数',
  'usage.messages': '消息数',
  'usage.activeDays': '活跃天数',
  'usage.streak': '连续天数',
  'usage.topModel': 'Top 模型',
  'usage.modelBreakdown': '模型用量',
  'usage.trend': '每日 Token 趋势',
  'usage.heatmap': '消息热力图',
} satisfies Record<string, string>

/** The settings namespace key union. */
export type SettingsKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'trigger': 'Settings',
  'title': 'Settings',
  'close': 'Close',
  'openDocument': 'Open configuration file',
  'openDocument.error': 'Could not open configuration file',
  'general.nav': 'General',
  'usage.nav': 'Usage',
  'usage.title': 'Token Usage',
  'usage.description': 'Token and message usage aggregated from local session logs.',
  'usage.loading': 'Loading…',
  'usage.refresh': 'Refresh',
  'usage.empty': 'No data yet',
  'usage.tokens': 'Tokens',
  'usage.sessions': 'Sessions',
  'usage.messages': 'Messages',
  'usage.activeDays': 'Active days',
  'usage.streak': 'Streak',
  'usage.topModel': 'Top model',
  'usage.modelBreakdown': 'Model usage',
  'usage.trend': 'Daily token trend',
  'usage.heatmap': 'Message heatmap',
} satisfies Record<SettingsKey, string>
