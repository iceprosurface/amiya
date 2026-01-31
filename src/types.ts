export type ProviderId = 'feishu' | 'slack'

export interface IncomingMessage {
  providerId: ProviderId
  messageId: string
  channelId: string
  threadId: string
  userId: string
  userName?: string
  text: string
  mentions?: string[]
  raw?: unknown
}

export interface OutgoingMessage {
  text: string
}

export interface OutgoingTarget {
  channelId: string
  threadId?: string
}

export interface MessageProvider {
  id: ProviderId
  start(): Promise<void>
  stop(): Promise<void>
  onMessage(
    handler: (
      message: IncomingMessage,
      extra?: {
        isCardAction: boolean
        cardActionData?: { action: 'approve' | 'reject'; requestId: string }
        questionResponse?: { questionId: string; answerLabel: string; questionIndex?: number }
        questionNav?: { questionId: string; questionIndex?: number; direction: 'next' | 'prev' }
      },
    ) => void | Promise<void>,
  ): void
  sendMessage(target: OutgoingTarget, message: OutgoingMessage): Promise<{ messageId: string }>
  replyMessage?(message: IncomingMessage, messageOut: OutgoingMessage): Promise<{ messageId: string }>
  updateMessage?(messageId: string, messageOut: OutgoingMessage): Promise<boolean>
  addReaction?(messageId: string, emoji: string): Promise<boolean>
  getFeishuClient?(): any
}
