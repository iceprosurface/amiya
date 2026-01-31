import type { OpencodeClient } from "@opencode-ai/sdk";
import { isRecord } from "./utils.js";

export type TokenTotals = {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
};

export function addTokenTotals(a: TokenTotals, b: Partial<TokenTotals>): TokenTotals {
  return {
    input: a.input + (b.input ?? 0),
    output: a.output + (b.output ?? 0),
    reasoning: a.reasoning + (b.reasoning ?? 0),
    cacheRead: a.cacheRead + (b.cacheRead ?? 0),
    cacheWrite: a.cacheWrite + (b.cacheWrite ?? 0),
  };
}

export function readTokensFromAssistantMessage(info: Record<string, unknown>): TokenTotals {
  const tokens = info.tokens;
  if (!tokens || typeof tokens !== "object") {
    return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
  }
  const t = tokens as Record<string, unknown>;
  const cache = t.cache;
  const c = cache && typeof cache === "object" ? (cache as Record<string, unknown>) : undefined;

  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    input: n(t.input),
    output: n(t.output),
    reasoning: n(t.reasoning),
    cacheRead: n(c?.read),
    cacheWrite: n(c?.write),
  };
}

export async function getModelLimit(
  getClient: () => OpencodeClient,
  directory: string,
  model: { providerID: string; modelID: string },
): Promise<{ context: number; output: number } | null> {
  const providersResponse = await getClient().provider.list({ query: { directory } });
  const providers = providersResponse.data?.all;
  if (!providers || !Array.isArray(providers)) return null;

  const provider = providers.find((p) => p.id === model.providerID);
  if (!provider || typeof provider !== "object") return null;

  const providerRec = provider as unknown as Record<string, unknown>;
  const models = providerRec.models;
  if (!isRecord(models)) return null;

  const modelInfo = models[model.modelID];
  if (!isRecord(modelInfo)) return null;

  const limit = modelInfo?.limit;
  if (!limit || typeof limit !== "object") return null;

  const l = limit as Record<string, unknown>;
  const context = typeof l.context === "number" ? l.context : NaN;
  const output = typeof l.output === "number" ? l.output : NaN;
  if (!Number.isFinite(context) || !Number.isFinite(output)) return null;
  return { context, output };
}

export function formatDurationSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0.0s";
  return `${seconds.toFixed(1)}s`;
}

export function formatPercentRatio(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "0%";
  const pct = (value * 100).toFixed(2);
  return `${pct.replace(/^0(?=\\.)/, "")}%`;
}

export async function buildFooter(
  result: unknown,
  options: {
    sessionId: string;
    model: { providerID: string; modelID: string };
    directory: string;
    startedAt: number;
    getClient: () => OpencodeClient;
  },
): Promise<string> {
  const data = isRecord(result) && isRecord(result.data) ? result.data : undefined;
  const info = data && isRecord(data.info) ? (data.info as Record<string, unknown>) : undefined;

  const infoSessionId =
    info && typeof info.sessionID === "string" ? info.sessionID : options.sessionId;
  const modelId =
    info && typeof info.modelID === "string" ? info.modelID : options.model.modelID;

  let durationSeconds = 0;
  const time = info && isRecord(info.time) ? (info.time as Record<string, unknown>) : undefined;
  const created = time && typeof time.created === "number" ? time.created : undefined;
  const completed = time && typeof time.completed === "number" ? time.completed : undefined;
  if (typeof created === "number" && typeof completed === "number" && completed >= created) {
    durationSeconds = (completed - created) / 1000;
  } else {
    durationSeconds = (Date.now() - options.startedAt) / 1000;
  }

  let percentText = "";
  try {
    const limit = await getModelLimit(options.getClient, options.directory, options.model);
    if (limit?.context) {
      const tokens = info ? readTokensFromAssistantMessage(info) : undefined;
      const totalTokens = tokens
        ? tokens.input + tokens.output + tokens.reasoning + tokens.cacheRead + tokens.cacheWrite
        : 0;
      if (totalTokens > 0) {
        percentText = formatPercentRatio(totalTokens / limit.context);
      }
    }
  } catch {
    // ignore footer ratio failures
  }

  let footer = `${formatDurationSeconds(durationSeconds)}完成`;
  if (percentText) footer += ` ${percentText}`;
  if (infoSessionId) footer += ` ${infoSessionId}.`;
  if (modelId) footer += ` ${modelId}`;
  return footer;
}
