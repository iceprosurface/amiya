import type { IncomingMessage } from "../types.js";
import type { SessionHandlerOptions } from "./session-handler.js";
import {
  createApprovalRequest,
  getApprovalRequest,
  approveRequest,
  rejectRequest,
} from "../database.js";
import { t } from "../i18n/index.js";
import { sendReply } from "./messaging.js";
import { logWith } from "./utils.js";

export async function handleUserNotWhitelisted(
  message: IncomingMessage,
  options: SessionHandlerOptions,
): Promise<void> {
  const canSendCardInThread = Boolean(options.sendApprovalCardInThread && options.adminUserIds);
  const canSendCardToAdminChat = Boolean(
    options.sendApprovalCard && options.adminChatId && options.adminUserIds,
  );

  if (!canSendCardInThread && !canSendCardToAdminChat) {
    await sendReply(
      options.provider,
      message,
      t("approval.notAllowed"),
    );
    return;
  }

  const requestId = `req_${message.channelId}_${message.userId}_${Date.now()}`;
  const cardParams = {
    requestId,
    channelId: message.channelId,
    userId: message.userId,
    userName: message.userName,
  };
  let cardMessageId: string | null = null;

  if (canSendCardInThread && options.sendApprovalCardInThread) {
    cardMessageId = await options.sendApprovalCardInThread(message.messageId, cardParams);
  }
  if (!cardMessageId && canSendCardToAdminChat && options.sendApprovalCard && options.adminChatId) {
    cardMessageId = await options.sendApprovalCard(options.adminChatId, cardParams);
  }

  if (!cardMessageId) {
    await sendReply(options.provider, message, t("approval.submitFailed"));
    return;
  }

  createApprovalRequest({
    requestId,
    channelId: message.channelId,
    userId: message.userId,
    userName: message.userName,
    cardMessageId,
    adminChatId: options.adminChatId ?? message.channelId,
  });

  await sendReply(
    options.provider,
    message,
    t("approval.submitted"),
  );
}

export async function handleCardAction(
  message: IncomingMessage,
  options: SessionHandlerOptions,
): Promise<void> {
  const { adminUserIds, updateApprovalCard, cardActionData } = options;

  if (!cardActionData) {
    await sendReply(options.provider, message, t("approval.invalidAction"));
    return;
  }

  if (!adminUserIds || !adminUserIds.includes(message.userId)) {
    logWith(
      options.logger,
      `Non-admin user ${message.userId} attempted card action for request ${cardActionData.requestId}`,
      "warn",
    );
    await sendReply(options.provider, message, t("approval.adminOnly"));
    return;
  }

  const request = getApprovalRequest(cardActionData.requestId);
  if (!request) {
    await sendReply(options.provider, message, t("approval.requestMissing"));
    return;
  }

  if (request.status !== "pending") {
    await sendReply(
      options.provider,
      message,
      t("approval.requestHandled", { status: request.status }),
    );
    return;
  }

  const actionBy = message.userId;

  if (cardActionData.action === "approve") {
    approveRequest(cardActionData.requestId, actionBy);
    logWith(options.logger, `Request ${cardActionData.requestId} approved by ${actionBy}`, "info");
  } else {
    rejectRequest(cardActionData.requestId, actionBy);
    logWith(options.logger, `Request ${cardActionData.requestId} rejected by ${actionBy}`, "info");
  }

  if (updateApprovalCard) {
    const status = cardActionData.action === "approve" ? "approved" : "rejected";
    await updateApprovalCard(request.card_message_id, status, actionBy);
  }

  const notifyText =
    cardActionData.action === "approve"
      ? t("approval.approved", { userId: request.user_id })
      : t("approval.rejected", { userId: request.user_id });

  if (request.admin_chat_id) {
    await options.provider.sendMessage({ channelId: request.admin_chat_id }, { text: notifyText });
    return;
  }

  if (message.channelId) {
    await options.provider.sendMessage({ channelId: message.channelId }, { text: notifyText });
  }
}
