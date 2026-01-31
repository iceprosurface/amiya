import * as lark from '@larksuiteoapi/node-sdk'
import type { FeishuConfig } from './feishu-config'

type MessageEventData = Parameters<NonNullable<lark.EventHandles['im.message.receive_v1']>>[0]

export type FeishuMessageEventData = MessageEventData

export type MessageHandler = (event: MessageEventData) => void | Promise<void>

export type CardActionHandler = (cardAction: {
  action: 'approve' | 'reject' | 'question'
  requestId?: string
  questionId?: string
  answerLabel?: string
  userId: string
  messageId: string
  channelId: string
  threadId: string
  userName?: string
}) => void | Promise<void>

export function createFeishuEventClient(
  config: FeishuConfig,
  logger?: (message: string, level?: 'debug' | 'info' | 'warn' | 'error') => void,
) {
  const messageHandlers: MessageHandler[] = []
  let cardActionHandler: CardActionHandler | null = null
  let wsClient: lark.WSClient | null = null

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null
  }

  function hasVoidMethod(
    value: unknown,
    name: string,
  ): value is Record<string, unknown> & { [key: string]: () => void } {
    return isRecord(value) && typeof value[name] === 'function'
  }

  const log = (message: string, level: 'debug' | 'info' | 'warn' | 'error' = 'info') => {
    if (logger) {
      logger(`[FeishuWS] ${message}`, level)
    } else if (config.debug) {
      // console.log(`[FeishuWS][${level}] ${message}`)
    }
  }

  const handleMessageEvent = async (data: MessageEventData): Promise<void> => {
    try {
      const senderId = data.sender?.sender_id?.open_id || data.sender?.sender_id?.user_id || ''
      const chatId = data.message?.chat_id || ''

      log(`Message from ${senderId} in ${chatId}`, 'info')
      log(`Content: ${data.message?.content?.substring(0, 100) ?? ''}`, 'debug')

      for (const handler of messageHandlers) {
        try {
          await handler(data)
        } catch (error) {
          log(`Message handler failed: ${error}`, 'error')
        }
      }
    } catch (error) {
      log(`Parse message event failed: ${error}`, 'error')
    }
  }

  const eventDispatcher = new lark.EventDispatcher({})
  eventDispatcher.register({
    'im.message.receive_v1': handleMessageEvent,
  })

  const handleCardActionEvent = async (ev: lark.InteractiveCardActionEvent): Promise<void> => {
    if (!cardActionHandler) {
      log('No card action handler registered', 'warn')
      return
    }

    const { action, open_id, user_id, open_message_id } = ev
    const evRecord = ev as unknown as Record<string, unknown>
    const actionValue = action?.value as Record<string, unknown>

    log(`Card action raw payload: ${JSON.stringify(evRecord)}`, 'debug')
    log(`Card action value: ${JSON.stringify(actionValue)}`, 'debug')

    const readString = (value: unknown): string | undefined =>
      typeof value === 'string' && value.length > 0 ? value : undefined
    const readPathString = (root: unknown, path: string[]): string | undefined => {
      let cur: unknown = root
      for (const key of path) {
        if (!cur || typeof cur !== 'object') return undefined
        cur = (cur as Record<string, unknown>)[key]
      }
      return readString(cur)
    }

    const cardAction = actionValue?.action as 'approve' | 'reject' | 'question' | undefined
    const requestId = actionValue?.request_id as string | undefined
    const questionId = actionValue?.question_id as string | undefined
    const answerLabel = actionValue?.answer_label as string | undefined

    if (!cardAction) {
      log(`Invalid card action value: ${JSON.stringify(actionValue)}`, 'warn')
      return
    }

    const messageId =
      readString(open_message_id)
      ?? readPathString(evRecord, ['context', 'open_message_id'])
      ?? readPathString(evRecord, ['message_id'])
      ?? readPathString(evRecord, ['open_message_id'])
      ?? readPathString(actionValue, ['message_id'])

    const channelId =
      readPathString(evRecord, ['context', 'open_chat_id'])
      ?? readPathString(evRecord, ['open_chat_id'])
      ?? readPathString(evRecord, ['chat_id'])
      ?? readPathString(actionValue, ['open_chat_id'])
      ?? readPathString(actionValue, ['chat_id'])

    const operatorId =
      readPathString(evRecord, ['operator', 'open_id'])
      ?? readPathString(evRecord, ['operator', 'operator_id', 'open_id'])
      ?? readPathString(evRecord, ['operator', 'operator_id', 'user_id'])
      ?? readPathString(evRecord, ['operator', 'user_id'])
      ?? readPathString(evRecord, ['operator_id', 'open_id'])
      ?? readPathString(evRecord, ['operator_id', 'user_id'])

    const resolvedUserId = readString(open_id) ?? readString(user_id) ?? operatorId ?? ''

    try {
      await cardActionHandler({
        action: cardAction,
        requestId,
        questionId,
        answerLabel,
        userId: resolvedUserId,
        messageId: messageId || '',
        threadId: messageId || '',
        channelId: channelId || '',
        userName: undefined,
      })
      log(`Card action ${cardAction} processed`, 'info')
    } catch (error) {
      log(`Card action handler failed: ${error}`, 'error')
    }
  }

  eventDispatcher.register<{
    'card.action.trigger': typeof handleCardActionEvent
  }>({
    'card.action.trigger': handleCardActionEvent,
  })

  return {
    onMessage(handler: MessageHandler) {
      messageHandlers.push(handler)
    },

    onCardAction(handler: CardActionHandler) {
      cardActionHandler = handler
    },

    start() {
      log('Starting Feishu WebSocket...', 'info')
      if (wsClient) {
        log('WebSocket already started', 'warn')
        return
      }

      wsClient = new lark.WSClient({
        appId: config.appId,
        appSecret: config.appSecret,
        domain: config.useLark ? lark.Domain.Lark : lark.Domain.Feishu,
        loggerLevel: config.debug ? lark.LoggerLevel.debug : lark.LoggerLevel.info,
      })

      wsClient.start({ eventDispatcher })
      log('WebSocket started', 'info')
    },

    stop() {
      const client = wsClient
      wsClient = null
      if (client) {
        if (hasVoidMethod(client, 'stop')) {
          client['stop']()
        } else if (hasVoidMethod(client, 'close')) {
          client['close']()
        }
      }
      log('WebSocket stopped', 'info')
    },
  }
}

export type FeishuEventClientInstance = {
  onMessage(handler: MessageHandler): void
  onCardAction(handler: CardActionHandler): void
  start(): void
  stop(): void
}
