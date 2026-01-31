import type { IncomingMessage, MessageProvider, OutgoingMessage, OutgoingTarget } from '../../types.js'

export function createSlackProvider(): MessageProvider {
  const notReady = async () => {
    throw new Error('Slack 提供商尚未实现')
  }

  return {
    id: 'slack',
    start: notReady,
    stop: async () => {},
    onMessage: () => {},
    sendMessage: async (_target: OutgoingTarget, _message: OutgoingMessage) => {
      throw new Error('Slack 提供商尚未实现')
    },
    replyMessage: async (_message: IncomingMessage, _messageOut: OutgoingMessage) => {
      throw new Error('Slack 提供商尚未实现')
    },
  }
}
