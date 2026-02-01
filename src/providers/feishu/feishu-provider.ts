import type { IncomingMessage, MessageProvider, OutgoingMessage, OutgoingTarget } from '../../types.js'
import { createFeishuClient, type FeishuClientInstance } from './feishu-client'
import {
  createFeishuEventClient,
  type FeishuEventClientInstance,
  type FeishuMessageEventData,
} from './feishu-event-server'

export interface FeishuProviderOptions {
  config: import('./feishu-config').FeishuConfig
  logger?: (msg: string, level?: 'debug' | 'info' | 'warn' | 'error') => void
}

export function createFeishuProvider(options: FeishuProviderOptions): MessageProvider {
  const { config, logger } = options
  const feishuClient: FeishuClientInstance = createFeishuClient(config, logger)
  const eventClient: FeishuEventClientInstance = createFeishuEventClient(config, logger)

  const log = (msg: string, level: 'debug' | 'info' | 'warn' | 'error' = 'info') => {
    if (logger) logger(`[FeishuProvider] ${msg}`, level)
  }

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
        if (now - ts >= messageDedupeTtlMs) {
          recentMessageIds.delete(id)
        }
      }
      while (recentMessageIds.size > messageDedupeMaxSize) {
        const oldestId = recentMessageIds.keys().next().value as string | undefined
        if (!oldestId) break
        recentMessageIds.delete(oldestId)
      }
    }

    return true
  }

  const providerId = 'feishu' as const

  function parseMessageContent(content: string): string {
    try {
      const parsed = JSON.parse(content)
      return parsed.text || ''
    } catch {
      return content
    }
  }

  function convertToIncomingMessage(feishuEvent: FeishuMessageEventData): IncomingMessage {
    const { message, sender } = feishuEvent
    const userId = sender?.sender_id?.open_id || sender?.sender_id?.user_id || ''
    const channelId = message.chat_id

    let text = parseMessageContent(message.content)
    const rawMentions: unknown = message.mentions
    const mentions = Array.isArray(rawMentions)
      ? rawMentions
        .map((mention) => {
          if (!mention || typeof mention !== 'object') return ''
          const mentionObj = mention as Record<string, unknown>
          const id = mentionObj.id
          if (!id || typeof id !== 'object') return ''
          const idObj = id as Record<string, unknown>
          return (idObj.open_id || idObj.user_id) as string
        })
        .filter((id) => typeof id === 'string' && id.length > 0)
      : undefined

    if (Array.isArray(rawMentions) && rawMentions.length > 0) {
      for (const mention of rawMentions) {
        const mentionObj = mention as Record<string, unknown>
        const key = typeof mentionObj?.key === 'string' ? mentionObj.key : ''
        if (key) {
          text = text.replace(key, '').trim()
        }
      }
    }

    const threadId = message.root_id || message.message_id

    return {
      providerId,
      messageId: message.message_id,
      channelId,
      threadId,
      userId,
      userName: sender?.sender_type,
      text,
      mentions,
      raw: feishuEvent,
    }
  }

  let messageHandler: ((
    msg: IncomingMessage,
    extra?: {
      isCardAction: boolean
      cardActionData?: { action: 'approve' | 'reject'; requestId: string }
      questionResponse?: { questionId: string; answerLabel: string; questionIndex?: number }
      questionNav?: { questionId: string; questionIndex?: number; direction: 'next' | 'prev' }
      permissionResponse?: { requestId: string; reply: 'once' | 'always' | 'reject' }
    },
  ) => void | Promise<void>) | null = null

  eventClient.onMessage(async (feishuEvent) => {
    if (!messageHandler) return

    const channelId = feishuEvent.message.chat_id
    if (!feishuClient.isChatAllowed(channelId)) {
      log(`Ignoring message from disallowed chat ${channelId}`, 'debug')
      return
    }

    const messageId = feishuEvent.message.message_id
    if (!shouldHandleMessage(messageId)) {
      log(`Duplicate message ignored: ${messageId}`, 'debug')
      return
    }

    const incomingMessage = convertToIncomingMessage(feishuEvent)

    void Promise.resolve(messageHandler(incomingMessage)).catch((error) => {
      log(`Message handler failed: ${error}`, 'error')
    })
  })

  eventClient.onCardAction(async (cardAction) => {
    if (!messageHandler) return

    const incomingMessage: IncomingMessage = {
      providerId,
      messageId: cardAction.messageId,
      channelId: cardAction.channelId,
      threadId: cardAction.threadId,
      userId: cardAction.userId,
      userName: cardAction.userName,
      text: '',
      mentions: [],
      raw: undefined,
    }

    if (cardAction.action === 'question') {
      if (!cardAction.questionId || !cardAction.answerLabel) {
        log(`Question card action missing data: ${JSON.stringify(cardAction)}`, 'warn')
        return
      }
      void Promise.resolve(messageHandler(incomingMessage, {
        isCardAction: true,
        questionResponse: {
          questionId: cardAction.questionId,
          answerLabel: cardAction.answerLabel,
          questionIndex: cardAction.questionIndex,
        },
      })).catch((error) => {
        log(`Card action handler failed: ${error}`, 'error')
      })
      return
    }

    if (cardAction.action === 'question-nav') {
      if (!cardAction.questionId || !cardAction.direction) {
        log(`Question nav action missing data: ${JSON.stringify(cardAction)}`, 'warn')
        return
      }
      void Promise.resolve(messageHandler(incomingMessage, {
        isCardAction: true,
        questionNav: {
          questionId: cardAction.questionId,
          questionIndex: cardAction.questionIndex,
          direction: cardAction.direction,
        },
      })).catch((error) => {
        log(`Card action handler failed: ${error}`, 'error')
      })
      return
    }

    if (cardAction.action === 'permission') {
      if (!cardAction.requestId || !cardAction.reply) {
        log(`Permission action missing data: ${JSON.stringify(cardAction)}`, 'warn')
        return
      }
      void Promise.resolve(messageHandler(incomingMessage, {
        isCardAction: true,
        permissionResponse: {
          requestId: cardAction.requestId,
          reply: cardAction.reply,
        },
      })).catch((error) => {
        log(`Card action handler failed: ${error}`, 'error')
      })
      return
    }

    void Promise.resolve(messageHandler(incomingMessage, {
      isCardAction: true,
      cardActionData: {
        action: cardAction.action,
        requestId: cardAction.requestId || '',
      },
    })).catch((error) => {
      log(`Card action handler failed: ${error}`, 'error')
    })
  })

  async function start(): Promise<void> {
    log('Starting Feishu provider...', 'info')
    eventClient.start()
  }

  async function stop(): Promise<void> {
    log('Stopping Feishu provider...', 'info')
    eventClient.stop()
  }

  function onMessage(handler: (
    msg: IncomingMessage,
    extra?: {
      isCardAction: boolean
      cardActionData?: { action: 'approve' | 'reject'; requestId: string }
      questionResponse?: { questionId: string; answerLabel: string; questionIndex?: number }
    },
  ) => void | Promise<void>): void {
    messageHandler = handler
  }

  async function sendMessage(target: OutgoingTarget, message: OutgoingMessage): Promise<{ messageId: string }> {
    const messageId = await feishuClient.sendRichTextMessageWithId(target.channelId, message.text)
    if (!messageId) {
      throw new Error(`Failed to send message to ${target.channelId}`)
    }
    return { messageId }
  }

  async function replyMessage(
    message: IncomingMessage,
    messageOut: OutgoingMessage,
  ): Promise<{ messageId: string }> {
    const preferThread = Boolean(message.threadId)
    let messageId = await feishuClient.replyRichTextMessageWithId(message.messageId, messageOut.text, {
      replyInThread: preferThread,
    })
    if (!messageId && preferThread) {
      messageId = await feishuClient.replyRichTextMessageWithId(message.messageId, messageOut.text)
    }
    if (!messageId) {
      throw new Error(`Failed to reply to message ${message.messageId}`)
    }
    return { messageId }
  }

  async function addReaction(messageId: string, emoji: string): Promise<boolean> {
    return await feishuClient.addReaction(messageId, emoji)
  }

  async function updateMessage(messageId: string, messageOut: OutgoingMessage): Promise<boolean> {
    const ok = await feishuClient.updateRichTextMessage(messageId, messageOut.text)
    if (!ok) {
      log(`Failed to update message ${messageId}`, 'warn')
    }
    return ok
  }

  return {
    id: providerId,
    start,
    stop,
    onMessage,
    sendMessage,
    replyMessage,
    updateMessage,
    addReaction,
    getFeishuClient() {
      return feishuClient
    },
  }
}
