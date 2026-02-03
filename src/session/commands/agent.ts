import {
  getChannelAgent,
  getSessionAgent,
  getThreadSession,
  setChannelAgent,
  setSessionAgent,
} from "../../database.js";
import { t } from "../../i18n/index.js";
import { sendReply } from "../messaging.js";
import type { CommandHandler } from "./shared.js";

export const handleAgent: CommandHandler = async (message, command, options) => {
  const { provider } = options;
  const arg = command.args.join(" ").trim();
  const sessionId = getThreadSession(message.threadId);
  if (!arg) {
    const sessionAgent = sessionId ? getSessionAgent(sessionId) : undefined;
    const channelAgent = getChannelAgent(message.channelId);
    await sendReply(
      provider,
      message,
      t("commands.agentStatus", {
        sessionAgent: sessionAgent || "-",
        channelAgent: channelAgent || "-",
      }),
    );
    return true;
  }
  if (sessionId) {
    setSessionAgent(sessionId, arg);
    await sendReply(provider, message, t("commands.agentSessionSet", { agent: arg }));
  } else {
    setChannelAgent(message.channelId, arg);
    await sendReply(provider, message, t("commands.agentChannelSet", { agent: arg }));
  }
  return true;
};
