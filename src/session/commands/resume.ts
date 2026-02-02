import { getThreadSession, setThreadSession } from "../../database.js";
import { sendReply } from "../messaging.js";
import type { CommandHandler } from "./shared.js";

export const handleResume: CommandHandler = async (message, command, options) => {
  const { provider } = options;
  const sessionId = command.args[0];
  if (!sessionId) {
    const current = getThreadSession(message.threadId);
    await sendReply(provider, message, current ? `当前会话：${current}` : "未绑定会话。");
    return true;
  }
  setThreadSession(message.threadId, sessionId);
  await sendReply(provider, message, `✅ 已将线程绑定到会话 ${sessionId}`);
  return true;
};
