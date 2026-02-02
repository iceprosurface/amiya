import {
  clearSessionModel,
  getChannelModel,
  getSessionModel,
  getThreadSession,
  setChannelModel,
  setSessionModel,
} from "../../database.js";
import { sendReply } from "../messaging.js";
import type { CommandHandler } from "./shared.js";

export const handleModel: CommandHandler = async (message, command, options) => {
  const { provider } = options;
  const arg = command.args.join(" ").trim();
  const sessionId = getThreadSession(message.threadId);
  if (!arg) {
    const sessionModel = sessionId ? getSessionModel(sessionId) : undefined;
    const channelModel = getChannelModel(message.channelId);
    await sendReply(
      provider,
      message,
      `会话模型：${sessionModel || "-"}\n频道模型：${channelModel || "-"}`,
    );
    return true;
  }
  if (arg === "clear") {
    if (sessionId) {
      clearSessionModel(sessionId);
    }
    await sendReply(provider, message, "✅ 模型偏好已清除。");
    return true;
  }
  if (sessionId) {
    setSessionModel(sessionId, arg);
    await sendReply(provider, message, `✅ 会话模型已设置为 ${arg}`);
  } else {
    setChannelModel(message.channelId, arg);
    await sendReply(provider, message, `✅ 频道模型已设置为 ${arg}`);
  }
  return true;
};
