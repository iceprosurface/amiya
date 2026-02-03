import fs from "node:fs";
import path from "node:path";

import { getWorkspaceBaseDir } from "../config.js";
import {
  addWorkspaceMember,
  createWorkspace,
  createWorkspaceJoinRequest,
  getUserWorkspace,
  getWorkspace,
  getWorkspaceJoinRequest,
  isWorkspaceMember,
  setUserWorkspace,
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

export function resolveWorkspaceDirectory(userId: string, logger?: SessionHandlerOptions["logger"]): string | undefined {
  const workspaceName = getUserWorkspace(userId);
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

async function sendWorkspaceJoinCard(
  message: IncomingMessage,
  options: SessionHandlerOptions,
  params: {
    requestId: string;
    workspaceName: string;
    requesterUserId: string;
    requesterUserName?: string;
    ownerUserId: string;
  },
): Promise<string | null> {
  const client = options.provider.getFeishuClient?.();
  if (!client || typeof client.replyWorkspaceJoinApprovalCardWithId !== "function") return null;
  return await client.replyWorkspaceJoinApprovalCardWithId(
    message.messageId,
    params,
    { replyInThread: true },
  );
}

export async function ensureWorkspaceBound(
  message: IncomingMessage,
  options: SessionHandlerOptions,
): Promise<boolean> {
  const workspaceName = getUserWorkspace(message.userId);
  if (workspaceName) return false;

  const now = Date.now();
  const pending = pendingWorkspaceBinds.get(message.userId);
  if (pending && now - pending.sentAt < WORKSPACE_BIND_COOLDOWN_MS) {
    return true;
  }

  const cardMessageId = await sendWorkspaceBindCard(message, options);
  if (cardMessageId) {
    pendingWorkspaceBinds.set(message.userId, { messageId: cardMessageId, sentAt: now });
    return true;
  }

  await sendReply(options.provider, message, t("workspace.bindPromptFallback"));
  pendingWorkspaceBinds.set(message.userId, { sentAt: now });
  return true;
}

export async function handleWorkspaceAction(
  message: IncomingMessage,
  options: SessionHandlerOptions,
  action: { action: "bind" | "join-approve" | "join-reject"; workspaceName?: string; requestId?: string },
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

    const existing = getWorkspace(rawName);
    if (!existing) {
      createWorkspace(rawName, message.userId);
      addWorkspaceMember(rawName, message.userId);
      setUserWorkspace(message.userId, rawName);
      ensureWorkspaceDirectory(rawName, options.logger);
      pendingWorkspaceBinds.delete(message.userId);
      await sendReply(options.provider, message, t("workspace.boundCreated", { name: rawName }));
      return true;
    }

    if (existing.ownerUserId === message.userId) {
      addWorkspaceMember(rawName, message.userId);
      setUserWorkspace(message.userId, rawName);
      ensureWorkspaceDirectory(rawName, options.logger);
      pendingWorkspaceBinds.delete(message.userId);
      await sendReply(options.provider, message, t("workspace.boundSwitched", { name: rawName }));
      return true;
    }

    if (isWorkspaceMember(rawName, message.userId)) {
      setUserWorkspace(message.userId, rawName);
      ensureWorkspaceDirectory(rawName, options.logger);
      pendingWorkspaceBinds.delete(message.userId);
      await sendReply(options.provider, message, t("workspace.boundSwitched", { name: rawName }));
      return true;
    }

    const requestId = `wreq_${rawName}_${message.userId}_${Date.now()}`;
    const cardMessageId = await sendWorkspaceJoinCard(message, options, {
      requestId,
      workspaceName: rawName,
      requesterUserId: message.userId,
      requesterUserName: message.userName,
      ownerUserId: existing.ownerUserId,
    });

    if (!cardMessageId) {
      await sendReply(options.provider, message, t("workspace.joinRequestFailed"));
      return true;
    }

    createWorkspaceJoinRequest({
      requestId,
      workspaceName: rawName,
      requesterUserId: message.userId,
      requesterUserName: message.userName,
      requesterChannelId: message.channelId,
      ownerUserId: existing.ownerUserId,
      cardMessageId,
    });

    await sendReply(
      options.provider,
      message,
      t("workspace.joinSubmitted", { name: rawName, ownerId: existing.ownerUserId }),
    );
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
    setUserWorkspace(request.requesterUserId, request.workspaceName);
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
