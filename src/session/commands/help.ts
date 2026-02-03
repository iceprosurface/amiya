import { t } from "../../i18n/index.js";
import { sendReply } from "../messaging.js";
import type { CommandHandler } from "./shared.js";

export const handleHelp: CommandHandler = async (message, _command, options) => {
  const { provider } = options;
  const lines = [
    t("help.title"),
    "",
    t("help.session"),
    t("help.newSession"),
    t("help.resume"),
    t("help.abort"),
    t("help.queue"),
    t("help.context"),
    t("help.listSessions"),
    "",
    t("help.modelAgent"),
    t("help.model"),
    t("help.channelModel"),
    t("help.agent"),
    "",
    t("help.project"),
    t("help.projectView"),
    t("help.projectSet"),
    t("help.dirAlias"),
    t("help.workspace"),
    t("help.workspaces"),
    "",
    t("help.runtime"),
    t("help.mentionRequired"),
    t("help.update"),
    t("help.compact"),
    t("help.help"),
  ];
  await sendReply(provider, message, lines.join("\n"));
  return true;
};
