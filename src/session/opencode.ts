import type { Config, OpencodeClient } from "@opencode-ai/sdk";
import type { IncomingMessage, MessageProvider } from "../types.js";
import {
  getChannelAgent,
  getChannelDirectory,
  getChannelModel,
  getSessionAgent,
  getSessionModel,
  getThreadSession,
  setChannelDirectory,
  setThreadSession,
} from "../database.js";
import { initializeOpencodeForDirectory } from "../opencode.js";
import { getOpencodeSystemMessage } from "../system-message.js";
import { OpenCodeApiError } from "../errors.js";
import { sendReply } from "./messaging.js";
import { activeRequests, activeStreams } from "./state.js";
import { extractPartsFromPromptResult, extractTextFromPromptResult } from "./format.js";
import { buildFooter } from "./stats.js";
import { buildFailureReport, describeError, isRecord, logWith, toUserErrorMessage } from "./utils.js";
import { createStreamingController } from "./opencode-streaming.js";
import { createFeishuStreamSink } from "./feishu-stream-sink.js";
import type { StreamingConfig } from "../providers/feishu/feishu-config.js";

export function parseModelString(
  model: string,
): { providerID: string; modelID: string } | null {
  const [providerID, ...modelParts] = model.split("/");
  const modelID = modelParts.join("/");
  if (!providerID || !modelID) return null;
  return { providerID, modelID };
}

export async function resolveDefaultModel(
  getClient: () => OpencodeClient,
  directory: string,
): Promise<{ providerID: string; modelID: string } | null> {
  const configResponse = await getClient().config.get({ query: { directory } });
  if (configResponse.data?.model) {
    const configModel = parseModelString(configResponse.data.model);
    if (configModel) {
      return configModel;
    }
  }

  const providersResponse = await getClient().provider.list({
    query: { directory },
  });
  if (!providersResponse.data) return null;

  const {
    connected,
    default: defaults,
    all: providers,
  } = providersResponse.data;
  if (!connected || connected.length === 0) return null;

  const firstProvider = connected[0];
  const defaultModelId = defaults?.[firstProvider];
  if (defaultModelId) {
    return { providerID: firstProvider, modelID: defaultModelId };
  }

  const provider = providers.find((p) => p.id === firstProvider);
  const modelId = provider?.models
    ? Object.keys(provider.models)[0]
    : undefined;
  if (modelId) {
    return { providerID: firstProvider, modelID: modelId };
  }

  return null;
}

type QuestionSpec = {
  id: string;
  title: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
};

function extractQuestionSpecs(result: unknown): QuestionSpec[] {
  const parts = extractPartsFromPromptResult(result);
  if (parts.length === 0) return [];

  const specs: QuestionSpec[] = [];
  let questionIndex = 0;

  for (const part of parts) {
    if (!isRecord(part)) continue;
    if (part.type !== "tool") continue;
    if (part.tool !== "question") continue;
    const state = isRecord(part.state) ? part.state : undefined;
    if (!state) continue;

    // Opencode may put the question payload in `state.input` (often as a JSON string),
    // especially when the tool is still pending/running. Prefer `input` when present.
    const rawInput =
      typeof (state as Record<string, unknown>).input !== "undefined"
        ? (state as Record<string, unknown>).input
        : (state as Record<string, unknown>).output;
    let parsed: unknown = rawInput;
    if (typeof rawInput === "string") {
      try {
        parsed = JSON.parse(rawInput);
      } catch {
        parsed = undefined;
      }
    }
    if (!isRecord(parsed)) continue;
    const questions = Array.isArray(parsed.questions) ? parsed.questions : [];
    for (const q of questions) {
      if (!isRecord(q)) continue;
      const question = typeof q.question === "string" ? q.question : "";
      const header = typeof q.header === "string" ? q.header : "";
      const optionsRaw = Array.isArray(q.options) ? q.options : [];
      const options = optionsRaw
        .map((opt) => {
          if (!isRecord(opt)) return null;
          const label = typeof opt.label === "string" ? opt.label : "";
          if (!label) return null;
          const description = typeof opt.description === "string" ? opt.description : undefined;
          return description ? { label, description } : { label };
        })
        .filter((opt): opt is { label: string; description?: string } => Boolean(opt));
      if (!question || options.length === 0) continue;
      const id = `q${questionIndex++}`;
      specs.push({
        id,
        title: header || "请选择",
        question,
        options,
      });
    }
  }

  return specs;
}

async function sendQuestionCards(
  response: unknown,
  options: {
    provider: MessageProvider;
    message: IncomingMessage;
    logger?: (message: string, level?: "debug" | "info" | "warn" | "error") => void;
  },
): Promise<boolean> {
  const specs = extractQuestionSpecs(response);
  if (specs.length === 0) {
    const parts = extractPartsFromPromptResult(response);
    const toolParts = parts.filter(
      (part) => isRecord(part) && part.type === "tool",
    ) as Array<Record<string, unknown>>;
    const toolNames = toolParts
      .map((part) => (typeof part.tool === "string" ? part.tool : "unknown"))
      .join(",");
    const questionParts = toolParts.filter((part) => part.tool === "question");
    const formatValue = (value: unknown) => {
      if (typeof value === "string") return value.length > 800 ? `${value.slice(0, 800)}…` : value;
      try {
        const text = JSON.stringify(value);
        return text.length > 800 ? `${text.slice(0, 800)}…` : text;
      } catch {
        return "[unserializable]";
      }
    };
    const questionSnapshots = questionParts.map((part) => {
      const state = isRecord(part.state) ? part.state : undefined;
      if (!state) return "[question:missing-state]";
      const input =
        typeof (state as Record<string, unknown>).input !== "undefined"
          ? (state as Record<string, unknown>).input
          : (state as Record<string, unknown>).output;
      return `question:${formatValue(input)}`;
    });
    logWith(
      options.logger,
      `Question cards: no specs parsed; parts=${parts.length} tools=[${toolNames}] questionParts=${questionParts.length} details=${questionSnapshots.join(" | ")}`,
      "debug",
    );
    return false;
  }
  logWith(options.logger, `Question cards: ${specs.length} questions parsed`, "debug");
  const feishuClient = options.provider.getFeishuClient?.();
  if (!feishuClient || typeof feishuClient.replyQuestionCardWithId !== "function") {
    logWith(options.logger, "Question card skipped: provider has no card sender", "debug");
    return false;
  }

  const replyInThread = Boolean(options.message.threadId);
  let sent = false;
  for (const spec of specs) {
    logWith(
      options.logger,
      `Sending question card id=${spec.id} title=${spec.title} options=${spec.options.length}`,
      "debug",
    );
    const messageId = await feishuClient.replyQuestionCardWithId(
      options.message.messageId,
      {
        title: spec.title,
        questionId: spec.id,
        questionText: spec.question,
        options: spec.options,
      },
      { replyInThread },
    );
    if (!messageId) {
      logWith(options.logger, `Question card send failed id=${spec.id}`, "warn");
    }
    if (messageId) sent = true;
  }
  return sent;
}

export async function resolveModel(
  getClient: () => OpencodeClient,
  directory: string,
  sessionId: string,
  channelId: string,
  logger?: (message: string, level?: "debug" | "info" | "warn" | "error") => void,
): Promise<{ providerID: string; modelID: string } | null> {
  const sessionModel = getSessionModel(sessionId);
  if (sessionModel) {
    const parsed = parseModelString(sessionModel);
    if (parsed) {
      logWith(logger, `Using session model: ${sessionModel}`, "info");
      return parsed;
    }
  }

  const agentPreference =
    getSessionAgent(sessionId) || getChannelAgent(channelId);
  if (agentPreference) {
    try {
      const agentsResponse = await getClient().app.agents({
        query: { directory },
      });
      const agent = agentsResponse.data?.find(
        (item) => item.name === agentPreference,
      );
      if (agent?.model) {
        logWith(
          logger,
          `Using agent model: ${agent.model.providerID}/${agent.model.modelID}`,
          "info",
        );
        return agent.model;
      }
    } catch (error) {
      const described = describeError(error);
      logWith(
        logger,
        `Agent lookup failed: ${agentPreference}; ${described.summary}`,
        "debug",
      );
      if (described.stack) {
        logWith(logger, described.stack, "debug");
      }
    }
  }

  const channelModel = getChannelModel(channelId);
  if (channelModel) {
    const parsed = parseModelString(channelModel);
    if (parsed) {
      logWith(logger, `Using channel model: ${channelModel}`, "info");
      return parsed;
    }
  }

  const fallback = await resolveDefaultModel(getClient, directory);
  if (fallback) {
    logWith(
      logger,
      `Using default model: ${fallback.providerID}/${fallback.modelID}`,
      "info",
    );
    return fallback;
  }

  return null;
}

export async function resolveSessionId(
  getClient: () => OpencodeClient,
  threadId: string,
  directory: string,
  prompt: string,
  logger?: (message: string, level?: "debug" | "info" | "warn" | "error") => void,
): Promise<string> {
  const existingSessionId = getThreadSession(threadId);
  if (existingSessionId) {
    try {
      const sessionResponse = await getClient().session.get({
        path: { id: existingSessionId },
        query: { directory },
      });
      if (sessionResponse.data?.id) {
        logWith(logger, `Reusing session ${existingSessionId}`, "info");
        return existingSessionId;
      }
    } catch (error) {
      const described = describeError(error);
      logWith(
        logger,
        `Session ${existingSessionId} lookup failed, creating new; ${described.summary}`,
        "warn",
      );
      if (described.stack) {
        logWith(logger, described.stack, "debug");
      }
      logWith(
        logger,
        `Session ${existingSessionId} not found, creating new`,
        "warn",
      );
    }
  }

  const sessionTitle =
    prompt.length > 80 ? `${prompt.slice(0, 77)}...` : prompt;
  const sessionResponse = await getClient().session.create({
    body: { title: sessionTitle || "飞书会话" },
    query: { directory },
  });
  if (!sessionResponse.data?.id) {
    throw new Error("创建会话失败");
  }

  setThreadSession(threadId, sessionResponse.data.id);
  return sessionResponse.data.id;
}

export async function sendPrompt({
  message,
  provider,
  projectDirectory,
  logger,
  opencodeConfig,
  streaming,
}: {
  message: IncomingMessage;
  provider: MessageProvider;
  projectDirectory: string;
  logger?: (message: string, level?: "debug" | "info" | "warn" | "error") => void;
  opencodeConfig?: Config;
  streaming?: StreamingConfig;
}): Promise<void> {
  const directory = getChannelDirectory(message.channelId) || projectDirectory;
  setChannelDirectory(message.channelId, directory);

  const getClient = await initializeOpencodeForDirectory(
    directory,
    opencodeConfig,
  );
  if (getClient instanceof Error) {
    const described = describeError(getClient);
    logWith(logger, `OpenCode init failed for ${directory}; ${described.summary}`, "error");
    if (described.stack) {
      logWith(logger, described.stack, "debug");
    }
    const report = buildFailureReport({
      operation: "opencode.init",
      directory,
      threadId: message.threadId,
      error: getClient,
    });
    await sendReply(provider, message, `✗ ${toUserErrorMessage(getClient)}\n\n${report}`);
    return;
  }

  const sessionId = await resolveSessionId(
    getClient,
    message.threadId,
    directory,
    message.text,
    logger,
  );

  const existing = activeRequests.get(message.threadId);
  if (existing && existing.sessionId === sessionId) {
    existing.controller.abort(new Error("新请求已启动"));
    try {
      await getClient().session.abort({
        path: { id: sessionId },
        query: { directory },
      });
    } catch (error) {
      const described = describeError(error);
      logWith(logger, `Failed to abort previous session request; ${described.summary}`, "debug");
    }
  }

  const controller = new AbortController();
  activeRequests.set(message.threadId, { sessionId, controller });

  const agentPreference =
    getSessionAgent(sessionId) || getChannelAgent(message.channelId);
  if (agentPreference) {
    logWith(logger, `Using agent preference: ${agentPreference}`, "info");
  }

  let streamController: { start: () => void; stop: () => void } | null = null;
  let streamSink: ReturnType<typeof createFeishuStreamSink> | null = null;

  try {
    const modelParam = await resolveModel(
      getClient,
      directory,
      sessionId,
      message.channelId,
      logger,
    );
    if (!modelParam) {
      await sendReply(
        provider,
        message,
        "✗ 未连接 AI 提供商。请在 OpenCode 中使用 /connect 配置提供商。",
      );
      return;
    }

    const parts = [{ type: "text" as const, text: message.text }];
    const promptStartedAt = Date.now();
    const streamingConfig = streaming || {};
    const streamingEnabled =
      streamingConfig.enabled === true &&
      provider.id === "feishu" &&
      typeof provider.updateMessage === "function";

    if (streamingEnabled) {
      try {
        streamSink = createFeishuStreamSink({
          provider,
          message,
          throttleMs: streamingConfig.throttleMs ?? 700,
          maxMessageChars: streamingConfig.maxMessageChars ?? 9500,
          mode: streamingConfig.mode ?? "update",
          maxUpdateCount: streamingConfig.maxUpdateCount ?? 15,
          logger,
        });

        const placeholderId = await streamSink.start();
        activeStreams.set(message.threadId, { placeholderId });

        streamController = await createStreamingController({
          directory,
          sessionId,
          threadId: message.threadId,
          abortSignal: controller.signal,
          startedAt: promptStartedAt,
          onTextUpdate: async (text) => {
            if (!streamSink) return;
            await streamSink.render(text);
          },
          logger,
        });

        streamController.start();
      } catch (error) {
        const described = describeError(error);
        logWith(
          logger,
          `Streaming init failed session=${sessionId} directory=${directory}; ${described.summary}`,
          "warn",
        );
        streamController = null;
        streamSink = null;
        activeStreams.delete(message.threadId);
      }
    }

    const response = await getClient().session.prompt({
      path: { id: sessionId },
      query: { directory },
      body: {
        parts,
        system: getOpencodeSystemMessage({
          sessionId,
          channelId: message.channelId,
        }),
        model: modelParam,
        agent: agentPreference,
      },
      signal: controller.signal,
    });

    if (response.error) {
      const status = response.response?.status || 500;
      const errorMessage = JSON.stringify(response.error);
      logWith(
        logger,
        `OpenCode prompt error (status=${status}) session=${sessionId} directory=${directory} error=${errorMessage}`,
        "error",
      );
      throw new OpenCodeApiError(status, errorMessage);
    }

    const replyText = extractTextFromPromptResult(response);
    await sendQuestionCards(response, { provider, message, logger });
    const footer = await buildFooter(response, {
      sessionId,
      model: modelParam,
      directory,
      startedAt: promptStartedAt,
      getClient,
    });

    if (streamSink) {
      streamController?.stop();
      await streamSink.finalize(replyText, footer);
    } else {
      const combined = replyText.trim();
      const finalText = combined ? `${combined}\n\n${footer}` : footer;
      if (finalText.trim().length > 0) {
        await sendReply(provider, message, finalText);
      }
    }
  } catch (error) {
    const described = describeError(error);
    const errorWithCause = error as { cause?: unknown } | null;
    const cause = errorWithCause?.cause;
    const isHeadersTimeout = (value: unknown) => {
      if (!value || typeof value !== "object") return false;
      const record = value as Record<string, unknown>;
      return (
        record.name === "HeadersTimeoutError"
        || record.code === "UND_ERR_HEADERS_TIMEOUT"
      );
    };
    if (isHeadersTimeout(cause) || described.summary.includes("HeadersTimeoutError")) {
      logWith(
        logger,
        "OpenCode 请求超时，可能在等待审批；请在 OpenCode 侧确认并放行该请求。",
        "warn",
      );
    }
    logWith(
      logger,
      `Prompt failed session=${sessionId} directory=${directory}; ${described.summary}`,
      "error",
    );
    if (described.stack) {
      logWith(logger, described.stack, "debug");
    }

    if (streamController) {
      streamController.stop();
    }
    if (streamSink) {
      await streamSink.fail(toUserErrorMessage(error));
    }

    const report = buildFailureReport({
      operation: "opencode.prompt",
      directory,
      threadId: message.threadId,
      sessionId,
      error,
    });
    await sendReply(provider, message, `✗ ${toUserErrorMessage(error)}\n\n${report}`);
  } finally {
    activeRequests.delete(message.threadId);
    if (streamController) {
      streamController.stop();
    }
    activeStreams.delete(message.threadId);
  }
}
