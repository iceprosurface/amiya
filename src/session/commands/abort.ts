import { initializeOpencodeForDirectory } from "../../opencode.js";
import { t } from "../../i18n/index.js";
import { sendReply } from "../messaging.js";
import { activeRequests, activeStreams } from "../state.js";
import { resolveAccessibleDirectory } from "./shared.js";
import type { CommandHandler } from "./shared.js";

export const handleAbort: CommandHandler = async (message, _command, options) => {
  const { provider } = options;
  const active = activeRequests.get(message.threadId);
  if (!active) {
    await sendReply(provider, message, t("commands.abortNone"));
    return true;
  }
  active.controller.abort(new Error("abort"));
  const directory = resolveAccessibleDirectory({
    channelId: message.channelId,
    projectDirectory: options.projectDirectory,
    logger: options.logger,
  });
  const getClient = await initializeOpencodeForDirectory(directory, options.opencodeConfig);
  if (!(getClient instanceof Error)) {
    try {
      await getClient().session.abort({
        path: { id: active.sessionId },
        query: { directory },
      });
    } catch {
      // ignore abort errors
    }
  }
  const streamState = activeStreams.get(message.threadId);
  if (streamState && provider.updateMessage) {
    const updates: Array<Promise<boolean>> = [];
    if (streamState.byOcMessageId && streamState.byOcMessageId.size > 0) {
      for (const entry of streamState.byOcMessageId.values()) {
        updates.push(provider.updateMessage(entry.messageId, {
          text: t("commands.abortStatus"),
          cardId: entry.cardId,
          elementId: entry.elementId,
        }));
      }
    } else if (streamState.placeholderId) {
      const placeholderId = streamState.placeholderId;
      updates.push(provider.updateMessage(placeholderId, {
        text: t("commands.abortStatus"),
        cardId: streamState.cardId,
        elementId: streamState.elementId,
      }));
    }
    if (updates.length > 0) {
      await Promise.allSettled(updates);
    }
    activeStreams.delete(message.threadId);
  }
  await sendReply(provider, message, t("commands.abortDone"));
  return true;
};
