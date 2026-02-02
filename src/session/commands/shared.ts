import fs from "node:fs";
import path from "node:path";
import { getChannelDirectory, setChannelDirectory } from "../../database.js";
import type { IncomingMessage } from "../../types.js";
import type { SessionHandlerOptions } from "../session-handler.js";

export type Command = { name: string; args: string[] };
export type CommandHandler = (
  message: IncomingMessage,
  command: Command,
  options: SessionHandlerOptions,
) => Promise<boolean>;

export function parseBooleanArg(input: string | undefined): boolean | null {
  if (!input) return null;
  const normalized = input.trim().toLowerCase();
  if (["true", "yes", "y", "on", "1"].includes(normalized)) return true;
  if (["false", "no", "n", "off", "0"].includes(normalized)) return false;
  return null;
}

export function expandUserPath(input: string): string {
  if (!input.startsWith("~/")) return input;
  const home = process.env.HOME || "";
  return home ? path.join(home, input.slice(2)) : input;
}

export function resolveAccessibleDirectory(
  channelId: string,
  projectDirectory: string,
  logger?: (message: string, level?: "debug" | "info" | "warn" | "error") => void,
): string {
  const channelDirectory = getChannelDirectory(channelId);
  if (!channelDirectory) return projectDirectory;

  try {
    fs.accessSync(channelDirectory, fs.constants.R_OK | fs.constants.X_OK);
    return channelDirectory;
  } catch {
    if (logger) {
      logger(
        `Channel directory not accessible: ${channelDirectory}. Falling back to ${projectDirectory}.`,
        "warn",
      );
    }
    setChannelDirectory(channelId, projectDirectory);
    return projectDirectory;
  }
}

export function isBotMentioned(message: IncomingMessage, botUserId?: string): boolean {
  if (!botUserId) return false;
  return Array.isArray(message.mentions) && message.mentions.includes(botUserId);
}

export function formatRelativeMs(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m${sec % 60}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h${min % 60}m`;
}

export function previewText(text: string, maxLen = 80): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed.length <= maxLen) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxLen - 3))}...`;
}
