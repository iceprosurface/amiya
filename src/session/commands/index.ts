import type { IncomingMessage } from "../../types.js";
import type { SessionHandlerOptions } from "../session-handler.js";
import { logWith } from "../utils.js";
import { handleAbort } from "./abort.js";
import { handleAgent } from "./agent.js";
import { handleCompact } from "./compact.js";
import { handleContext } from "./context.js";
import { handleHelp } from "./help.js";
import { handleListSessions } from "./list-sessions.js";
import { handleMentionRequired } from "./mention-required.js";
import { handleModel } from "./model.js";
import { handleNewSession } from "./new-session.js";
import { handleProject } from "./project.js";
import { handleQueue } from "./queue.js";
import { handleResume } from "./resume.js";
import type { Command, CommandHandler } from "./shared.js";
import { handleUpdateDeploy } from "./update-deploy.js";

const handlers: Record<string, CommandHandler> = {
  "new-session": handleNewSession,
  new: handleNewSession,
  resume: handleResume,
  abort: handleAbort,
  queue: handleQueue,
  context: handleContext,
  project: handleProject,
  dir: handleProject,
  "list-sessions": handleListSessions,
  model: handleModel,
  agent: handleAgent,
  compact: handleCompact,
  "mention-required": handleMentionRequired,
  update: handleUpdateDeploy,
  deploy: handleUpdateDeploy,
  help: handleHelp,
};

export function parseCommand(text: string): Command | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const parts = trimmed.slice(1).split(/\s+/);
  const name = parts.shift();
  if (!name) return null;
  return { name: name.toLowerCase(), args: parts };
}

export async function handleCommand(
  message: IncomingMessage,
  command: Command,
  options: SessionHandlerOptions,
): Promise<boolean> {
  const handler = handlers[command.name];
  if (!handler) return false;
  const argsText = command.args.length > 0 ? command.args.join(" ") : "-";
  logWith(
    options.logger,
    `Command start name=${command.name} args=${argsText} thread=${message.threadId} channel=${message.channelId}`,
    "info",
  );
  try {
    const handled = await handler(message, command, options);
    logWith(
      options.logger,
      `Command end name=${command.name} handled=${handled}`,
      "info",
    );
    return handled;
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    logWith(
      options.logger,
      `Command error name=${command.name} error=${messageText}`,
      "error",
    );
    throw error;
  }
}
