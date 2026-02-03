import { t } from "../../i18n/index.js";
import { sendReply } from "../messaging.js";
import { activeRequests, messageQueue } from "../state.js";
import { formatRelativeMs, previewText } from "./shared.js";
import type { CommandHandler } from "./shared.js";

export const handleQueue: CommandHandler = async (message, _command, options) => {
  const { provider } = options;
  const now = Date.now();
  const queue = messageQueue.get(message.threadId) || [];
  const active = activeRequests.get(message.threadId);

  const lines: string[] = [];
  lines.push(t("commands.queueTitle"));
  lines.push(t("commands.queueActive", {
    value: active ? `running (session=${active.sessionId})` : t("common.none"),
  }));
  lines.push(t("commands.queueWaiting", { value: queue.length }));

  if (queue.length > 0) {
    const items = queue.slice(0, 10);
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const age = formatRelativeMs(now - item.queuedAt);
      const text = previewText(item.message.text, 100);
      lines.push(
        `- #${i + 1} age=${age} user=${item.message.userId || "-"} text=${text || "-"}`,
      );
    }
    if (queue.length > 10) {
      lines.push(t("commands.queueMore", { value: queue.length - 10 }));
    }
  }

  await sendReply(provider, message, lines.join("\n"));
  return true;
};
