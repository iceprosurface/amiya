import type { IncomingMessage } from "../types.js";
import type { SessionHandlerOptions } from "./session-handler.js";
import {
  createApprovalRequest,
  getApprovalRequest,
  approveRequest,
  rejectRequest,
} from "../database.js";
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
      "❌ 您暂无此频道的访问权限，请联系管理员。",
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
    await sendReply(options.provider, message, "❌ 提交访问请求失败，请联系管理员。");
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
    "✅ 已提交访问请求，等待管理员审批。",
  );
}

export async function handleCardAction(
  message: IncomingMessage,
  options: SessionHandlerOptions,
): Promise<void> {
  const { adminUserIds, updateApprovalCard, cardActionData } = options;

  if (!cardActionData) {
    await sendReply(options.provider, message, "❌ 无效的卡片操作。");
    return;
  }

  if (!adminUserIds || !adminUserIds.includes(message.userId)) {
    logWith(
      options.logger,
      `Non-admin user ${message.userId} attempted card action for request ${cardActionData.requestId}`,
      "warn",
    );
    await sendReply(options.provider, message, "❌ 只有管理员可以操作审批。");
    return;
  }

  const request = getApprovalRequest(cardActionData.requestId);
  if (!request) {
    await sendReply(options.provider, message, "❌ 审批请求不存在或已过期。");
    return;
  }

  if (request.status !== "pending") {
    await sendReply(options.provider, message, `❌ 该请求已被处理（${request.status}）。`);
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
      ? `✅ 已批准用户 ${request.user_id} 的访问请求。`
      : `❌ 已拒绝用户 ${request.user_id} 的访问请求。`;

  if (request.admin_chat_id) {
    await options.provider.sendMessage({ channelId: request.admin_chat_id }, { text: notifyText });
    return;
  }

  if (message.channelId) {
    await options.provider.sendMessage({ channelId: message.channelId }, { text: notifyText });
  }
}
