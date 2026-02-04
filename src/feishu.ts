import * as lark from '@larksuiteoapi/node-sdk'

import { logger } from './logger.js'

type MessageEventData = Parameters<NonNullable<lark.EventHandles['im.message.receive_v1']>>[0]

export interface FeishuConfig {
  appId: string
  appSecret: string
  useLark?: boolean
  allowedChatIds?: string[]
  debug?: boolean
}

export interface FeishuMessage {
  messageId: string
  chatId: string
  senderId: string
  senderName: string
  text: string
  timestamp: string
  raw: MessageEventData
}

export interface FeishuClient {
  start(): void
  stop(): void
  onMessage(handler: (message: FeishuMessage) => void | Promise<void>): void
  sendMessage(chatId: string, text: string): Promise<void>
}

function parseMessageContent(content: string): string {
  try {
    const parsed = JSON.parse(content)
    if (parsed && typeof parsed === 'object') {
      const text = (parsed as Record<string, unknown>).text
      if (typeof text === 'string') return text
    }
  } catch {
    // fall through
  }
  return content
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

  function isChatAllowed(chatId: string): boolean {
    if (!config.allowedChatIds || config.allowedChatIds.length === 0) return true
    return config.allowedChatIds.includes(chatId)
  }

  async function handleMessageEvent(data: MessageEventData): Promise<void> {
    const messageId = data.message?.message_id || ''
    if (!messageId || !shouldHandleMessage(messageId)) return

    const chatId = data.message?.chat_id || ''
    if (!chatId || !isChatAllowed(chatId)) return

    const senderId =
      data.sender?.sender_id?.open_id
      || data.sender?.sender_id?.user_id
      || ''
    const senderName =
      data.sender?.sender_type || senderId || 'unknown'

    const content = data.message?.content || ''
    const text = parseMessageContent(content)

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
      await client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      })
    },
  }
}
