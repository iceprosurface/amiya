import type { IncomingMessage } from "../types.js";
import { messageQueue } from "./state.js";
import { logWith } from "./utils.js";

export async function flushQueue(
  threadId: string,
  handler: (message: IncomingMessage) => Promise<void>,
  logger?: (message: string, level?: "debug" | "info" | "warn" | "error") => void,
): Promise<void> {
  const queue = messageQueue.get(threadId);
  if (!queue || queue.length === 0) return;
  const next = queue.shift();
  if (!next) return;

  if (queue.length === 0) {
    messageQueue.delete(threadId);
  }

  const waitedMs = Date.now() - next.queuedAt;
  logWith(
    logger,
    `Queue dequeue thread=${threadId} message=${next.message.messageId || "-"} waitedMs=${waitedMs}`,
    "info",
  );

  await handler(next.message);
  await flushQueue(threadId, handler, logger);
}
