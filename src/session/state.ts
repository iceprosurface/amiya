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

export const activeStreams = new Map<
  string,
  { placeholderId: string; cardId?: string; elementId?: string }
>();

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
