import {
  clearSessionModel,
  getChannelModel,
  getSessionModel,
  getThreadSession,
  setChannelModel,
  setSessionModel,
} from "../../database.js";
import { t } from "../../i18n/index.js";
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
      t("commands.modelStatus", {
        sessionModel: sessionModel || "-",
        channelModel: channelModel || "-",
      }),
    );
    return true;
  }
  if (arg === "clear") {
    if (sessionId) {
      clearSessionModel(sessionId);
    }
    await sendReply(provider, message, t("commands.modelCleared"));
    return true;
  }
  if (sessionId) {
    setSessionModel(sessionId, arg);
    await sendReply(provider, message, t("commands.modelSessionSet", { model: arg }));
  } else {
    setChannelModel(message.channelId, arg);
    await sendReply(provider, message, t("commands.modelChannelSet", { model: arg }));
  }
  return true;
};
