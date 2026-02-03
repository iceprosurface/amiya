import type { Config, OpencodeClient } from "@opencode-ai/sdk";
import fs from "node:fs";

import {
  getChannelAgent,
  getChannelDirectory,
  getChannelModel,
  getSessionAgent,
  getSessionModel,
  getThreadSession,
  getThreadSessionUser,
  setChannelDirectory,
  setThreadSession,
  updateQuestionRequestCard,
  upsertMessagePart,
  upsertQuestionRequest,
  upsertToolRun,
} from "../database.js";
import { t } from "../i18n/index.js";
import { OpenCodeApiError } from "../errors.js";
import { initializeOpencodeForDirectory } from "../opencode.js";
import type { StreamingConfig } from "../providers/feishu/feishu-config.js";
import { getOpencodeSystemMessage } from "../system-message.js";
import type { IncomingMessage, MessageProvider } from "../types.js";
import { createFeishuStreamSink } from "./feishu-stream-sink.js";
import { resolveWorkspaceDirectory } from "./workspace.js";
import {
  extractPartsFromPromptResult,
  extractTextFromPromptResult,
  extractTextWithAttachmentsFromPromptResult,
  type ToolAttachment,
} from "./format.js";
import { sendReply } from "./messaging.js";
import { createStreamingController } from "./opencode-streaming.js";
import { activeRequests, activeStreams, pendingPermissions, pendingQuestions } from "./state.js";
import { buildFooter } from "./stats.js";
import { buildFailureReport, describeError, isRecord, logWith, toUserErrorMessage } from "./utils.js";

const buildAttachmentQueues = (attachments: ToolAttachment[]) => {
  const queues = new Map<string, string[]>();
  for (const attachment of attachments) {
    const list = queues.get(attachment.tool) ?? [];
    list.push(attachment.fileName);
    queues.set(attachment.tool, list);
  }
  return queues;
};

const persistToolRunsFromResult = (
  result: unknown,
  options: {
    sessionId: string;
    threadId?: string;
    messageId?: string;
    attachments: ToolAttachment[];
    outputFileThreshold: number;
  },
) => {
  const parts = extractPartsFromPromptResult(result);
  const attachmentQueues = buildAttachmentQueues(options.attachments);
  let fallbackIndex = 0;
  for (const part of parts) {
    if (!isRecord(part)) continue;
    if (part.type !== "tool") continue;
    const toolName = typeof part.tool === "string" ? part.tool : "tool";
    if (toolName === "question") continue;
    const state = isRecord(part.state) ? part.state : undefined;
    if (!state) continue;
    const status = typeof state.status === "string" ? state.status : "unknown";
    const title = typeof state.title === "string" ? state.title : undefined;
    const input = state.input;
    const inputJson =
      typeof input === "string"
        ? input
        : input !== undefined
          ? JSON.stringify(input)
          : undefined;
    const outputText = typeof state.output === "string" ? state.output : undefined;
    const errorText = typeof state.error === "string" ? state.error : undefined;

    let outputFileName: string | undefined;
    let outputTruncated = false;
    if (outputText && outputText.length > options.outputFileThreshold) {
      const queue = attachmentQueues.get(toolName);
      if (queue && queue.length > 0) {
        outputFileName = queue.shift();
      }
      outputTruncated = true;
    }

    const partId = typeof part.id === "string"
      ? part.id
      : `${options.sessionId}-${toolName}-${fallbackIndex++}`;
    const messageId = typeof part.messageID === "string" ? part.messageID : options.messageId;

    upsertToolRun({
      partId,
      sessionId: options.sessionId,
      threadId: options.threadId,
      messageId,
      toolName,
      status,
      title,
      inputJson,
      outputText,
      errorText,
      outputTruncated,
      outputFileName,
    });
  }
};

const extractMessageIdFromPromptResult = (result: unknown): string | undefined => {
  if (!isRecord(result)) return undefined;
  const data = isRecord(result.data) ? result.data : undefined;
  const message = isRecord(data?.message) ? data.message : undefined;
  if (typeof message?.id === "string") return message.id;
  const messages = Array.isArray(data?.messages) ? data.messages : undefined;
  const firstMessage = isRecord(messages?.[0]) ? messages?.[0] : undefined;
  if (typeof firstMessage?.id === "string") return firstMessage.id;
  const resultData = isRecord(data?.result) ? data.result : undefined;
  const resultMessage = isRecord(resultData?.message) ? resultData.message : undefined;
  if (typeof resultMessage?.id === "string") return resultMessage.id;
  return undefined;
};

const persistMessagePartsFromResult = (
  result: unknown,
  options: { sessionId: string; messageId?: string },
) => {
  const parts = extractPartsFromPromptResult(result);
  if (parts.length === 0) return;
  const fallbackMessageId = options.messageId || extractMessageIdFromPromptResult(result);
  parts.forEach((part, orderIndex) => {
    if (!isRecord(part)) return;
    const type = typeof part.type === "string" ? part.type : "unknown";
    const messageId = typeof part.messageID === "string" ? part.messageID : fallbackMessageId;
    const partId = typeof part.id === "string"
      ? part.id
      : `${messageId || options.sessionId}-part-${orderIndex}`;
    const baseRecord = {
      partId,
      sessionId: options.sessionId,
      messageId,
      orderIndex,
      type,
      text: typeof part.text === "string" ? part.text : undefined,
      reasoning: typeof part.reasoning === "string" ? part.reasoning : undefined,
      subtaskDescription: typeof part.description === "string" ? part.description : undefined,
      subtaskPrompt: typeof part.prompt === "string" ? part.prompt : undefined,
      subtaskAgent: typeof part.agent === "string" ? part.agent : undefined,
    };

    if (type === "tool") {
      const toolName = typeof part.tool === "string" ? part.tool : "tool";
      const state = isRecord(part.state) ? part.state : undefined;
      const status = typeof state?.status === "string" ? state.status : undefined;
      const title = typeof state?.title === "string" ? state.title : undefined;
      const input = state?.input;
      const inputText =
        typeof input === "string"
          ? input
          : input !== undefined
            ? JSON.stringify(input)
            : undefined;
      const outputText = typeof state?.output === "string" ? state.output : undefined;
      const errorText = typeof state?.error === "string" ? state.error : undefined;
      const startedAt =
        isRecord(part.time) && typeof part.time.start === "number" ? part.time.start : undefined;
      const completedAt =
        isRecord(part.time) && typeof part.time.end === "number" ? part.time.end : undefined;

      upsertMessagePart({
        ...baseRecord,
        toolName,
        toolStatus: status,
        toolTitle: title,
        inputText,
        outputText,
        errorText,
        startedAt,
        completedAt,
      });
      return;
    }

    upsertMessagePart(baseRecord);
  });
};

export function parseModelString(
  model: string,
): { providerID: string; modelID: string } | null {
  const [providerID, ...modelParts] = model.split("/");
  const modelID = modelParts.join("/");
  if (!providerID || !modelID) return null;
  return { providerID, modelID };
}

function resolveAccessibleDirectory(
  channelId: string,
  projectDirectory: string,
  logger?: (message: string, level?: "debug" | "info" | "warn" | "error") => void,
): string {
  const channelDirectory = getChannelDirectory(channelId);
  if (!channelDirectory) return projectDirectory;

  try {
    fs.accessSync(channelDirectory, fs.constants.R_OK | fs.constants.X_OK);
    return channelDirectory;
  } catch {
    logWith(
      logger,
      `Channel directory not accessible: ${channelDirectory}. Falling back to ${projectDirectory}.`,
      "warn",
    );
    setChannelDirectory(channelId, projectDirectory);
    return projectDirectory;
  }
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
  requestId: string;
  questionIndex: number;
  title: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
  multiple?: boolean;
};

type QuestionInput = {
  question: string;
  header: string;
  options: Array<{ label: string; description?: string }>;
  multiple?: boolean;
};

type QuestionRequestSpec = {
  requestId: string;
  questions: QuestionInput[];
};

type PermissionRequestSpec = {
  requestId: string;
  permission: string;
  patterns: string[];
};

async function uploadToolAttachments(
  attachments: ToolAttachment[],
  provider: MessageProvider,
  message: IncomingMessage,
  logger?: (message: string, level?: "debug" | "info" | "warn" | "error") => void,
): Promise<void> {
  if (attachments.length === 0) return;
  if (provider.id !== "feishu") return;
  const client = provider.getFeishuClient?.();
  if (!client || typeof client.uploadTextFile !== "function" || typeof client.replyFileMessageWithId !== "function") {
    return;
  }
  const preferThread = Boolean(message.threadId);
  for (const attachment of attachments) {
    const fileKey = await client.uploadTextFile({
      content: attachment.content,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
    });
    if (!fileKey) {
      logWith(logger, `Upload tool output failed: ${attachment.fileName}`, "warn");
      await sendReply(
        provider,
        message,
        t("opencode.outputTooLong", { fileName: attachment.fileName }),
      );
      continue;
    }
    let messageId = await client.replyFileMessageWithId(message.messageId, fileKey, {
      replyInThread: preferThread,
    });
    if (!messageId && preferThread) {
      messageId = await client.replyFileMessageWithId(message.messageId, fileKey);
    }
    if (!messageId) {
      logWith(logger, `Reply file message failed: ${attachment.fileName}`, "warn");
    }
  }
}

function extractQuestionSpecs(result: unknown): QuestionSpec[] {
  const parts = extractPartsFromPromptResult(result);
  if (parts.length === 0) return [];

  const specs: QuestionSpec[] = [];
  let fallbackRequestIndex = 0;

  const normalizeQuestions = (value: unknown): Array<Record<string, unknown>> => {
    if (Array.isArray(value)) {
      return value.filter((item) => isRecord(item)) as Array<Record<string, unknown>>;
    }
    if (isRecord(value) && Array.isArray(value.questions)) {
      return value.questions.filter((item) => isRecord(item)) as Array<Record<string, unknown>>;
    }
    if (isRecord(value) && isRecord(value.input)) {
      const nested = value.input as Record<string, unknown>;
      if (Array.isArray(nested.questions)) {
        return nested.questions.filter((item) => isRecord(item)) as Array<Record<string, unknown>>;
      }
      if (typeof nested.question === "string") {
        return [nested];
      }
    }
    if (isRecord(value) && isRecord(value.data)) {
      const nested = value.data as Record<string, unknown>;
      if (Array.isArray(nested.questions)) {
        return nested.questions.filter((item) => isRecord(item)) as Array<Record<string, unknown>>;
      }
      if (typeof nested.question === "string") {
        return [nested];
      }
    }
    if (isRecord(value) && isRecord(value.question)) {
      return [value.question as Record<string, unknown>];
    }
    if (isRecord(value) && typeof value.question === "string") {
      return [value as Record<string, unknown>];
    }
    return [];
  };

  const normalizeOptions = (optionsRaw: unknown[]): Array<{ label: string; description?: string }> => {
    return optionsRaw
      .map((opt) => {
        if (typeof opt === "string") return { label: opt };
        if (!isRecord(opt)) return null;
        const label = typeof opt.label === "string" ? opt.label : "";
        if (!label) return null;
        const description = typeof opt.description === "string" ? opt.description : undefined;
        return description ? { label, description } : { label };
      })
      .filter((opt): opt is { label: string; description?: string } => Boolean(opt));
  };

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
    if (!isRecord(parsed) && !Array.isArray(parsed)) continue;
    const questions = normalizeQuestions(parsed);
    const parsedRecord = isRecord(parsed) ? parsed : undefined;
    let requestId =
      (parsedRecord && typeof parsedRecord.requestId === "string" && parsedRecord.requestId)
      || (parsedRecord && typeof parsedRecord.request_id === "string" && parsedRecord.request_id)
      || (parsedRecord && typeof parsedRecord.id === "string" && parsedRecord.id)
      || "";
    if (!requestId) {
      requestId = `q${fallbackRequestIndex++}`;
    }
    let localIndex = 0;
    for (const q of questions) {
      const question = typeof q.question === "string" ? q.question : "";
      const header = typeof q.header === "string" ? q.header : "";
      const optionsRaw = Array.isArray(q.options) ? q.options : [];
      const options = normalizeOptions(optionsRaw);
      if (!question || options.length === 0) continue;
      const multiple = typeof q.multiple === "boolean" ? q.multiple : undefined;
      specs.push({
        requestId,
        questionIndex: localIndex,
        title: header || t("opencode.questionTitleDefault"),
        question,
        options,
        multiple,
      });
      localIndex += 1;
    }
  }

  return specs;
}

function normalizeQuestionInputs(raw: unknown): QuestionRequestSpec | null {
  if (!isRecord(raw)) return null;
  const requestId = typeof raw.id === "string" ? raw.id : "";
  if (!requestId) return null;
  const questionsRaw = Array.isArray(raw.questions) ? raw.questions : [];
  const questions: QuestionInput[] = [];
  for (const entry of questionsRaw) {
    if (!isRecord(entry)) continue;
    const question = typeof entry.question === "string" ? entry.question : "";
    if (!question) continue;
    const header = typeof entry.header === "string" ? entry.header : "";
    const optionsRaw = Array.isArray(entry.options) ? entry.options : [];
    const options = optionsRaw
      .map((opt) => {
        if (typeof opt === "string") return { label: opt };
        if (!isRecord(opt)) return null;
        const label = typeof opt.label === "string" ? opt.label : "";
        if (!label) return null;
        const description = typeof opt.description === "string" ? opt.description : undefined;
        return description ? { label, description } : { label };
      })
      .filter((opt): opt is { label: string; description?: string } => Boolean(opt));
    if (options.length === 0) continue;
    const multiple = typeof entry.multiple === "boolean" ? entry.multiple : undefined;
    questions.push({
      question,
      header: header || t("opencode.questionTitleDefault"),
      options,
      multiple,
    });
  }
  if (questions.length === 0) return null;
  return { requestId, questions };
}

function normalizePermissionRequest(raw: unknown): PermissionRequestSpec | null {
  if (!isRecord(raw)) return null;
  const requestId = typeof raw.id === "string" ? raw.id : "";
  const permission = typeof raw.permission === "string" ? raw.permission : "";
  const patterns = Array.isArray(raw.patterns)
    ? raw.patterns.filter((item) => typeof item === "string") as string[]
    : [];
  if (!requestId || !permission) return null;
  return { requestId, permission, patterns };
}

function buildPermissionDedupeKey(
  permission: PermissionRequestSpec,
  directory: string,
): string {
  const normalized = [...permission.patterns].sort((a, b) => a.localeCompare(b));
  return `${directory}::${permission.permission}::${normalized.join("|")}`;
}

async function sendPermissionCard(
  permission: PermissionRequestSpec,
  options: {
    provider: MessageProvider;
    message: IncomingMessage;
    logger?: (message: string, level?: "debug" | "info" | "warn" | "error") => void;
  },
): Promise<string | null> {
  const feishuClient = options.provider.getFeishuClient?.();
  if (!feishuClient || typeof feishuClient.replyPermissionCardWithId !== "function") {
    logWith(options.logger, "Permission card skipped: provider has no card sender", "debug");
    return null;
  }
  const replyInThread = Boolean(options.message.threadId);
  const messageId = await feishuClient.replyPermissionCardWithId(
    options.message.messageId,
    {
      requestId: permission.requestId,
      permission: permission.permission,
      patterns: permission.patterns,
    },
    { replyInThread },
  );
  if (!messageId) {
    logWith(options.logger, `Permission card send failed id=${permission.requestId}`, "warn");
  }
  return messageId;
}

function registerPendingQuestion(
  request: QuestionRequestSpec,
  options: { sessionId: string; directory: string; threadId?: string; logger?: (message: string, level?: "debug" | "info" | "warn" | "error") => void },
) {
  if (pendingQuestions.has(request.requestId)) {
    logWith(options.logger, `Question request already pending id=${request.requestId}`, "debug");
  }
  pendingQuestions.set(request.requestId, {
    requestId: request.requestId,
    sessionId: options.sessionId,
    directory: options.directory,
    currentIndex: 0,
    questions: request.questions,
    answers: {},
    answeredIndices: new Set<number>(),
  });

  upsertQuestionRequest({
    requestId: request.requestId,
    sessionId: options.sessionId,
    directory: options.directory,
    threadId: options.threadId || "",
    questions: request.questions,
  });
}

async function sendQuestionCardsFromRequest(
  request: QuestionRequestSpec,
  options: {
    provider: MessageProvider;
    message: IncomingMessage;
    logger?: (message: string, level?: "debug" | "info" | "warn" | "error") => void;
  },
): Promise<string | null> {
  const feishuClient = options.provider.getFeishuClient?.();
  if (!feishuClient || typeof feishuClient.replyQuestionCardWithId !== "function") {
    logWith(options.logger, "Question card skipped: provider has no card sender", "debug");
    return null;
  }

  const replyInThread = Boolean(options.message.threadId);
  const question = request.questions[0];
  if (!question) return null;
  logWith(
    options.logger,
    `Sending question card id=${request.requestId} index=0 options=${question.options.length}`,
    "debug",
  );
  const messageId = await feishuClient.replyQuestionCardWithId(
    options.message.messageId,
    {
      title: question.header || t("opencode.questionTitleDefault"),
      questionId: request.requestId,
      questionText: question.question,
      options: question.options,
      questionIndex: 0,
      totalQuestions: request.questions.length,
      selectedLabels: [],
      nextLabel: request.questions.length <= 1
        ? t("opencode.submitLabelDefault")
        : t("opencode.nextLabelDefault"),
    },
    { replyInThread },
  );
  if (!messageId) {
    logWith(options.logger, `Question card send failed id=${request.requestId}`, "warn");
  }
  if (messageId) {
    updateQuestionRequestCard(request.requestId, messageId);
  }
  return messageId;
}

async function sendQuestionCards(
  response: unknown,
  options: {
    provider: MessageProvider;
    message: IncomingMessage;
    logger?: (message: string, level?: "debug" | "info" | "warn" | "error") => void;
    sessionId?: string;
    directory?: string;
  },
): Promise<boolean> {
  const specs = extractQuestionSpecs(response);
  logWith(
    options.logger,
    `Question cards: parse attempt specs=${specs.length}`,
    "debug",
  );
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
    const toolSnapshots = toolParts.map((part) => {
      const name = typeof part.tool === "string" ? part.tool : "unknown";
      const state = isRecord(part.state) ? part.state : undefined;
      if (!state) return `[${name}:missing-state]`;
      const status =
        typeof (state as Record<string, unknown>).status === "string"
          ? (state as Record<string, unknown>).status
          : "unknown";
      const input =
        typeof (state as Record<string, unknown>).input !== "undefined"
          ? (state as Record<string, unknown>).input
          : (state as Record<string, unknown>).output;
      return `${name}:${status}:${formatValue(input)}`;
    });
    logWith(
      options.logger,
      `Question cards: no specs parsed; parts=${parts.length} tools=[${toolNames}] questionParts=${questionParts.length} details=${questionSnapshots.join(" | ")}`,
      "debug",
    );
    logWith(
      options.logger,
      `Question cards: tool snapshots ${toolSnapshots.join(" | ")}`,
      "debug",
    );
    return false;
  }
  logWith(options.logger, `Question cards: ${specs.length} questions parsed`, "debug");
  const grouped = new Map<string, QuestionInput[]>();
  for (const spec of specs) {
    if (!grouped.has(spec.requestId)) grouped.set(spec.requestId, []);
    const list = grouped.get(spec.requestId);
    if (!list) continue;
    list[spec.questionIndex] = {
      question: spec.question,
      header: spec.title,
      options: spec.options,
      multiple: spec.multiple,
    };
  }
  let sent = false;
  if (options.sessionId && options.directory) {
    for (const [requestId, questions] of grouped) {
      registerPendingQuestion(
        { requestId, questions },
        {
          sessionId: options.sessionId,
          directory: options.directory,
          threadId: options.message.threadId,
          logger: options.logger,
        },
      );
      const messageId = await sendQuestionCardsFromRequest(
        { requestId, questions },
        {
          provider: options.provider,
          message: options.message,
          logger: options.logger,
        },
      );
      const pending = pendingQuestions.get(requestId);
      if (pending && messageId) {
        pending.cardMessageId = messageId;
        sent = true;
      }
    }
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
  userId: string,
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
        if (!getThreadSessionUser(threadId)) {
          setThreadSession(threadId, existingSessionId, userId);
        }
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
    body: { title: sessionTitle || t("opencode.sessionTitleDefault") },
    query: { directory },
  });
  if (!sessionResponse.data?.id) {
    throw new Error(t("opencode.createSessionFailed"));
  }

  setThreadSession(threadId, sessionResponse.data.id, userId);
  return sessionResponse.data.id;
}

export async function sendPrompt({
  message,
  provider,
  projectDirectory,
  logger,
  opencodeConfig,
  streaming,
  toolOutputFileThreshold,
}: {
  message: IncomingMessage;
  provider: MessageProvider;
  projectDirectory: string;
  logger?: (message: string, level?: "debug" | "info" | "warn" | "error") => void;
  opencodeConfig?: Config;
  streaming?: StreamingConfig;
  toolOutputFileThreshold?: number;
}): Promise<void> {
  const workspaceDirectory = resolveWorkspaceDirectory(message.channelId, logger);
  const directory = workspaceDirectory || resolveAccessibleDirectory(
    message.channelId,
    projectDirectory,
    logger,
  );
  if (!workspaceDirectory) {
    setChannelDirectory(message.channelId, directory);
  }

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
    message.userId,
    directory,
    message.text,
    logger,
  );

  const existing = activeRequests.get(message.threadId);
  if (existing && existing.sessionId === sessionId) {
    existing.controller.abort(new Error(t("opencode.newRequestStarted")));
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
    let streamingEnabled = false;
    let streamTimeoutGraceMs = 900000;
    let deferStreamStop = false;
    let questionAsked = false;

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
        t("opencode.providerMissing"),
      );
      return;
    }

    const parts = [{ type: "text" as const, text: message.text }];
    const promptStartedAt = Date.now();
    const streamingConfig = streaming || {};
    streamingEnabled =
      streamingConfig.enabled === true &&
      provider.id === "feishu" &&
      typeof provider.updateMessage === "function";
    streamTimeoutGraceMs =
      typeof streamingConfig.timeoutGraceMs === "number"
        ? streamingConfig.timeoutGraceMs
        : 900000;

    try {
      if (streamingEnabled) {
        streamSink = createFeishuStreamSink({
          provider,
          message,
          throttleMs: streamingConfig.throttleMs ?? 700,
          maxMessageChars: streamingConfig.maxMessageChars ?? 20000,
          mode: streamingConfig.mode ?? "update",
          logger,
        });

        const placeholder = await streamSink.start();
        activeStreams.set(message.threadId, {
          placeholderId: placeholder.messageId,
          cardId: placeholder.cardId,
          elementId: placeholder.elementId,
        });
      }

      streamController = await createStreamingController({
        directory,
        sessionId,
        threadId: message.threadId,
        abortSignal: controller.signal,
        startedAt: promptStartedAt,
        onTextUpdate: streamingEnabled
          ? async (text) => {
              if (!streamSink) return;
              await streamSink.render(text);
            }
          : undefined,
        onQuestionAsked: async (questionRequest) => {
          const normalized = normalizeQuestionInputs(questionRequest);
          if (!normalized) {
            logWith(logger, "Question cards: unable to parse question.asked payload", "debug");
            return;
          }
          questionAsked = true;
          if (streamSink && typeof streamSink.detach === "function") {
            streamSink.detach();
          }
          streamSink = null;
          registerPendingQuestion(normalized, {
            sessionId,
            directory,
            threadId: message.threadId,
            logger,
          });
          const messageId = await sendQuestionCardsFromRequest(normalized, { provider, message, logger });
          const pending = pendingQuestions.get(normalized.requestId);
          if (pending && messageId) {
            pending.cardMessageId = messageId;
          }
        },
        onPermissionAsked: async (permissionRequest) => {
          const normalized = normalizePermissionRequest(permissionRequest);
          if (!normalized) {
            logWith(logger, "Permission request ignored: invalid payload", "debug");
            return;
          }
          if (streamSink && typeof streamSink.detach === "function") {
            streamSink.detach();
          }
          const dedupeKey = buildPermissionDedupeKey(normalized, directory);
          const existing = Array.from(pendingPermissions.values()).find(
            (pending) => pending.dedupeKey === dedupeKey,
          );
          if (existing) {
            if (!existing.requestIds.includes(normalized.requestId)) {
              existing.requestIds.push(normalized.requestId);
            }
            pendingPermissions.set(normalized.requestId, existing);
            logWith(logger, `Permission deduped id=${normalized.requestId}`, "debug");
            return;
          }

          const messageId = await sendPermissionCard(normalized, { provider, message, logger });
          if (!messageId) return;
          const pending = {
            requestIds: [normalized.requestId],
            directory,
            threadId: message.threadId,
            messageId,
            dedupeKey,
            permission: normalized.permission,
            patterns: normalized.patterns,
          };
          pendingPermissions.set(normalized.requestId, pending);
        },
        onAssistantMessageSwitch: streamingEnabled
          ? async () => {
              if (!streamSink) return;
              streamSink.detach();
              streamSink = createFeishuStreamSink({
                provider,
                message,
                throttleMs: streamingConfig.throttleMs ?? 700,
                maxMessageChars: streamingConfig.maxMessageChars ?? 20000,
                mode: streamingConfig.mode ?? "update",
                logger,
              });
              const placeholder = await streamSink.start();
              activeStreams.set(message.threadId, {
                placeholderId: placeholder.messageId,
                cardId: placeholder.cardId,
                elementId: placeholder.elementId,
              });
            }
          : undefined,
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

    const feishuClient = provider.id === "feishu" ? provider.getFeishuClient?.() : null;
    const supportsFileUpload =
      provider.id === "feishu" &&
      feishuClient &&
      typeof feishuClient.uploadTextFile === "function" &&
      typeof feishuClient.replyFileMessageWithId === "function";
    const toolThreshold =
      typeof toolOutputFileThreshold === "number" ? toolOutputFileThreshold : 8000;
    const { text: replyText, attachments } = supportsFileUpload
      ? extractTextWithAttachmentsFromPromptResult(response, {
        maxInlineChars: toolThreshold,
        attachmentTools: ["bash"],
      })
      : { text: extractTextFromPromptResult(response), attachments: [] };
    persistMessagePartsFromResult(response, {
      sessionId,
      messageId: message.messageId,
    });
    persistToolRunsFromResult(response, {
      sessionId,
      threadId: message.threadId,
      messageId: message.messageId,
      attachments,
      outputFileThreshold: toolThreshold,
    });
    if (!questionAsked) {
      await sendQuestionCards(response, {
        provider,
        message,
        logger,
        sessionId,
        directory,
      });
    }
    const footer = await buildFooter(response, {
      sessionId,
      model: modelParam,
      directory,
      startedAt: promptStartedAt,
      getClient,
    });

    await uploadToolAttachments(attachments, provider, message, logger);
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
    const isPromptHeadersTimeout =
      isHeadersTimeout(cause) || described.summary.includes("HeadersTimeoutError");
    if (isPromptHeadersTimeout) {
      logWith(
        logger,
        t("opencode.requestTimeout"),
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

    const shouldDeferStreamStop =
      streamingEnabled &&
      Boolean(streamController) &&
      Boolean(streamSink) &&
      isPromptHeadersTimeout;

    if (shouldDeferStreamStop) {
      deferStreamStop = true;
      const graceMs = Math.max(0, Math.min(streamTimeoutGraceMs, 900000));
      logWith(
        logger,
        `Prompt failed; keep streaming for ${graceMs}ms before failing session=${sessionId} directory=${directory}`,
        "warn",
      );
      setTimeout(() => {
        void (async () => {
          streamController?.stop();
          if (streamSink) {
            await streamSink.fail(t("opencode.requestTimeout"));
          }
          activeStreams.delete(message.threadId);
        })();
      }, graceMs);
    } else {
      if (streamController) {
        streamController.stop();
      }
      if (streamSink) {
        await streamSink.fail(toUserErrorMessage(error));
      }
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
    if (!deferStreamStop) {
      if (streamController) {
        streamController.stop();
      }
      activeStreams.delete(message.threadId);
    }
  }
}
