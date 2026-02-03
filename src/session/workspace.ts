import fs from "node:fs";
import path from "node:path";

import { getWorkspaceBaseDir } from "../config.js";
import {
  addWorkspaceMember,
  createChannelWorkspace,
  createWorkspace,
  createWorkspaceBindRequest,
  getChannelWorkspace,
  getPendingWorkspaceBindRequest,
  getWorkspace,
  getWorkspaceBindRequest,
  getWorkspaceJoinRequest,
  updateWorkspaceBindRequestStatus,
  updateWorkspaceJoinRequestStatus,
} from "../database.js";
import { t } from "../i18n/index.js";
import type { IncomingMessage } from "../types.js";
import type { SessionHandlerOptions } from "./session-handler.js";
import { sendReply } from "./messaging.js";
import { pendingWorkspaceBinds } from "./state.js";
import { logWith } from "./utils.js";

const WORKSPACE_NAME_REGEX = /^[A-Za-z-]+$/;
const WORKSPACE_BIND_COOLDOWN_MS = 60_000;

function isValidWorkspaceName(name: string): boolean {
  return WORKSPACE_NAME_REGEX.test(name);
}

function ensureWorkspaceDirectory(workspaceName: string, logger?: SessionHandlerOptions["logger"]): string | undefined {
  const baseDir = getWorkspaceBaseDir();
  const workspaceDir = path.join(baseDir, workspaceName);
  try {
    if (!fs.existsSync(workspaceDir)) {
      fs.mkdirSync(workspaceDir, { recursive: true });
    }
    fs.accessSync(workspaceDir, fs.constants.R_OK | fs.constants.X_OK);
    return workspaceDir;
  } catch (error) {
    logWith(logger, `Workspace directory not accessible: ${workspaceDir} (${error})`, "warn");
    return undefined;
  }
}

export function resolveWorkspaceDirectory(channelId: string, logger?: SessionHandlerOptions["logger"]): string | undefined {
  const workspaceName = getChannelWorkspace(channelId);
  if (!workspaceName) return undefined;
  return ensureWorkspaceDirectory(workspaceName, logger);
}

async function sendWorkspaceBindCard(
  message: IncomingMessage,
  options: SessionHandlerOptions,
): Promise<string | null> {
  const client = options.provider.getFeishuClient?.();
  if (!client || typeof client.replyWorkspaceBindCardWithId !== "function") return null;
  return await client.replyWorkspaceBindCardWithId(
    message.messageId,
    { userId: message.userId },
    { replyInThread: true },
  );
}

async function sendWorkspaceBindApprovalCard(
  options: SessionHandlerOptions,
  params: {
    adminChatId: string;
    requestId: string;
    channelId: string;
    workspaceName: string;
    requesterUserId: string;
    requesterUserName?: string;
  },
): Promise<string | null> {
  const client = options.provider.getFeishuClient?.();
  if (!client || typeof client.sendWorkspaceBindApprovalCard !== "function") return null;
  return await client.sendWorkspaceBindApprovalCard(params.adminChatId, {
    requestId: params.requestId,
    channelId: params.channelId,
    workspaceName: params.workspaceName,
    requesterUserId: params.requesterUserId,
    requesterUserName: params.requesterUserName,
  });
}

export async function ensureWorkspaceBound(
  message: IncomingMessage,
  options: SessionHandlerOptions,
): Promise<boolean> {
  const workspaceName = getChannelWorkspace(message.channelId);
  if (workspaceName) return false;

  const pendingRequest = getPendingWorkspaceBindRequest(message.channelId);
  const now = Date.now();
  const pending = pendingWorkspaceBinds.get(message.channelId);
  if (pending && now - pending.sentAt < WORKSPACE_BIND_COOLDOWN_MS) {
    return true;
  }

  if (pendingRequest) {
    await sendReply(options.provider, message, t("workspace.bindPending", { name: pendingRequest.workspaceName }));
    pendingWorkspaceBinds.set(message.channelId, { sentAt: now });
    return true;
  }

  const cardMessageId = await sendWorkspaceBindCard(message, options);
  if (cardMessageId) {
    pendingWorkspaceBinds.set(message.channelId, { messageId: cardMessageId, sentAt: now });
    return true;
  }

  await sendReply(options.provider, message, t("workspace.bindPromptFallback"));
  pendingWorkspaceBinds.set(message.channelId, { sentAt: now });
  return true;
}

export async function handleWorkspaceAction(
  message: IncomingMessage,
  options: SessionHandlerOptions,
  action: {
    action: "bind" | "bind-approve" | "bind-reject" | "join-approve" | "join-reject";
    workspaceName?: string;
    requestId?: string;
  },
): Promise<boolean> {
  if (action.action === "bind") {
    const rawName = action.workspaceName?.trim() || "";
    if (!rawName) {
      await sendReply(options.provider, message, t("workspace.nameMissing"));
      return true;
    }
    if (!isValidWorkspaceName(rawName)) {
      await sendReply(options.provider, message, t("workspace.nameInvalid"));
      return true;
    }

    const boundWorkspace = getChannelWorkspace(message.channelId);
    if (boundWorkspace) {
      await sendReply(options.provider, message, t("workspace.channelBound", { name: boundWorkspace }));
      return true;
    }

    const pendingRequest = getPendingWorkspaceBindRequest(message.channelId);
    if (pendingRequest) {
      await sendReply(options.provider, message, t("workspace.bindPending", { name: pendingRequest.workspaceName }));
      return true;
    }

    if (!options.adminUserIds || options.adminUserIds.length === 0) {
      await sendReply(options.provider, message, t("workspace.bindAdminMissing"));
      return true;
    }

    const approvalChatId = options.adminChatId || message.channelId;
    const requestId = `wbind_${message.channelId}_${message.userId}_${Date.now()}`;
    const cardMessageId = await sendWorkspaceBindApprovalCard(options, {
      adminChatId: approvalChatId,
      requestId,
      channelId: message.channelId,
      workspaceName: rawName,
      requesterUserId: message.userId,
      requesterUserName: message.userName,
    });

    if (!cardMessageId) {
      await sendReply(options.provider, message, t("workspace.bindRequestFailed"));
      return true;
    }

    createWorkspaceBindRequest({
      requestId,
      channelId: message.channelId,
      workspaceName: rawName,
      requesterUserId: message.userId,
      requesterUserName: message.userName,
      adminChatId: approvalChatId,
      cardMessageId,
    });

    pendingWorkspaceBinds.set(message.channelId, { messageId: cardMessageId, sentAt: Date.now() });
    await sendReply(options.provider, message, t("workspace.bindSubmitted", { name: rawName }));
    return true;
  }

  if (action.action === "bind-approve" || action.action === "bind-reject") {
    const requestId = action.requestId || "";
    if (!requestId) {
      await sendReply(options.provider, message, t("workspace.bindRequestMissing"));
      return true;
    }

    const request = getWorkspaceBindRequest(requestId);
    if (!request) {
      await sendReply(options.provider, message, t("workspace.bindRequestMissing"));
      return true;
    }

    if (!options.adminUserIds || !options.adminUserIds.includes(message.userId)) {
      await sendReply(options.provider, message, t("workspace.bindAdminOnly"));
      return true;
    }

    if (request.status !== "pending") {
      await sendReply(
        options.provider,
        message,
        t("workspace.bindRequestHandled", { status: request.status }),
      );
      return true;
    }

    const approved = action.action === "bind-approve";
    let effectiveApproved = approved;
    let status = approved ? `approved_by_${message.userId}` : `rejected_by_${message.userId}`;

    if (approved) {
      const existingBound = getChannelWorkspace(request.channelId);
      if (existingBound) {
        effectiveApproved = false;
        status = `rejected_already_bound_${message.userId}`;
      } else {
        const existing = getWorkspace(request.workspaceName);
        if (!existing) {
          createWorkspace(request.workspaceName, request.requesterUserId);
        }
        addWorkspaceMember(request.workspaceName, request.requesterUserId);
        const bound = createChannelWorkspace(request.channelId, request.workspaceName);
        if (!bound) {
          effectiveApproved = false;
          status = `rejected_already_bound_${message.userId}`;
        } else {
          ensureWorkspaceDirectory(request.workspaceName, options.logger);
          pendingWorkspaceBinds.delete(request.channelId);
        }
      }
    }

    updateWorkspaceBindRequestStatus(requestId, status);

    const client = options.provider.getFeishuClient?.();
    if (client && request.cardMessageId && typeof client.updateWorkspaceBindApprovalCard === "function") {
      await client.updateWorkspaceBindApprovalCard(
        request.cardMessageId,
        effectiveApproved ? "approved" : "rejected",
        message.userId,
      );
    }

    const notifyText = effectiveApproved
      ? t("workspace.bindApprovedNotify", { name: request.workspaceName })
      : t("workspace.bindRejectedNotify", { name: request.workspaceName });
    try {
      await options.provider.sendMessage({ channelId: request.channelId }, { text: notifyText });
    } catch (error) {
      logWith(options.logger, `Workspace bind notify failed: ${error}`, "warn");
    }

    const operatorText = effectiveApproved
      ? t("workspace.bindApproved", { name: request.workspaceName, channelId: request.channelId })
      : t("workspace.bindRejected", { name: request.workspaceName, channelId: request.channelId });
    await sendReply(options.provider, message, operatorText);
    return true;
  }

  const requestId = action.requestId || "";
  if (!requestId) {
    await sendReply(options.provider, message, t("workspace.joinRequestMissing"));
    return true;
  }

  const request = getWorkspaceJoinRequest(requestId);
  if (!request) {
    await sendReply(options.provider, message, t("workspace.joinRequestMissing"));
    return true;
  }

  if (request.status !== "pending") {
    await sendReply(
      options.provider,
      message,
      t("workspace.joinRequestHandled", { status: request.status }),
    );
    return true;
  }

  if (request.ownerUserId !== message.userId) {
    await sendReply(options.provider, message, t("workspace.joinOwnerOnly"));
    return true;
  }

  const approved = action.action === "join-approve";
  const status = approved ? `approved_by_${message.userId}` : `rejected_by_${message.userId}`;
  updateWorkspaceJoinRequestStatus(requestId, status);

  if (approved) {
    addWorkspaceMember(request.workspaceName, request.requesterUserId);
    ensureWorkspaceDirectory(request.workspaceName, options.logger);
  }

  const client = options.provider.getFeishuClient?.();
  if (client && request.cardMessageId && typeof client.updateWorkspaceJoinApprovalCard === "function") {
    await client.updateWorkspaceJoinApprovalCard(
      request.cardMessageId,
      approved ? "approved" : "rejected",
      message.userId,
    );
  }

  const notifyText = approved
    ? t("workspace.joinApprovedNotify", { name: request.workspaceName })
    : t("workspace.joinRejectedNotify", { name: request.workspaceName });
  try {
    await options.provider.sendMessage({ channelId: request.requesterChannelId }, { text: notifyText });
  } catch (error) {
    logWith(options.logger, `Workspace join notify failed: ${error}`, "warn");
  }

  const operatorText = approved
    ? t("workspace.joinApproved", { name: request.workspaceName, userId: request.requesterUserId })
    : t("workspace.joinRejected", { name: request.workspaceName, userId: request.requesterUserId });
  await sendReply(options.provider, message, operatorText);
  return true;
}
