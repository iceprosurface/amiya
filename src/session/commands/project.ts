import fs from "node:fs";
import path from "node:path";
import { setChannelDirectory } from "../../database.js";
import { t } from "../../i18n/index.js";
import { sendReply } from "../messaging.js";
import { expandUserPath, resolveAccessibleDirectory, type CommandHandler } from "./shared.js";

export const handleProject: CommandHandler = async (message, command, options) => {
  const { provider } = options;
  const rawArg = command.args.join(" ").trim();
  if (!rawArg) {
    const directory = resolveAccessibleDirectory(
      message.channelId,
      options.projectDirectory,
      options.logger,
    );
    await sendReply(
      provider,
      message,
      t("commands.projectCurrent", { directory }),
    );
    return true;
  }

  const expanded = expandUserPath(rawArg);
  const targetPath = path.isAbsolute(expanded)
    ? expanded
    : path.resolve(options.projectDirectory, expanded);

  try {
    const stat = fs.statSync(targetPath);
    if (!stat.isDirectory()) {
      await sendReply(provider, message, t("commands.projectNotDir", { path: targetPath }));
      return true;
    }
    fs.accessSync(targetPath, fs.constants.R_OK | fs.constants.X_OK);
  }
  catch {
    await sendReply(
      provider,
      message,
      t("commands.projectMissing", { path: targetPath }),
    );
    return true;
  }

  setChannelDirectory(message.channelId, targetPath);
  await sendReply(provider, message, t("commands.projectSet", { path: targetPath }));
  return true;
};
