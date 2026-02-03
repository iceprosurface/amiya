import { clearThreadSession } from "../../database.js";
import { t } from "../../i18n/index.js";
import { sendReply } from "../messaging.js";
import type { CommandHandler } from "./shared.js";

export const handleNewSession: CommandHandler = async (message, _command, options) => {
  const { provider } = options;
  clearThreadSession(message.threadId);
  await sendReply(provider, message, t("commands.newSessionNext"));
  return true;
};
