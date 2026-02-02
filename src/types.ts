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
  mode?: 'streaming' | 'final'
  status?: 'info' | 'warning' | 'error'
  cardId?: string
  elementId?: string
  messageParts?: MessagePart[]
}

export type MessagePart = {
  orderIndex?: number
  type?: string
  text?: string
  reasoning?: string
  description?: string
  prompt?: string
  agent?: string
  tool?: string
  state?: Record<string, unknown>
  time?: { start?: number; end?: number }
  id?: string
  messageID?: string
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
        permissionResponse?: { requestId: string; reply: 'once' | 'always' | 'reject' }
      },
    ) => void | Promise<void>,
  ): void
  sendMessage(
    target: OutgoingTarget,
    message: OutgoingMessage,
  ): Promise<{ messageId: string; cardId?: string; elementId?: string }>
  replyMessage?(
    message: IncomingMessage,
    messageOut: OutgoingMessage,
  ): Promise<{ messageId: string; cardId?: string; elementId?: string }>
  updateMessage?(messageId: string, messageOut: OutgoingMessage): Promise<boolean>
  addReaction?(messageId: string, emoji: string): Promise<boolean>
  getFeishuClient?(): FeishuCardClient | null
  getBotUserId?(): Promise<string | null>
}

export type FeishuCardClient = {
  uploadTextFile?: (params: {
    content: string;
    fileName: string;
    fileType?: string;
    mimeType?: string;
  }) => Promise<string | null>
  sendFileMessage?: (
    chatId: string,
    fileKey: string,
  ) => Promise<string | null>
  replyFileMessageWithId?: (
    messageId: string,
    fileKey: string,
    options?: { replyInThread?: boolean },
  ) => Promise<string | null>
  sendApprovalCard?: (
    adminChatId: string,
    params: { requestId: string; channelId: string; userId: string; userName?: string },
  ) => Promise<string | null>
  replyApprovalCardWithId?: (
    messageId: string,
    params: { requestId: string; channelId: string; userId: string; userName?: string },
    options?: { replyInThread?: boolean },
  ) => Promise<string | null>
  updateApprovalCard?: (
    messageId: string,
    status: 'approved' | 'rejected',
    actionBy: string,
  ) => Promise<boolean>
  replyPermissionCardWithId?: (
    messageId: string,
    params: { requestId: string; permission: string; patterns: string[] },
    options?: { replyInThread?: boolean },
  ) => Promise<string | null>
  replyQuestionCardWithId?: (
    messageId: string,
    params: {
      title: string
      questionId: string
      questionText: string
      options: Array<{ label: string; description?: string }>
      questionIndex: number
      totalQuestions: number
      selectedLabels?: string[]
      nextLabel?: string
    },
    options?: { replyInThread?: boolean },
  ) => Promise<string | null>
  updatePermissionCardWithId?: (
    messageId: string,
    params: {
      requestId: string
      permission: string
      patterns: string[]
      status: 'approved' | 'rejected'
      replyLabel?: string
    },
  ) => Promise<boolean>
  updateQuestionCardWithId?: (
    messageId: string,
    params: {
      title: string
      questionId: string
      questionText: string
      options: Array<{ label: string; description?: string }>
      questionIndex: number
      totalQuestions: number
      selectedLabels?: string[]
      nextLabel?: string
      completed?: boolean
    },
  ) => Promise<boolean>
  sendAssistantCardMessageWithId?: (
    chatId: string,
    params: {
      text: string
      footer?: string
      title?: string
      streaming?: boolean
      status?: 'info' | 'warning' | 'error'
      messageParts?: MessagePart[]
    },
  ) => Promise<{ messageId: string; cardId: string; elementId: string } | null>
  replyAssistantCardMessageWithId?: (
    messageId: string,
    params: {
      text: string
      footer?: string
      title?: string
      streaming?: boolean
      status?: 'info' | 'warning' | 'error'
      messageParts?: MessagePart[]
    },
    options?: { replyInThread?: boolean },
  ) => Promise<{ messageId: string; cardId: string; elementId: string } | null>
  updateAssistantCardMessageWithId?: (
    messageId: string,
    params: {
      text: string
      footer?: string
      title?: string
      streaming?: boolean
      status?: 'info' | 'warning' | 'error'
      messageParts?: MessagePart[]
    },
  ) => Promise<boolean>
  updateAssistantCardElementContentWithId?: (
    cardId: string,
    elementId: string,
    content: string,
  ) => Promise<boolean>
  updateAssistantCardConfigWithId?: (
    cardId: string,
    params: {
      sequence: number
      streaming?: boolean
      summary?: string
    },
  ) => Promise<boolean>
  updateAssistantCardEntityWithId?: (
    cardId: string,
    params: {
      sequence: number
      text: string
      details?: string
      meta?: string
      showDetails: boolean
      showMeta: boolean
      title?: string
      status?: 'info' | 'warning' | 'error'
    },
  ) => Promise<boolean>
}
