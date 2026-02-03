import { execSync, spawn } from "node:child_process";
import { isCommandProcessed, markCommandProcessed } from "../../database.js";
import { t } from "../../i18n/index.js";
import { sendReply } from "../messaging.js";
import type { CommandHandler } from "./shared.js";

export const handleUpdateDeploy: CommandHandler = async (message, command, options) => {
  const { provider } = options;
  const messageId = message.messageId;
  if (messageId && isCommandProcessed(messageId, command.name)) {
    if (options.logger) {
      options.logger(
        `Command ${command.name} ignored for duplicate message ${messageId}`,
        "info",
      );
    }
    return true;
  }
  if (messageId) {
    markCommandProcessed(messageId, command.name);
  }

  let output = "";
  try {
    // 获取当前分支和最新提交
    const currentBranch = execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf-8" }).trim();
    const currentCommit = execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();

    output += `${t("commands.updateBranch", { branch: currentBranch })}\n`;
    output += `${t("commands.updateCommit", { commit: currentCommit })}\n`;
    output += `${t("commands.updateStart")}\n`;

    // 拉取最新代码
    execSync("git pull", { encoding: "utf-8" }).trim();
    output += `${t("commands.updatePullDone")}\n`;

    // 检查是否有新的提交
    const newCommit = execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
    if (newCommit !== currentCommit) {
      output += `${t("commands.updateNewCommit", { commit: newCommit })}\n`;

      // 检查 pnpm-lock.yaml 是否变化
      const lockChanged = execSync(
        `git diff ${currentCommit} ${newCommit} --name-only | grep -q "pnpm-lock.yaml" && echo "changed" || echo "same"`,
        { encoding: "utf-8" },
      ).trim();

      if (lockChanged === "changed") {
        output += `${t("commands.updateLockChanged")}\n`;
        execSync("pnpm install", { encoding: "utf-8" });
        output += `${t("commands.updateInstallDone")}\n`;
      } else {
        output += `${t("commands.updateNoDeps")}\n`;
      }

      output += `${t("commands.updateBuildStart")}\n`;
      execSync("pnpm build", { encoding: "utf-8" });
      output += `${t("commands.updateBuildDone")}\n`;

      // 重启服务
      output += `${t("commands.updateRestart")}\n`;
      await sendReply(provider, message, output);

      // 先延迟发送回复，然后执行 pm2 restart
      setTimeout(() => {
        try {
          const child = spawn("pm2", ["restart", "amiya", "--update-env"], {
            detached: true,
            stdio: "ignore",
          });
          child.unref();
        } catch {
          try {
            const child = spawn("pm2", ["start", "pm2.config.cjs"], {
              detached: true,
              stdio: "ignore",
            });
            child.unref();
          } catch {
            // ignore
          }
        }
      }, 1000);
      return true;
    } else {
      output += t("commands.updateLatest");
    }
  } catch (error) {
    output += t("commands.updateFailed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  await sendReply(provider, message, output);
  return true;
};
