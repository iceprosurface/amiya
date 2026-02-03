import type { IncomingMessage, MessageProvider, OutgoingMessage, OutgoingTarget } from '../../types.js'
import { createFeishuClient, type FeishuClientInstance } from './feishu-client'
import {
  createFeishuEventClient,
  type FeishuEventClientInstance,
  type FeishuMessageEventData,
} from './feishu-event-server'
import {
  assistantCardStates,
  buildAssistantCardText,
  splitAssistantDetails,
  splitFooterLines,
} from './assistant-card-state'

export interface FeishuProviderOptions {
  config: import('./feishu-config').FeishuConfig
  logger?: (msg: string, level?: 'debug' | 'info' | 'warn' | 'error') => void
}

export function createFeishuProvider(options: FeishuProviderOptions): MessageProvider {
  const { config, logger } = options
  const feishuClient: FeishuClientInstance = createFeishuClient(config, logger)
  const eventClient: FeishuEventClientInstance = createFeishuEventClient(config, logger)
  const useCardMessages = config.useCardMessages !== false

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
      workspaceAction?: { action: 'bind' | 'join-approve' | 'join-reject'; workspaceName?: string; requestId?: string }
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

    if (cardAction.action === 'assistant-toggle') {
      const section = cardAction.section
      const expanded = cardAction.expanded
      if (!section || typeof expanded !== 'boolean') {
        log(`Assistant toggle missing data: ${JSON.stringify(cardAction)}`, 'warn')
        return
      }
      const state = assistantCardStates.get(cardAction.messageId)
      if (!state) {
        log(`Assistant toggle ignored: missing state for ${cardAction.messageId}`, 'warn')
        return
      }
      if (section === 'details') {
        state.showDetails = expanded
      } else if (section === 'meta') {
        state.showMeta = expanded
      }
      const nextSequence = Math.max(1, state.sequence)
      const ok = await feishuClient.updateAssistantCardEntityWithId?.(state.cardId, {
        sequence: nextSequence,
        text: state.main,
        details: state.details,
        meta: state.meta,
        showDetails: state.showDetails,
        showMeta: state.showMeta,
      })
      if (!ok) {
        log(`Assistant toggle update failed messageId=${cardAction.messageId}`, 'warn')
        return
      }
      state.sequence = nextSequence + 1
      assistantCardStates.set(cardAction.messageId, state)
      return
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

    if (cardAction.action === 'workspace-bind') {
      if (!cardAction.workspaceName) {
        log(`Workspace bind action missing name: ${JSON.stringify(cardAction)}`, 'warn')
        return
      }
      void Promise.resolve(messageHandler(incomingMessage, {
        isCardAction: true,
        workspaceAction: {
          action: 'bind',
          workspaceName: cardAction.workspaceName,
        },
      })).catch((error) => {
        log(`Card action handler failed: ${error}`, 'error')
      })
      return
    }

    if (cardAction.action === 'workspace-join-approve' || cardAction.action === 'workspace-join-reject') {
      if (!cardAction.requestId) {
        log(`Workspace join action missing requestId: ${JSON.stringify(cardAction)}`, 'warn')
        return
      }
      void Promise.resolve(messageHandler(incomingMessage, {
        isCardAction: true,
        workspaceAction: {
          action: cardAction.action === 'workspace-join-approve' ? 'join-approve' : 'join-reject',
          requestId: cardAction.requestId,
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
      questionNav?: { questionId: string; questionIndex?: number; direction: 'next' | 'prev' }
      permissionResponse?: { requestId: string; reply: 'once' | 'always' | 'reject' }
      workspaceAction?: { action: 'bind' | 'join-approve' | 'join-reject'; workspaceName?: string; requestId?: string }
    },
  ) => void | Promise<void>): void {
    messageHandler = handler
  }

  async function sendMessage(
    target: OutgoingTarget,
    message: OutgoingMessage,
  ): Promise<{ messageId: string; cardId?: string; elementId?: string }> {
    const messageId = useCardMessages
      ? await feishuClient.sendAssistantCardMessageWithId?.(target.channelId, {
          text: message.text,
          streaming: message.mode === 'streaming',
          status: message.status,
          messageParts: message.messageParts,
        })
      : await feishuClient.sendRichTextMessageWithId(target.channelId, message.text)
    if (!messageId) {
      throw new Error(`Failed to send message to ${target.channelId}`)
    }
    if (typeof messageId === 'string') {
      return { messageId }
    }
    if (messageId.cardId && messageId.elementId) {
      const { body, footer } = splitFooterLines(message.text)
      const { main, details } = splitAssistantDetails(body)
      assistantCardStates.set(messageId.messageId, {
        cardId: messageId.cardId,
        elementId: messageId.elementId,
        main,
        details,
        meta: footer,
        showDetails: false,
        showMeta: false,
        sequence: 1,
      })
    }
    return messageId
  }

  async function replyMessage(
    message: IncomingMessage,
    messageOut: OutgoingMessage,
  ): Promise<{ messageId: string; cardId?: string; elementId?: string }> {
    const preferThread = Boolean(message.threadId)
    let messageId = useCardMessages
      ? await feishuClient.replyAssistantCardMessageWithId?.(message.messageId, {
          text: messageOut.text,
          streaming: messageOut.mode === 'streaming',
          status: messageOut.status,
          messageParts: messageOut.messageParts,
        }, {
          replyInThread: preferThread,
        })
      : await feishuClient.replyRichTextMessageWithId(message.messageId, messageOut.text, {
          replyInThread: preferThread,
        })
    if (!messageId && preferThread) {
      messageId = useCardMessages
        ? await feishuClient.replyAssistantCardMessageWithId?.(message.messageId, {
            text: messageOut.text,
            streaming: messageOut.mode === 'streaming',
            status: messageOut.status,
            messageParts: messageOut.messageParts,
          })
        : await feishuClient.replyRichTextMessageWithId(message.messageId, messageOut.text)
    }
    if (!messageId) {
      throw new Error(`Failed to reply to message ${message.messageId}`)
    }
    if (typeof messageId === 'string') {
      return { messageId }
    }
    if (messageId.cardId && messageId.elementId) {
      const { body, footer } = splitFooterLines(messageOut.text)
      const { main, details } = splitAssistantDetails(body)
      assistantCardStates.set(messageId.messageId, {
        cardId: messageId.cardId,
        elementId: messageId.elementId,
        main,
        details,
        meta: footer,
        showDetails: false,
        showMeta: false,
        sequence: 1,
      })
    }
    return messageId
  }

  async function addReaction(messageId: string, emoji: string): Promise<boolean> {
    return await feishuClient.addReaction(messageId, emoji)
  }

  async function updateMessage(messageId: string, messageOut: OutgoingMessage): Promise<boolean> {
    let ok = false
    if (useCardMessages && messageOut.messageParts && messageOut.messageParts.length > 0) {
      ok = await feishuClient.updateAssistantCardMessageWithId?.(messageId, {
        text: messageOut.text,
        streaming: messageOut.mode === 'streaming',
        status: messageOut.status,
        messageParts: messageOut.messageParts,
      }) ?? false
    } else if (useCardMessages && messageOut.cardId && messageOut.elementId) {
      ok = await feishuClient.updateAssistantCardElementContentWithId?.(
        messageOut.cardId,
        messageOut.elementId,
        messageOut.text,
      ) ?? false
    } else if (useCardMessages) {
      ok = await feishuClient.updateAssistantCardMessageWithId?.(messageId, {
        text: messageOut.text,
        streaming: messageOut.mode === 'streaming',
        status: messageOut.status,
      }) ?? false
    } else {
      ok = await feishuClient.updateRichTextMessage(messageId, messageOut.text)
    }
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
    async getBotUserId(): Promise<string | null> {
      return await feishuClient.getBotUserId()
    },
  }
}
