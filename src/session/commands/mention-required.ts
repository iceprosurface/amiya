import { getThreadMentionRequired, setThreadMentionRequired } from "../../database.js";
import { sendReply } from "../messaging.js";
import { parseBooleanArg } from "./shared.js";
import type { CommandHandler } from "./shared.js";

export const handleMentionRequired: CommandHandler = async (message, command, options) => {
  const { provider } = options;
  const current = getThreadMentionRequired(message.threadId) ?? true;
  const value = parseBooleanArg(command.args[0]);
  if (value === null) {
    await sendReply(
      provider,
      message,
      `当前线程需@机器人：${current ? "是" : "否"}。用法：/mention-required true|false`,
    );
    return true;
  }

  if (value && !options.botUserId) {
    await sendReply(
      provider,
      message,
      "请先在 feishu.json 配置 botUserId（机器人 open_id / user_id），否则无法判断是否@。",
    );
    return true;
  }

  setThreadMentionRequired(message.threadId, value);
  await sendReply(provider, message, `✅ 已设置该线程需@机器人：${value ? "是" : "否"}`);
  return true;
};
