import type { IncomingMessage } from "../types.js";

export type QueuedMessage = {
  message: IncomingMessage;
  queuedAt: number;
};

export const messageQueue = new Map<string, QueuedMessage[]>();

export const activeRequests = new Map<
  string,
  { sessionId: string; controller: AbortController }
>();

export type ActiveStreamState = {
  placeholderId?: string;
  cardId?: string;
  elementId?: string;
  byOcMessageId?: Map<string, { messageId: string; cardId?: string; elementId?: string }>;
};

export const activeStreams = new Map<string, ActiveStreamState>();

export type PendingQuestion = {
  requestId: string;
  sessionId: string;
  directory: string;
  cardMessageId?: string;
  currentIndex: number;
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description?: string }>;
    multiple?: boolean;
  }>;
  answers: Record<number, string[]>;
  answeredIndices: Set<number>;
};

export const pendingQuestions = new Map<string, PendingQuestion>();

export type PendingPermission = {
  requestIds: string[];
  directory: string;
  threadId: string;
  messageId: string;
  dedupeKey: string;
  permission: string;
  patterns: string[];
};

export const pendingPermissions = new Map<string, PendingPermission>();

export const pendingWorkspaceBinds = new Map<
  string,
  { messageId?: string; sentAt: number }
>();
