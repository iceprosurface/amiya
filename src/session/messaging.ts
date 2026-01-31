import type { IncomingMessage, MessageProvider } from "../types.js";

export async function sendReply(
  provider: MessageProvider,
  message: IncomingMessage,
  text: string,
): Promise<void> {
  if (provider.replyMessage && message.messageId) {
    await provider.replyMessage(message, { text });
    return;
  }
  await provider.sendMessage(
    { channelId: message.channelId, threadId: message.threadId },
    { text },
  );
}
