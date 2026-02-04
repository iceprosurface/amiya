import * as lark from '@larksuiteoapi/node-sdk'

import { feishuPostToJson, markdownToFeishuPost } from './feishu-markdown.js'

import { logger } from './logger.js'

type MessageEventData = Parameters<NonNullable<lark.EventHandles['im.message.receive_v1']>>[0]

export interface FeishuConfig {
  appId: string
  appSecret: string
  useLark?: boolean
  botUserId?: string
  debug?: boolean
}

export interface FeishuMessage {
  messageId: string
  chatId: string
  senderId: string
  senderName: string
  text: string
  timestamp: string
  mentions: string[]
  raw: MessageEventData
}

export interface FeishuClient {
  start(): void
  stop(): void
  onMessage(handler: (message: FeishuMessage) => void | Promise<void>): void
  sendMessage(chatId: string, text: string): Promise<void>
  getBotUserId(): Promise<string | null>
}

function parseMessagePayload(content: string): { text: string; mentions: string[] } {
  const fallback = { text: content, mentions: [] as string[] }
  try {
    const parsed = JSON.parse(content)
    if (parsed && typeof parsed === 'object') {
      const mentionsRaw = (parsed as Record<string, unknown>).mentions
      const mentions = Array.isArray(mentionsRaw)
        ? mentionsRaw
            .map((mention) => {
              if (!mention || typeof mention !== 'object') return null
              const record = mention as Record<string, unknown>
              const id = record.id
              if (typeof id === 'string') return id
              if (id && typeof id === 'object') {
                const idRecord = id as Record<string, unknown>
                if (typeof idRecord.open_id === 'string') return idRecord.open_id
                if (typeof idRecord.user_id === 'string') return idRecord.user_id
              }
              return null
            })
            .filter((value): value is string => Boolean(value))
        : []

      const text = (parsed as Record<string, unknown>).text
      if (typeof text === 'string') {
        return { text, mentions }
      }
      return { text: content, mentions }
    }
  } catch {
    // fall through
  }
  return fallback
}

function extractMentionsFromEvent(data: MessageEventData): string[] {
  const rawMentions = data.message?.mentions
  if (!Array.isArray(rawMentions)) return []
  return rawMentions
    .map((mention) => {
      if (!mention || typeof mention !== 'object') return null
      const record = mention as Record<string, unknown>
      const id = record.id
      if (typeof id === 'string') return id
      if (id && typeof id === 'object') {
        const idRecord = id as Record<string, unknown>
        if (typeof idRecord.open_id === 'string') return idRecord.open_id
        if (typeof idRecord.user_id === 'string') return idRecord.user_id
      }
      return null
    })
    .filter((value): value is string => Boolean(value))
}

export function createFeishuClient(config: FeishuConfig): FeishuClient {
  const client = new lark.Client({
    appId: config.appId,
    appSecret: config.appSecret,
    domain: config.useLark ? lark.Domain.Lark : lark.Domain.Feishu,
    loggerLevel: config.debug ? lark.LoggerLevel.debug : lark.LoggerLevel.info,
  })

  const messageHandlers: Array<
    (message: FeishuMessage) => void | Promise<void>
  > = []
  let wsClient: lark.WSClient | null = null

  const recentMessageIds = new Map<string, number>()
  const messageDedupeTtlMs = 10 * 60 * 1000
  const messageDedupeMaxSize = 1000

  function shouldHandleMessage(messageId: string): boolean {
    if (!messageId) return true
    const now = Date.now()
    const seenAt = recentMessageIds.get(messageId)
    if (seenAt && now - seenAt < messageDedupeTtlMs) return false

    recentMessageIds.set(messageId, now)
    if (recentMessageIds.size > messageDedupeMaxSize) {
      for (const [id, ts] of recentMessageIds) {
        if (now - ts >= messageDedupeTtlMs) recentMessageIds.delete(id)
      }
      while (recentMessageIds.size > messageDedupeMaxSize) {
        const oldestId = recentMessageIds.keys().next().value as
          | string
          | undefined
        if (!oldestId) break
        recentMessageIds.delete(oldestId)
      }
    }

    return true
  }

  async function handleMessageEvent(data: MessageEventData): Promise<void> {
    const messageId = data.message?.message_id || ''
    if (!messageId || !shouldHandleMessage(messageId)) return

    const chatId = data.message?.chat_id || ''
    if (!chatId) return

    const senderId =
      data.sender?.sender_id?.open_id
      || data.sender?.sender_id?.user_id
      || ''
    const senderName =
      data.sender?.sender_type || senderId || 'unknown'

    const content = data.message?.content || ''
    const parsed = parseMessagePayload(content)
    const text = parsed.text
    const mentionIds = new Set<string>([
      ...parsed.mentions,
      ...extractMentionsFromEvent(data),
    ])

    const createTimeRaw = data.message?.create_time
    const createTimeMs = typeof createTimeRaw === 'string'
      ? Number.parseInt(createTimeRaw, 10)
      : typeof createTimeRaw === 'number'
        ? createTimeRaw
        : Date.now()
    const timestamp = new Date(createTimeMs).toISOString()

    const message: FeishuMessage = {
      messageId,
      chatId,
      senderId,
      senderName,
      text,
      timestamp,
      mentions: Array.from(mentionIds),
      raw: data,
    }

    for (const handler of messageHandlers) {
      await handler(message)
    }
  }

  const eventDispatcher = new lark.EventDispatcher({})
  eventDispatcher.register({
    'im.message.receive_v1': handleMessageEvent,
  })

  let cachedBotUserId: string | null = null

  async function getBotUserId(): Promise<string | null> {
    if (cachedBotUserId) return cachedBotUserId
    if (config.botUserId) {
      cachedBotUserId = config.botUserId
      return cachedBotUserId
    }

    try {
      const tokenResult = await client.auth.v3.tenantAccessToken.internal({
        data: {
          app_id: config.appId,
          app_secret: config.appSecret,
        },
      })

      const tokenRecord = tokenResult as Record<string, unknown>
      const tokenData = tokenRecord.data as Record<string, unknown> | undefined
      const tenantToken =
        (typeof tokenData?.tenant_access_token === 'string'
          ? tokenData.tenant_access_token
          : null)
        || (typeof tokenRecord.tenant_access_token === 'string'
          ? tokenRecord.tenant_access_token
          : null)

      if (!tenantToken) return null

      const botInfoResult = await client.request({
        method: 'GET',
        url: '/open-apis/bot/v3/info',
      }, lark.withTenantToken(tenantToken))

      const botInfoRecord = botInfoResult as Record<string, unknown>
      const botInfoData = botInfoRecord.data as Record<string, unknown> | undefined
      const bot = (botInfoData?.bot as Record<string, unknown> | undefined)
        ?? (botInfoRecord.bot as Record<string, unknown> | undefined)

      const openId = bot?.open_id ?? botInfoData?.open_id ?? botInfoRecord.open_id
      const userId = bot?.user_id ?? botInfoData?.user_id ?? botInfoRecord.user_id

      const resolved = typeof openId === 'string'
        ? openId
        : typeof userId === 'string'
          ? userId
          : null

      if (resolved) {
        cachedBotUserId = resolved
        return cachedBotUserId
      }
    } catch {
      return null
    }

    return null
  }

  return {
    onMessage(handler) {
      messageHandlers.push(handler)
    },
    start() {
      if (wsClient) return
      wsClient = new lark.WSClient({
        appId: config.appId,
        appSecret: config.appSecret,
        domain: config.useLark ? lark.Domain.Lark : lark.Domain.Feishu,
        loggerLevel: config.debug ? lark.LoggerLevel.debug : lark.LoggerLevel.info,
      })
      wsClient.start({ eventDispatcher })
      logger.info('Feishu WebSocket started')
    },
    stop() {
      const clientToStop = wsClient
      wsClient = null
      if (clientToStop) {
        const asAny = clientToStop as unknown as { stop?: () => void; close?: () => void }
        if (asAny.stop) {
          asAny.stop()
        } else if (asAny.close) {
          asAny.close()
        }
      }
      logger.info('Feishu WebSocket stopped')
    },
    async sendMessage(chatId: string, text: string): Promise<void> {
      const post = markdownToFeishuPost(text)
      const hasPostContent = post.content.length > 0 || Boolean(post.title)

      await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: hasPostContent
          ? {
              receive_id: chatId,
              msg_type: 'post',
              content: feishuPostToJson(post),
            }
          : {
              receive_id: chatId,
              msg_type: 'text',
              content: JSON.stringify({ text }),
            },
      })
    },
    async getBotUserId(): Promise<string | null> {
      return await getBotUserId()
    },
  }
}
