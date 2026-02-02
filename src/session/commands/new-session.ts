import { clearThreadSession } from "../../database.js";
import { sendReply } from "../messaging.js";
import type { CommandHandler } from "./shared.js";

export const handleNewSession: CommandHandler = async (message, _command, options) => {
  const { provider } = options;
  clearThreadSession(message.threadId);
  await sendReply(provider, message, "✅ 下一条消息将创建新会话。");
  return true;
};
