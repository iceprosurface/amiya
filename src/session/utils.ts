import type { SessionHandlerOptions } from "./session-handler.js";
import { t } from "../i18n/index.js";
import { OpenCodeApiError } from "../errors.js";

export function logWith(
  logger: SessionHandlerOptions["logger"],
  message: string,
  level: "debug" | "info" | "warn" | "error" = "info",
) {
  if (logger) {
    logger(`[Session] ${message}`, level);
  }
}

export function describeCause(cause: unknown): string {
  if (!cause) return "";
  if (cause instanceof Error) {
    return `${cause.name}: ${cause.message}`;
  }
  if (typeof cause === "object") {
    const c = cause as Record<string, unknown>;
    const code = typeof c.code === "string" ? c.code : "";
    const syscall = typeof c.syscall === "string" ? c.syscall : "";
    const address = typeof c.address === "string" ? c.address : "";
    const port =
      typeof c.port === "number"
        ? String(c.port)
        : typeof c.port === "string"
          ? c.port
          : "";
    const hostname = typeof c.hostname === "string" ? c.hostname : "";
    const parts = [code, syscall, address || hostname, port].filter(Boolean);
    if (parts.length > 0) return parts.join(" ");
  }
  return String(cause);
}

export function describeError(error: unknown): { summary: string; stack?: string } {
  if (error instanceof Error) {
    const errorWithCause = error as { cause?: unknown };
    const cause = describeCause(errorWithCause.cause);
    const summary = cause
      ? `${error.name}: ${error.message}; cause=${cause}`
      : `${error.name}: ${error.message}`;
    return { summary, stack: error.stack };
  }
  return { summary: String(error) };
}

export function compactOpenCodeApiErrorDetails(details: string): string {
  const trimmed = details.trim();
  if (!trimmed) return "";
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return trimmed.length > 300 ? `${trimmed.slice(0, 297)}...` : trimmed;
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object") {
      return trimmed.length > 300 ? `${trimmed.slice(0, 297)}...` : trimmed;
    }
    const obj = parsed as Record<string, unknown>;
    const message = typeof obj.message === "string" ? obj.message : "";
    const code = typeof obj.code === "string" ? obj.code : "";
    const type = typeof obj.type === "string" ? obj.type : "";
    const parts = [code, type, message].filter(Boolean);
    const joined = parts.join(" ");
    if (joined) return joined.length > 300 ? `${joined.slice(0, 297)}...` : joined;
    return trimmed.length > 300 ? `${trimmed.slice(0, 297)}...` : trimmed;
  } catch {
    return trimmed.length > 300 ? `${trimmed.slice(0, 297)}...` : trimmed;
  }
}

export function toUserErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error instanceof OpenCodeApiError) {
      const compact = compactOpenCodeApiErrorDetails(error.details);
      const msg = compact
        ? `OpenCode API ${error.status}: ${compact}`
        : `OpenCode API ${error.status}`;
      return msg.length > 800 ? `${msg.slice(0, 797)}...` : msg;
    }

    const errorWithCause = error as { cause?: unknown };
    const cause = describeCause(errorWithCause.cause);
    const msg = error.message || error.name;
    const full = cause ? `${msg} (cause: ${cause})` : msg;
    return full.length > 800 ? `${full.slice(0, 797)}...` : full;
  }
  const msg = String(error);
  return msg.length > 800 ? `${msg.slice(0, 797)}...` : msg;
}

export function inferNetworkHintFromCause(cause: unknown): string {
  const text = describeCause(cause);
  const upper = text.toUpperCase();
  if (upper.includes("ECONNREFUSED")) return t("utils.connRefused");
  if (upper.includes("ENOTFOUND")) return t("utils.dnsFailed");
  if (upper.includes("ECONNRESET")) return t("utils.connReset");
  if (upper.includes("ETIMEDOUT") || upper.includes("TIMEOUT")) return t("utils.timeout");
  if (upper.includes("CERT") || upper.includes("TLS")) return t("utils.tlsFailed");
  return "";
}

export function buildFailureReport(params: {
  operation: string;
  directory: string;
  threadId: string;
  sessionId?: string;
  error: unknown;
}): string {
  const { operation, directory, threadId, sessionId, error } = params;
  const described = describeError(error);

  let cause: unknown;
  if (error instanceof Error) {
    const errorWithCause = error as { cause?: unknown };
    cause = errorWithCause.cause;
  }
  const hint = inferNetworkHintFromCause(cause);

  const lines: string[] = [];
  lines.push(t("utils.failureDiag"));
  lines.push(t("utils.operation", { operation }));
  lines.push(t("utils.directory", { directory }));
  lines.push(t("utils.thread", { threadId }));
  if (sessionId) lines.push(t("utils.session", { sessionId }));

  if (error instanceof OpenCodeApiError) {
    const compact = compactOpenCodeApiErrorDetails(error.details);
    lines.push(`- OpenCode API: ${error.status}${compact ? ` ${compact}` : ""}`);
  } else {
    lines.push(t("utils.error", { summary: described.summary }));
  }

  const causeText = describeCause(cause);
  if (causeText) {
    lines.push(`- cause: ${causeText}`);
  }
  if (hint) {
    lines.push(t("utils.hint", { hint }));
  }

  return lines.join("\n");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return "-";
  return String(n);
}

export function formatUsd(cost: number): string {
  if (!Number.isFinite(cost)) return "-";
  return `$${cost.toFixed(4)}`;
}

export function safeDateTime(ms: number | undefined): string {
  if (!ms || !Number.isFinite(ms)) return "-";
  try {
    return new Date(ms).toISOString();
  } catch {
    return "-";
  }
}
