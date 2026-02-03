import { getThreadSession, setThreadSession } from "../../database.js";
import { t } from "../../i18n/index.js";
import { sendReply } from "../messaging.js";
import type { CommandHandler } from "./shared.js";

export const handleResume: CommandHandler = async (message, command, options) => {
  const { provider } = options;
  const sessionId = command.args[0];
  if (!sessionId) {
    const current = getThreadSession(message.threadId);
    await sendReply(
      provider,
      message,
      current
        ? t("commands.resumeCurrent", { sessionId: current })
        : t("commands.resumeNone"),
    );
    return true;
  }
  setThreadSession(message.threadId, sessionId, message.userId);
  await sendReply(provider, message, t("commands.resumeSet", { sessionId }));
  return true;
};
