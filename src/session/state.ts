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
  { placeholderId: string }
>();
