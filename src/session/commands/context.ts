import { getThreadSession } from "../../database.js";
import { initializeOpencodeForDirectory } from "../../opencode.js";
import { t } from "../../i18n/index.js";
import { sendReply } from "../messaging.js";
import { resolveModel } from "../opencode.js";
import { addTokenTotals, getModelLimit, readTokensFromAssistantMessage } from "../stats.js";
import { formatNumber, formatUsd, isRecord, safeDateTime, toUserErrorMessage } from "../utils.js";
import { resolveAccessibleDirectory } from "./shared.js";
import type { CommandHandler } from "./shared.js";

export const handleContext: CommandHandler = async (message, command, options) => {
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
    await sendReply(provider, message, t("commands.contextNoSession"));
    return true;
  }

  const resolvedModel = await resolveModel(
    getClient,
    directory,
    sessionId,
    message.channelId,
    options.logger,
  );

  const sessionInfoResp = await getClient().session.get({
    path: { id: sessionId },
    query: { directory },
  });

  const messagesResp = await getClient().session.messages({
    path: { id: sessionId },
    query: { directory, limit: 200 },
  });

  const messageItems = messagesResp.data || [];
  let userCount = 0;
  let assistantCount = 0;
  let totalCost = 0;
  let totals = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
  let lastAssistant: Record<string, unknown> | null = null;

  for (const item of messageItems) {
    if (!isRecord(item)) continue;
    const info = item.info;
    if (!isRecord(info)) continue;
    const infoRec = info;
    const role = infoRec.role;
    if (role === "user") userCount += 1;
    if (role === "assistant") {
      assistantCount += 1;
      lastAssistant = infoRec;
      const cost = typeof infoRec.cost === "number" ? infoRec.cost : 0;
      totalCost += Number.isFinite(cost) ? cost : 0;
      totals = addTokenTotals(totals, readTokensFromAssistantMessage(infoRec));
    }
  }

  const limit = resolvedModel
    ? await getModelLimit(getClient, directory, resolvedModel)
    : null;

  const lastTokens = lastAssistant ? readTokensFromAssistantMessage(lastAssistant) : null;
  const lastInput = lastTokens?.input ?? 0;
  const ratio = limit && limit.context > 0 ? lastInput / limit.context : null;

  const lines: string[] = [];
  lines.push(t("commands.contextTitle"));
  lines.push(t("commands.contextSession", { sessionId }));
  lines.push(t("commands.contextDirectory", { directory }));

  if (sessionInfoResp.data) {
    const sessionInfo = sessionInfoResp.data as unknown;
    if (isRecord(sessionInfo) && isRecord(sessionInfo.time)) {
      const created = sessionInfo.time.created;
      const updated = sessionInfo.time.updated;
      lines.push(
        t("commands.contextTime", {
          created: safeDateTime(typeof created === "number" ? created : undefined),
          updated: safeDateTime(typeof updated === "number" ? updated : undefined),
        }),
      );
    }
  }

  if (resolvedModel) {
    lines.push(t("commands.contextModel", { model: `${resolvedModel.providerID}/${resolvedModel.modelID}` }));
  } else {
    lines.push(t("commands.contextModelEmpty"));
  }

  if (limit) {
    lines.push(t("commands.contextLimits", { value: formatNumber(limit.context) }));
    lines.push(t("commands.contextOutputLimit", { value: formatNumber(limit.output) }));
  } else {
    lines.push(t("commands.contextLimitsEmpty"));
  }

  lines.push(t("commands.contextMessageCount", {
    user: userCount,
    assistant: assistantCount,
    total: messageItems.length,
  }));
  lines.push(t("commands.contextTotals", {
    input: formatNumber(totals.input),
    output: formatNumber(totals.output),
    reasoning: formatNumber(totals.reasoning),
    cacheR: formatNumber(totals.cacheRead),
    cacheW: formatNumber(totals.cacheWrite),
    cost: formatUsd(totalCost),
  }));

  if (lastAssistant) {
    const time = isRecord(lastAssistant.time) ? lastAssistant.time : undefined;
    const cost = typeof lastAssistant.cost === "number" ? lastAssistant.cost : 0;
    const atMs =
      typeof time?.completed === "number"
        ? time.completed
        : typeof time?.created === "number"
          ? time.created
          : undefined;
    lines.push(t("commands.contextLast", {
      input: formatNumber(lastTokens?.input ?? 0),
      output: formatNumber(lastTokens?.output ?? 0),
      reasoning: formatNumber(lastTokens?.reasoning ?? 0),
      cost: formatUsd(cost),
      at: safeDateTime(atMs),
    }));
    if (ratio !== null) {
      lines.push(t("commands.contextLastContext", { value: (ratio * 100).toFixed(1) }));
    }
  } else {
    lines.push(t("commands.contextLastEmpty"));
  }

  await sendReply(provider, message, lines.join("\n"));
  return true;
};
