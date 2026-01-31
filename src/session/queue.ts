import type { IncomingMessage } from "../types.js";
import { messageQueue } from "./state.js";

export async function flushQueue(
  threadId: string,
  handler: (message: IncomingMessage) => Promise<void>,
): Promise<void> {
  const queue = messageQueue.get(threadId);
  if (!queue || queue.length === 0) return;
  const next = queue.shift();
  if (!next) return;

  if (queue.length === 0) {
    messageQueue.delete(threadId);
  }

  await handler(next.message);
  await flushQueue(threadId, handler);
}
