import { execSync, spawn } from "node:child_process";
import { isCommandProcessed, markCommandProcessed } from "../../database.js";
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

    output += `当前分支: ${currentBranch}\n`;
    output += `当前提交: ${currentCommit}\n`;
    output += "开始更新...\n";

    // 拉取最新代码
    execSync("git pull", { encoding: "utf-8" }).trim();
    output += "✓ git pull 完成\n";

    // 检查是否有新的提交
    const newCommit = execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
    if (newCommit !== currentCommit) {
      output += `✓ 更新到新提交: ${newCommit}\n`;

      // 检查 pnpm-lock.yaml 是否变化
      const lockChanged = execSync(
        `git diff ${currentCommit} ${newCommit} --name-only | grep -q "pnpm-lock.yaml" && echo "changed" || echo "same"`,
        { encoding: "utf-8" },
      ).trim();

      if (lockChanged === "changed") {
        output += "✓ pnpm-lock.yaml 变化，执行 pnpm install...\n";
        execSync("pnpm install", { encoding: "utf-8" });
        output += "✓ pnpm install 完成\n";
      } else {
        output += "✓ 依赖无变化，跳过 pnpm install\n";
      }

      output += "开始构建...\n";
      execSync("pnpm build", { encoding: "utf-8" });
      output += "✓ 构建完成\n";

      // 重启服务
      output += "正在重启服务...\n";
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
      output += "✓ 已经是最新版本，无需更新";
    }
  } catch (error) {
    output += `\n✗ 更新失败: ${error instanceof Error ? error.message : String(error)}`;
  }
  await sendReply(provider, message, output);
  return true;
};
