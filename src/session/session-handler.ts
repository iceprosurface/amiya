import type { Config } from "@opencode-ai/sdk";
import type { IncomingMessage, MessageProvider } from "../types.js";
import { getChannelDirectory, getThreadMentionRequired, isUserInWhitelist } from "../database.js";
import { handleCardAction, handleUserNotWhitelisted } from "./approval.js";
import { parseCommand, handleCommand, isBotMentioned } from "./commands.js";
import { flushQueue } from "./queue.js";
import { sendPrompt } from "./opencode.js";
import { activeRequests, messageQueue, pendingQuestions } from "./state.js";
import type { PendingQuestion } from "./state.js";
import { buildFailureReport, describeError, logWith, toUserErrorMessage } from "./utils.js";
import { sendReply } from "./messaging.js";
import type { StreamingConfig } from "../providers/feishu/feishu-config.js";
import { getOpencodeClientV2 } from "../opencode.js";

export type SessionHandlerOptions = {
  provider: MessageProvider;
  projectDirectory: string;
  logger?: (
    message: string,
    level?: "debug" | "info" | "warn" | "error",
  ) => void;
  opencodeConfig?: Config;
  streaming?: StreamingConfig;
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
  botUserId?: string;
};

export async function handleIncomingMessage(
  message: IncomingMessage,
  options: SessionHandlerOptions,
): Promise<void> {
  if (options.isCardAction && !options.questionResponse) {
    await handleCardAction(message, options);
    return;
  }

  if (options.requireUserWhitelist && !isUserInWhitelist(message.channelId, message.userId)) {
    await handleUserNotWhitelisted(message, options);
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
      ? (canSubmit ? "提交" : "未完成")
      : "下一步";
    await feishuClient.updateQuestionCardWithId(messageId, {
      title: current.header || "请选择",
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

  const isQuestionResponse = Boolean(options.questionResponse || options.questionNav);
  if (options.questionResponse || options.questionNav) {
    const questionId = options.questionResponse?.questionId || options.questionNav?.questionId;
    const pending = questionId ? pendingQuestions.get(questionId) : undefined;
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
        pendingQuestions.delete(questionId!);
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

  const command = parseCommand(message.text);
  if (command && command.name === "mention-required") {
    const handled = await handleCommand(message, command, options);
    if (handled) {
      return;
    }
  }

  const mentionRequired = options.botUserId
    ? (getThreadMentionRequired(message.threadId) ?? true)
    : false;
  const isThreadReply =
    Boolean(message.threadId) &&
    Boolean(message.messageId) &&
    message.threadId !== message.messageId;
  if (!isQuestionResponse && mentionRequired && !isThreadReply && !isBotMentioned(message, options.botUserId)) {
    return;
  }

  if (command) {
    const handled = await handleCommand(message, command, options);
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
    await sendReply(
      options.provider,
      message,
      `⏳ Queued (${nextQueue.length} pending)`,
    );
    return;
  }

  try {
    await sendPrompt({
      message,
      provider: options.provider,
      projectDirectory: options.projectDirectory,
      logger: options.logger,
      opencodeConfig: options.opencodeConfig,
      streaming: options.streaming,
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
    const errorMessage = toUserErrorMessage(error) || "未知错误";
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
      }),
    );
  }
}
