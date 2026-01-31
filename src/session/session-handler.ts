import type { Config } from "@opencode-ai/sdk";
import type { IncomingMessage, MessageProvider } from "../types.js";
import { getChannelDirectory, getThreadMentionRequired, isUserInWhitelist } from "../database.js";
import { handleCardAction, handleUserNotWhitelisted } from "./approval.js";
import { parseCommand, handleCommand, isBotMentioned } from "./commands.js";
import { flushQueue } from "./queue.js";
import { sendPrompt } from "./opencode.js";
import { activeRequests, messageQueue } from "./state.js";
import { buildFailureReport, describeError, logWith, toUserErrorMessage } from "./utils.js";
import { sendReply } from "./messaging.js";
import type { StreamingConfig } from "../providers/feishu/feishu-config.js";

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

  const isQuestionResponse = Boolean(options.questionResponse);
  if (options.questionResponse) {
    message.text = options.questionResponse.answerLabel;
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
