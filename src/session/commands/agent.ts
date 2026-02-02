import {
  getChannelAgent,
  getSessionAgent,
  getThreadSession,
  setChannelAgent,
  setSessionAgent,
} from "../../database.js";
import { sendReply } from "../messaging.js";
import type { CommandHandler } from "./shared.js";

export const handleAgent: CommandHandler = async (message, command, options) => {
  const { provider } = options;
  const arg = command.args.join(" ").trim();
  const sessionId = getThreadSession(message.threadId);
  if (!arg) {
    const sessionAgent = sessionId ? getSessionAgent(sessionId) : undefined;
    const channelAgent = getChannelAgent(message.channelId);
    await sendReply(
      provider,
      message,
      `会话代理：${sessionAgent || "-"}\n频道代理：${channelAgent || "-"}`,
    );
    return true;
  }
  if (sessionId) {
    setSessionAgent(sessionId, arg);
    await sendReply(provider, message, `✅ 会话代理已设置为 ${arg}`);
  } else {
    setChannelAgent(message.channelId, arg);
    await sendReply(provider, message, `✅ 频道代理已设置为 ${arg}`);
  }
  return true;
};
