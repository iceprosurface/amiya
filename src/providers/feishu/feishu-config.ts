export interface FeishuConfig {
  appId: string
  appSecret: string
  useLark?: boolean
  allowedChatIds?: string[]
  botUserId?: string
  adminChatId?: string
  adminUserIds?: string[]
  requireUserWhitelist?: boolean
  debug?: boolean
  model?: string
  useCardMessages?: boolean
  streaming?: StreamingConfig
  toolOutputFileThreshold?: number
}

export interface StreamingConfig {
  enabled?: boolean
  mode?: 'update' | 'append'
  throttleMs?: number
  maxMessageChars?: number
  timeoutGraceMs?: number
}

export function validateConfig(config: unknown): config is FeishuConfig {
  if (!config || typeof config !== 'object') {
    return false
  }
  const c = config as Record<string, unknown>
  if (typeof c.appId !== 'string' || typeof c.appSecret !== 'string') return false
  if (c.appId.length === 0 || c.appSecret.length === 0) return false
  if (typeof c.model !== 'undefined' && typeof c.model !== 'string') return false
  if (typeof c.useCardMessages !== 'undefined' && typeof c.useCardMessages !== 'boolean') return false
  if (typeof c.toolOutputFileThreshold !== 'undefined' && typeof c.toolOutputFileThreshold !== 'number') {
    return false
  }
  if (typeof c.streaming !== 'undefined') {
    if (!c.streaming || typeof c.streaming !== 'object') return false
    const s = c.streaming as Record<string, unknown>
    if (typeof s.enabled !== 'undefined' && typeof s.enabled !== 'boolean') return false
    if (typeof s.mode !== 'undefined' && s.mode !== 'update' && s.mode !== 'append') return false
    if (typeof s.throttleMs !== 'undefined' && typeof s.throttleMs !== 'number') return false
    if (typeof s.maxMessageChars !== 'undefined' && typeof s.maxMessageChars !== 'number') return false
    if (typeof s.timeoutGraceMs !== 'undefined' && typeof s.timeoutGraceMs !== 'number') return false
  }
  return true
}
