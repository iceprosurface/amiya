import {
  getChannelModel,
  setChannelModel,
} from "../../database.js";
import { t } from "../../i18n/index.js";
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
      t("commands.channelModelCurrent", { model: currentModel || "-" }),
    );
    return true;
  }

  setChannelModel(message.channelId, arg);
  await sendReply(provider, message, t("commands.channelModelSet", { model: arg }));
  return true;
};
