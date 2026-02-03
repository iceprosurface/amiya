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
  const appendLine = (line: string) => {
    output += `${line}\n`;
  };
  const run = (cmd: string) => execSync(cmd, { encoding: "utf-8" }).trim();
  let currentBranch = "";
  let currentCommit = "";
  let currentCommitShort = "";
  try {
    // 获取当前分支和最新提交
    currentBranch = run("git rev-parse --abbrev-ref HEAD");
    currentCommit = run("git rev-parse HEAD");
    currentCommitShort = run("git rev-parse --short HEAD");

    appendLine(t("commands.updateBranch", { branch: currentBranch }));
    appendLine(t("commands.updateCommit", { commit: currentCommitShort }));
    appendLine(t("commands.updateStart"));

    const targetHash = command.args[0]?.trim();
    if (targetHash) {
      if (!/^[0-9a-fA-F]{7,40}$/.test(targetHash)) {
        appendLine(t("commands.updateInvalidHash", { commit: targetHash }));
        await sendReply(provider, message, output.trimEnd());
        return true;
      }
      appendLine(t("commands.updateTarget", { commit: targetHash }));
      run("git fetch --all --tags --prune");
      appendLine(t("commands.updateFetchDone"));
      const resolvedHash = run(`git rev-parse --verify ${targetHash}^{commit}`);
      if (resolvedHash === currentCommit) {
        output += t("commands.updateLatest");
        await sendReply(provider, message, output.trimEnd());
        return true;
      }
      run(`git checkout ${resolvedHash}`);
      appendLine(t("commands.updateCheckout", { commit: run("git rev-parse --short HEAD") }));
    } else {
      // 拉取最新代码
      run("git pull --ff-only");
      appendLine(t("commands.updatePullDone"));
    }

    // 检查是否有新的提交
    const newCommitFull = run("git rev-parse HEAD");
    const newCommitShort = run("git rev-parse --short HEAD");
    if (newCommitFull !== currentCommit) {
      appendLine(t("commands.updateNewCommit", { commit: newCommitShort }));

      // 检查 pnpm-lock.yaml 是否变化
      const diffFiles = run(`git diff ${currentCommit} ${newCommitFull} --name-only`);
      const lockChanged = diffFiles
        .split("\n")
        .map((name) => name.trim())
        .filter(Boolean)
        .includes("pnpm-lock.yaml");

      if (lockChanged) {
        appendLine(t("commands.updateLockChanged"));
        execSync("pnpm install", { encoding: "utf-8" });
        appendLine(t("commands.updateInstallDone"));
      } else {
        appendLine(t("commands.updateNoDeps"));
      }

      appendLine(t("commands.updateBuildStart"));
      execSync("pnpm build", { encoding: "utf-8" });
      appendLine(t("commands.updateBuildDone"));

      // 重启服务
      appendLine(t("commands.updateRestart"));
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
    if (currentCommit) {
      appendLine("");
      appendLine(t("commands.updateRollbackStart", { commit: currentCommitShort || currentCommit }));
      try {
        if (currentBranch && currentBranch !== "HEAD") {
          run(`git checkout ${currentBranch}`);
        }
        run(`git reset --hard ${currentCommit}`);
        appendLine(t("commands.updateRollbackDone", { commit: currentCommitShort || currentCommit }));
      } catch (rollbackError) {
        output += t("commands.updateRollbackFailed", {
          error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        });
      }
    }
  }
  await sendReply(provider, message, output);
  return true;
};
