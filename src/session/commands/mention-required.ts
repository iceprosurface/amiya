import { getThreadMentionRequired, setThreadMentionRequired } from "../../database.js";
import { t } from "../../i18n/index.js";
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
      t("commands.mentionStatus", { value: current ? t("common.yes") : t("common.no") }),
    );
    return true;
  }

  if (value && !options.botUserId) {
    await sendReply(
      provider,
      message,
      t("commands.mentionMissingBot"),
    );
    return true;
  }

  setThreadMentionRequired(message.threadId, value);
  await sendReply(
    provider,
    message,
    t("commands.mentionSet", { value: value ? t("common.yes") : t("common.no") }),
  );
  return true;
};
