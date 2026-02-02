import {
  getChannelModel,
  setChannelModel,
} from "../../database.js";
import { sendReply } from "../messaging.js";
import type { CommandHandler } from "./shared.js";

export const handleChannelModel: CommandHandler = async (message, command, options) => {
  const { provider } = options;
  const arg = command.args.join(" ").trim();
  const currentModel = getChannelModel(message.channelId);

  if (!arg) {
    await sendReply(
      provider,
      message,
      `当前频道模型：${currentModel || "-"}`,
    );
    return true;
  }

  setChannelModel(message.channelId, arg);
  await sendReply(provider, message, `✅ 频道模型已设置为 ${arg}`);
  return true;
};
