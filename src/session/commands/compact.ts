import { getThreadSession } from "../../database.js";
import { getOpencodeClientV2, initializeOpencodeForDirectory } from "../../opencode.js";
import { t } from "../../i18n/index.js";
import { sendReply } from "../messaging.js";
import { resolveModel } from "../opencode.js";
import { logWith, toUserErrorMessage } from "../utils.js";
import { resolveAccessibleDirectory } from "./shared.js";
import type { CommandHandler } from "./shared.js";

export const handleCompact: CommandHandler = async (message, command, options) => {
  const { provider } = options;
  const directory = resolveAccessibleDirectory(
    message.channelId,
    message.userId,
    options.projectDirectory,
    options.logger,
  );

  const getClient = await initializeOpencodeForDirectory(directory, options.opencodeConfig);
  if (getClient instanceof Error) {
    await sendReply(provider, message, `✗ ${toUserErrorMessage(getClient)}`);
    return true;
  }

  const sessionIdArg = command.args[0];
  const sessionId = sessionIdArg || getThreadSession(message.threadId);
  if (!sessionId) {
    await sendReply(provider, message, t("commands.compactNoSession"));
    return true;
  }

  const clientV2 = getOpencodeClientV2(directory);
  if (!clientV2) {
    await sendReply(provider, message, t("commands.compactClientMissing"));
    return true;
  }

  logWith(
    options.logger,
    `Compaction started session=${sessionId} directory=${directory}`,
    "debug",
  );

  let providerID: string | undefined;
  let modelID: string | undefined;
  try {
    const resolvedModel = await resolveModel(
      getClient,
      directory,
      sessionId,
      message.channelId,
      options.logger,
    );
    providerID = resolvedModel?.providerID;
    modelID = resolvedModel?.modelID;
  } catch {
    // ignore resolve errors, fallback to server defaults
  }

  const response = await clientV2.session.summarize({
    sessionID: sessionId,
    directory,
    providerID,
    modelID,
  });

  if (response.error) {
    const status = response.response?.status || 500;
    const errorMessage = JSON.stringify(response.error);
    logWith(
      options.logger,
      `Compaction failed session=${sessionId} status=${status} error=${errorMessage}`,
      "warn",
    );
    await sendReply(
      provider,
      message,
      t("commands.compactFailed", { status, error: errorMessage }),
    );
    return true;
  }

  logWith(
    options.logger,
    `Compaction completed session=${sessionId} provider=${providerID || "-"} model=${modelID || "-"}`,
    "debug",
  );
  await sendReply(provider, message, t("commands.compactDone"));
  return true;
};
