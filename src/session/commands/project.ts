import fs from "node:fs";
import path from "node:path";
import { setChannelDirectory } from "../../database.js";
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
      `当前项目目录：\n\n\`${directory}\`\n\n提示：该设置仅对当前频道生效。`,
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
      await sendReply(provider, message, `✗ 目标不是目录：\`${targetPath}\``);
      return true;
    }
    fs.accessSync(targetPath, fs.constants.R_OK | fs.constants.X_OK);
  }
  catch {
    await sendReply(
      provider,
      message,
      `✗ 目录不可访问或不存在：\`${targetPath}\`\n\n请确认路径或权限。`,
    );
    return true;
  }

  setChannelDirectory(message.channelId, targetPath);
  await sendReply(provider, message, `✅ 已设置当前频道目录：\n\n\`${targetPath}\``);
  return true;
};
