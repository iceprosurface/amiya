import { listThreadSessions } from "../../database.js";
import { sendReply } from "../messaging.js";
import type { CommandHandler } from "./shared.js";

export const handleListSessions: CommandHandler = async (message, _command, options) => {
  const { provider } = options;
  const sessions = listThreadSessions();
  if (sessions.length === 0) {
    await sendReply(provider, message, "未找到会话。");
    return true;
  }
  const lines = sessions
    .slice(0, 20)
    .map((item) => `- ${item.threadId}: ${item.sessionId}`);
  await sendReply(provider, message, lines.join("\n"));
  return true;
};
