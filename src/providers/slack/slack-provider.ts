import { t } from "../../i18n/index.js";
import type { IncomingMessage, MessageProvider, OutgoingMessage, OutgoingTarget } from "../../types.js";

export function createSlackProvider(): MessageProvider {
  const notReady = async () => {
    throw new Error(t('slack.notImplemented'))
  }

  return {
    id: 'slack',
    start: notReady,
    stop: async () => {},
    onMessage: () => {},
    sendMessage: async (_target: OutgoingTarget, _message: OutgoingMessage) => {
      throw new Error(t('slack.notImplemented'))
    },
    replyMessage: async (_message: IncomingMessage, _messageOut: OutgoingMessage) => {
      throw new Error(t('slack.notImplemented'))
    },
  }
}
