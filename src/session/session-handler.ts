import type { Config } from "@opencode-ai/sdk";
import {
  deleteQuestionRequest,
  getChannelDirectory,
  getQuestionRequest,
  getThreadMentionRequired,
  getThreadSessionUser,
  isUserInWhitelist,
} from "../database.js";
import { getOpencodeClientV2 } from "../opencode.js";
import type { StreamingConfig } from "../providers/feishu/feishu-config.js";
import type { IncomingMessage, MessageProvider } from "../types.js";
import { t } from "../i18n/index.js";
import { handleCardAction, handleUserNotWhitelisted } from "./approval.js";
import { handleCommand, parseCommand } from "./commands/index.js";
import { isBotMentioned } from "./commands/shared.js";
import { sendReply } from "./messaging.js";
import { sendPrompt } from "./opencode.js";
import { flushQueue } from "./queue.js";
import {
  activeRequests,
  messageQueue,
  pendingPermissions,
  pendingQuestions,
} from "./state.js";
import type { PendingQuestion } from "./state.js";
import { ensureWorkspaceBound, handleWorkspaceAction } from "./workspace.js";
import { buildFailureReport, describeError, logWith, toUserErrorMessage } from "./utils.js";

export type SessionHandlerOptions = {
  provider: MessageProvider;
  projectDirectory: string;
  logger?: (
    message: string,
    level?: "debug" | "info" | "warn" | "error",
  ) => void;
  opencodeConfig?: Config;
  streaming?: StreamingConfig;
  toolOutputFileThreshold?: number;
  requireUserWhitelist?: boolean;
  adminUserIds?: string[];
  adminChatId?: string;
  sendApprovalCard?: (
    adminChatId: string,
    params: {
      requestId: string;
      channelId: string;
      userId: string;
      userName?: string;
    },
  ) => Promise<string | null>;
  sendApprovalCardInThread?: (
    messageId: string,
    params: {
      requestId: string;
      channelId: string;
      userId: string;
      userName?: string;
    },
  ) => Promise<string | null>;
  updateApprovalCard?: (
    messageId: string,
    status: "approved" | "rejected",
    actionBy: string,
  ) => Promise<boolean>;
  isCardAction?: boolean;
  cardActionData?: {
    action: "approve" | "reject";
    requestId: string;
  };
  questionResponse?: {
    questionId: string;
    answerLabel: string;
    questionIndex?: number;
  };
  questionNav?: {
    questionId: string;
    questionIndex?: number;
    direction: "next" | "prev";
  };
  permissionResponse?: {
    requestId: string;
    reply: "once" | "always" | "reject";
  };
  workspaceAction?: {
    action: "bind" | "bind-approve" | "bind-reject" | "join-approve" | "join-reject";
    workspaceName?: string;
    requestId?: string;
  };
  botUserId?: string;
};

export async function handleIncomingMessage(
  message: IncomingMessage,
  options: SessionHandlerOptions,
): Promise<void> {
  if (
    options.isCardAction
    && !options.questionResponse
    && !options.questionNav
    && !options.permissionResponse
    && !options.workspaceAction
  ) {
    await handleCardAction(message, options);
    return;
  }

  if (options.workspaceAction) {
    await handleWorkspaceAction(message, options, options.workspaceAction);
    return;
  }

  if (options.requireUserWhitelist && !isUserInWhitelist(message.channelId, message.userId)) {
    await handleUserNotWhitelisted(message, options);
    return;
  }

  const command = parseCommand(message.text);
  if (command) {
    const allowedWithoutWorkspace = new Set([
      "help",
      "model",
      "agent",
      "channel-model",
      "mention-required",
      "compact",
      "workspace",
      "workspaces",
    ]);
    if (allowedWithoutWorkspace.has(command.name)) {
      const handled = await handleCommand(message, command, options);
      if (handled) {
        return;
      }
    }
  }

  const isQuestionResponse = Boolean(options.questionResponse || options.questionNav);
  const isInteractiveResponse = isQuestionResponse || Boolean(options.permissionResponse);
  const mentionRequired = options.botUserId
    ? (getThreadMentionRequired(message.threadId) ?? false)
    : false;
  const isThreadReply =
    Boolean(message.threadId) &&
    Boolean(message.messageId) &&
    message.threadId !== message.messageId;
  if (!isInteractiveResponse) {
    if (!isThreadReply) {
      if (!isBotMentioned(message, options.botUserId)) {
        return;
      }
    } else if (mentionRequired && !isBotMentioned(message, options.botUserId)) {
      return;
    }
  }

  if (await ensureWorkspaceBound(message, options)) {
    return;
  }

  const updateQuestionCard = async (pending: PendingQuestion, messageId: string, completed = false) => {
    const feishuClient = options.provider.getFeishuClient?.();
    if (!feishuClient || typeof feishuClient.updateQuestionCardWithId !== "function") {
      logWith(options.logger, "Question card update skipped: provider has no card updater", "debug");
      return;
    }
    const current = pending.questions[pending.currentIndex];
    if (!current) return;
    const total = pending.questions.length;
    const selected = pending.answers[pending.currentIndex] || [];
    const canSubmit = pending.answeredIndices.size >= total;
    const nextLabel = pending.currentIndex + 1 >= total
      ? (canSubmit ? t("common.submit") : t("common.incomplete"))
      : t("common.next");
    await feishuClient.updateQuestionCardWithId(messageId, {
      title: current.header || t("common.choose"),
      questionId: pending.requestId,
      questionText: current.question,
      options: current.options,
      questionIndex: pending.currentIndex,
      totalQuestions: total,
      selectedLabels: selected,
      nextLabel,
      completed,
    });
  };

  if (options.permissionResponse) {
    const { requestId, reply } = options.permissionResponse;
    const pending = pendingPermissions.get(requestId);
    if (!pending) {
      logWith(options.logger, `Permission response ignored: missing pending request ${requestId}`, "warn");
      return;
    }

    const clientV2 = getOpencodeClientV2(pending.directory);
    if (!clientV2) {
      logWith(options.logger, `Permission reply failed: no OpenCode client for ${pending.directory}`, "error");
      return;
    }

    try {
      await Promise.all(
        pending.requestIds.map((id) =>
          clientV2.permission.reply({ requestID: id, reply }),
        ),
      );
      for (const id of pending.requestIds) {
        pendingPermissions.delete(id);
      }
      const feishuClient = options.provider.getFeishuClient?.();
      if (feishuClient && typeof feishuClient.updatePermissionCardWithId === "function") {
        await feishuClient.updatePermissionCardWithId(pending.messageId, {
          requestId,
          permission: pending.permission,
          patterns: pending.patterns,
          status: reply === "reject" ? "rejected" : "approved",
          replyLabel: reply,
        });
      }
      logWith(options.logger, `Permission reply submitted ${requestId} (${reply})`, "info");
    } catch (error) {
      const described = describeError(error);
      logWith(options.logger, `Permission reply failed ${requestId}: ${described.summary}`, "error");
    }
    return;
  }

  if (options.questionResponse || options.questionNav) {
    const questionId = options.questionResponse?.questionId || options.questionNav?.questionId;
    let pending = questionId ? pendingQuestions.get(questionId) : undefined;
    if (!pending && questionId) {
      const stored = getQuestionRequest(questionId);
      if (stored) {
        pending = {
          requestId: stored.requestId,
          sessionId: stored.sessionId,
          directory: stored.directory,
          cardMessageId: stored.cardMessageId,
          currentIndex: 0,
          questions: stored.questions,
          answers: {},
          answeredIndices: new Set<number>(),
        };
        pendingQuestions.set(questionId, pending);
        logWith(options.logger, `Question state restored ${questionId}`, "info");
      }
    }
    if (!pending) {
      logWith(options.logger, `Question action ignored: missing pending request ${questionId}`, "warn");
      return;
    }

    const cardMessageId = pending.cardMessageId || message.messageId;
    if (!pending.cardMessageId && message.messageId) {
      pending.cardMessageId = message.messageId;
    }

    const total = pending.questions.length;

    let submitNow = false;

    if (options.questionResponse) {
      const { answerLabel, questionIndex } = options.questionResponse;
      const resolvedIndex =
        typeof questionIndex === "number" && !Number.isNaN(questionIndex)
          ? questionIndex
          : pending.currentIndex;
      if (resolvedIndex < 0 || resolvedIndex >= total) {
        logWith(options.logger, `Question response ignored: invalid index for ${questionId}`, "warn");
        return;
      }

      pending.answers[resolvedIndex] = [answerLabel];
      pending.answeredIndices.add(resolvedIndex);

      if (total === 1) {
        submitNow = true;
      }
      pending.currentIndex = Math.min(resolvedIndex + 1, total - 1);
    }

    if (options.questionNav) {
      const { direction, questionIndex } = options.questionNav;
      const resolvedIndex =
        typeof questionIndex === "number" && !Number.isNaN(questionIndex)
          ? questionIndex
          : pending.currentIndex;
      if (direction === "prev") {
        pending.currentIndex = Math.max(0, resolvedIndex - 1);
      } else if (direction === "next") {
        if (resolvedIndex + 1 < total) {
          pending.currentIndex = resolvedIndex + 1;
        } else {
          pending.currentIndex = resolvedIndex;
          submitNow = true;
        }
      }
    }

    const completed = pending.answeredIndices.size >= total && submitNow;
    if (completed) {
      const clientV2 = getOpencodeClientV2(pending.directory);
      if (!clientV2) {
        logWith(options.logger, `Question reply failed: no OpenCode client for ${pending.directory}`, "error");
        return;
      }
      const answers = pending.questions.map((_, idx) => pending.answers[idx] || []);
      try {
        await clientV2.question.reply({
          requestID: pending.requestId,
          answers,
        });
        if (questionId) {
          pendingQuestions.delete(questionId);
          deleteQuestionRequest(questionId);
        }
        await updateQuestionCard(pending, cardMessageId, true);
        logWith(options.logger, `Question reply submitted ${questionId}`, "info");
      } catch (error) {
        const described = describeError(error);
        logWith(options.logger, `Question reply failed ${questionId}: ${described.summary}`, "error");
      }
      return;
    }

    await updateQuestionCard(pending, cardMessageId, false);
    logWith(
      options.logger,
      `Question action handled ${questionId}: ${pending.answeredIndices.size}/${total} current=${pending.currentIndex + 1}`,
      "debug",
    );
    return;
  }

  const boundUserId = getThreadSessionUser(message.threadId);
  if (boundUserId && boundUserId !== message.userId) {
    logWith(
      options.logger,
      `Message ignored: thread=${message.threadId} boundUser=${boundUserId} user=${message.userId}`,
      "debug",
    );
    return;
  }

  const commandAfterBinding = command ?? parseCommand(message.text);
  if (command && command.name === "mention-required") {
    const handled = await handleCommand(message, command, options);
    if (handled) {
      return;
    }
  }

  if (commandAfterBinding) {
    const handled = await handleCommand(message, commandAfterBinding, options);
    if (handled) {
      return;
    }
  }

  const queue = messageQueue.get(message.threadId);
  const active = activeRequests.get(message.threadId);
  if (active) {
    const nextQueue = queue || [];
    nextQueue.push({ message, queuedAt: Date.now() });
    messageQueue.set(message.threadId, nextQueue);
    logWith(
      options.logger,
      `Queue enqueue thread=${message.threadId} message=${message.messageId || "-"} size=${nextQueue.length}`,
      "info",
    );
    await sendReply(
      options.provider,
      message,
      `⏳ Queued (${nextQueue.length} pending)`,
    );
    return;
  }

  try {
    const streamingOverride = isQuestionResponse
      ? { enabled: false }
      : options.streaming;
    await sendPrompt({
      message,
      provider: options.provider,
      projectDirectory: options.projectDirectory,
      logger: options.logger,
      opencodeConfig: options.opencodeConfig,
      streaming: streamingOverride,
      toolOutputFileThreshold: options.toolOutputFileThreshold,
    });
  } catch (error) {
    const described = describeError(error);
    logWith(
      options.logger,
      `Unhandled error for thread=${message.threadId}; ${described.summary}`,
      "error",
    );
    if (described.stack) {
      logWith(options.logger, described.stack, "debug");
    }

    const directory =
      getChannelDirectory(message.channelId) || options.projectDirectory;
    const report = buildFailureReport({
      operation: "handler.unhandled",
      directory,
      threadId: message.threadId,
      error,
    });
    const errorMessage = toUserErrorMessage(error) || t("common.unknownError");
    await sendReply(options.provider, message, `✗ ${errorMessage}\n\n${report}`);
  } finally {
    await flushQueue(message.threadId, (nextMessage) =>
      sendPrompt({
        message: nextMessage,
        provider: options.provider,
        projectDirectory: options.projectDirectory,
        logger: options.logger,
        opencodeConfig: options.opencodeConfig,
        streaming: options.streaming,
        toolOutputFileThreshold: options.toolOutputFileThreshold,
      }),
      options.logger,
    );
  }
}
