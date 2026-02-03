import { getUserWorkspace, listWorkspaces } from "../../database.js";
import { t } from "../../i18n/index.js";
import { sendReply } from "../messaging.js";
import { handleWorkspaceAction } from "../workspace.js";
import type { CommandHandler } from "./shared.js";

export const handleWorkspace: CommandHandler = async (message, command, options) => {
  const { provider } = options;
  const rawArg = command.args.join(" ").trim();
  if (!rawArg) {
    const workspaceName = getUserWorkspace(message.userId);
    if (!workspaceName) {
      await sendReply(provider, message, t("commands.workspaceNone"));
      return true;
    }
    await sendReply(provider, message, t("commands.workspaceCurrent", { name: workspaceName }));
    return true;
  }

  await handleWorkspaceAction(message, options, { action: "bind", workspaceName: rawArg });
  return true;
};

export const handleWorkspaces: CommandHandler = async (message, _command, options) => {
  const { provider } = options;
  const workspaces = listWorkspaces();
  if (workspaces.length === 0) {
    await sendReply(provider, message, t("commands.workspacesNone"));
    return true;
  }
  const lines = [t("commands.workspacesTitle")];
  for (const workspace of workspaces) {
    lines.push(t("commands.workspacesItem", {
      name: workspace.name,
      ownerId: workspace.ownerUserId,
    }));
  }
  await sendReply(provider, message, lines.join("\n"));
  return true;
};
