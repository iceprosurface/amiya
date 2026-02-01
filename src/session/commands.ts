import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage } from "../types.js";
import type { SessionHandlerOptions } from "./session-handler.js";
import {
  clearThreadSession,
  getChannelAgent,
  getChannelDirectory,
  getChannelModel,
  getSessionAgent,
  getSessionModel,
  getThreadSession,
  listThreadSessions,
  clearSessionModel,
  setChannelAgent,
  setChannelDirectory,
  setChannelModel,
  setSessionAgent,
  setSessionModel,
  setThreadSession,
  getThreadMentionRequired,
  setThreadMentionRequired,
  isCommandProcessed,
  markCommandProcessed,
} from "../database.js";
import { initializeOpencodeForDirectory } from "../opencode.js";
import { sendReply } from "./messaging.js";
import { activeRequests, activeStreams, messageQueue } from "./state.js";
import { formatNumber, formatUsd, isRecord, safeDateTime } from "./utils.js";
import { readTokensFromAssistantMessage, addTokenTotals, getModelLimit } from "./stats.js";
import { resolveModel } from "./opencode.js";
import { toUserErrorMessage } from "./utils.js";

export function parseCommand(text: string): { name: string; args: string[] } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const parts = trimmed.slice(1).split(/\s+/);
  const name = parts.shift();
  if (!name) return null;
  return { name: name.toLowerCase(), args: parts };
}

export function parseBooleanArg(input: string | undefined): boolean | null {
  if (!input) return null;
  const normalized = input.trim().toLowerCase();
  if (["true", "yes", "y", "on", "1"].includes(normalized)) return true;
  if (["false", "no", "n", "off", "0"].includes(normalized)) return false;
  return null;
}

function expandUserPath(input: string): string {
  if (!input.startsWith("~/")) return input;
  const home = process.env.HOME || "";
  return home ? path.join(home, input.slice(2)) : input;
}

function resolveAccessibleDirectory(
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

function formatRelativeMs(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m${sec % 60}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h${min % 60}m`;
}

function previewText(text: string, maxLen = 80): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed.length <= maxLen) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxLen - 3))}...`;
}

export async function handleCommand(
  message: IncomingMessage,
  command: { name: string; args: string[] },
  options: SessionHandlerOptions,
): Promise<boolean> {
  const { provider } = options;
  switch (command.name) {
    case "new-session":
    case "new": {
      clearThreadSession(message.threadId);
      await sendReply(
        provider,
        message,
        "✅ 下一条消息将创建新会话。",
      );
      return true;
    }
    case "resume": {
      const sessionId = command.args[0];
      if (!sessionId) {
        const current = getThreadSession(message.threadId);
        await sendReply(
          provider,
          message,
          current ? `当前会话：${current}` : "未绑定会话。",
        );
        return true;
      }
      setThreadSession(message.threadId, sessionId);
      await sendReply(
        provider,
        message,
        `✅ 已将线程绑定到会话 ${sessionId}`,
      );
      return true;
    }
    case "abort": {
      const active = activeRequests.get(message.threadId);
      if (!active) {
        await sendReply(provider, message, "没有需要中止的活动请求。");
        return true;
      }
      active.controller.abort(new Error("abort"));
      const directory = resolveAccessibleDirectory(
        message.channelId,
        options.projectDirectory,
        options.logger,
      );
      const getClient = await initializeOpencodeForDirectory(
        directory,
        options.opencodeConfig,
      );
      if (!(getClient instanceof Error)) {
        try {
          await getClient().session.abort({
            path: { id: active.sessionId },
            query: { directory },
          });
        } catch {
          // ignore abort errors
        }
      }
      const streamState = activeStreams.get(message.threadId);
      if (streamState && provider.updateMessage) {
        await provider.updateMessage(streamState.placeholderId, { text: "🛑 已中止" });
        activeStreams.delete(message.threadId);
      }
      await sendReply(provider, message, "🛑 已中止当前请求。");
      return true;
    }
    case "queue": {
      const now = Date.now();
      const queue = messageQueue.get(message.threadId) || [];
      const active = activeRequests.get(message.threadId);

      const lines: string[] = [];
      lines.push("队列详情");
      lines.push(`- 活动请求: ${active ? `running (session=${active.sessionId})` : "none"}`);
      lines.push(`- 等待消息: ${queue.length}`);

      if (queue.length > 0) {
        const items = queue.slice(0, 10);
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          const age = formatRelativeMs(now - item.queuedAt);
          const text = previewText(item.message.text, 100);
          lines.push(`- #${i + 1} age=${age} user=${item.message.userId || "-"} text=${text || "-"}`);
        }
        if (queue.length > 10) {
          lines.push(`- ... 还有 ${queue.length - 10} 条未显示`);
        }
      }

      await sendReply(provider, message, lines.join("\n"));
      return true;
    }
    case "context": {
      const directory = resolveAccessibleDirectory(
        message.channelId,
        options.projectDirectory,
        options.logger,
      );

      const getClient = await initializeOpencodeForDirectory(
        directory,
        options.opencodeConfig,
      );
      if (getClient instanceof Error) {
        await sendReply(provider, message, `✗ ${toUserErrorMessage(getClient)}`);
        return true;
      }

      const sessionIdArg = command.args[0];
      const sessionId = sessionIdArg || getThreadSession(message.threadId);
      if (!sessionId) {
        await sendReply(provider, message, "未绑定会话。使用 /resume <会话ID> 或 /context <会话ID>。");
        return true;
      }

      const resolvedModel = await resolveModel(
        getClient,
        directory,
        sessionId,
        message.channelId,
        options.logger,
      );

      const sessionInfoResp = await getClient().session.get({
        path: { id: sessionId },
        query: { directory },
      });

      const messagesResp = await getClient().session.messages({
        path: { id: sessionId },
        query: { directory, limit: 200 },
      });

      const messageItems = messagesResp.data || [];
      let userCount = 0;
      let assistantCount = 0;
      let totalCost = 0;
      let totals = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
      let lastAssistant: Record<string, unknown> | null = null;

      for (const item of messageItems) {
        if (!isRecord(item)) continue;
        const info = item.info;
        if (!isRecord(info)) continue;
        const infoRec = info;
        const role = infoRec.role;
        if (role === "user") userCount += 1;
        if (role === "assistant") {
          assistantCount += 1;
          lastAssistant = infoRec;
          const cost = typeof infoRec.cost === "number" ? infoRec.cost : 0;
          totalCost += Number.isFinite(cost) ? cost : 0;
          totals = addTokenTotals(totals, readTokensFromAssistantMessage(infoRec));
        }
      }

      const limit = resolvedModel
        ? await getModelLimit(getClient, directory, resolvedModel)
        : null;

      const lastTokens = lastAssistant ? readTokensFromAssistantMessage(lastAssistant) : null;
      const lastInput = lastTokens?.input ?? 0;
      const ratio = limit && limit.context > 0 ? (lastInput / limit.context) : null;

      const lines: string[] = [];
      lines.push("上下文占用");
      lines.push(`- 会话: ${sessionId}`);
      lines.push(`- 目录: ${directory}`);

      if (sessionInfoResp.data) {
        const sessionInfo = sessionInfoResp.data as unknown;
        if (isRecord(sessionInfo) && isRecord(sessionInfo.time)) {
          const created = sessionInfo.time.created;
          const updated = sessionInfo.time.updated;
          lines.push(
            `- 会话时间: created=${safeDateTime(typeof created === "number" ? created : undefined)} updated=${safeDateTime(typeof updated === "number" ? updated : undefined)}`,
          );
        }
      }

      if (resolvedModel) {
        lines.push(`- 模型: ${resolvedModel.providerID}/${resolvedModel.modelID}`);
      } else {
        lines.push(`- 模型: -`);
      }

      if (limit) {
        lines.push(`- 上下文上限: ${formatNumber(limit.context)} tokens`);
        lines.push(`- 输出上限: ${formatNumber(limit.output)} tokens`);
      } else {
        lines.push(`- 上下文上限: -`);
      }

      lines.push(`- 消息数: user=${userCount} assistant=${assistantCount} total=${messageItems.length}`);
      lines.push(
        `- 累计用量(assistant): input=${formatNumber(totals.input)} output=${formatNumber(totals.output)} reasoning=${formatNumber(totals.reasoning)} cacheR=${formatNumber(totals.cacheRead)} cacheW=${formatNumber(totals.cacheWrite)} cost=${formatUsd(totalCost)}`,
      );

      if (lastAssistant) {
        const time = isRecord(lastAssistant.time) ? lastAssistant.time : undefined;
        const cost = typeof lastAssistant.cost === "number" ? lastAssistant.cost : 0;
        const atMs =
          typeof time?.completed === "number"
            ? time.completed
            : typeof time?.created === "number"
              ? time.created
              : undefined;
        lines.push(
          `- 最近一次(assistant): input=${formatNumber(lastTokens?.input ?? 0)} output=${formatNumber(lastTokens?.output ?? 0)} reasoning=${formatNumber(lastTokens?.reasoning ?? 0)} cost=${formatUsd(cost)} at=${safeDateTime(atMs)}`,
        );
        if (ratio !== null) {
          lines.push(`- 最近一次上下文占用: ${(ratio * 100).toFixed(1)}%`);
        }
      } else {
        lines.push("- 最近一次(assistant): -");
      }

      await sendReply(provider, message, lines.join("\n"));
      return true;
    }
    case "project":
    case "dir": {
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
      } catch (error) {
        await sendReply(
          provider,
          message,
          `✗ 目录不可访问或不存在：\`${targetPath}\`\n\n请确认路径或权限。`,
        );
        return true;
      }

      setChannelDirectory(message.channelId, targetPath);
      await sendReply(
        provider,
        message,
        `✅ 已设置当前频道目录：\n\n\`${targetPath}\``,
      );
      return true;
    }
    case "list-sessions": {
      const sessions = listThreadSessions();
      if (sessions.length === 0) {
        await sendReply(provider, message, "未找到会话。");
        return true;
      }
      const lines = sessions
        .slice(0, 20)
        .map((item) => `- ${item.threadId}: ${item.sessionId}`);
      await sendReply(provider, message, lines.join("\n"));
      return true;
    }
    case "model": {
      const arg = command.args.join(" ").trim();
      const sessionId = getThreadSession(message.threadId);
      if (!arg) {
        const sessionModel = sessionId ? getSessionModel(sessionId) : undefined;
        const channelModel = getChannelModel(message.channelId);
        await sendReply(
          provider,
          message,
          `会话模型：${sessionModel || "-"}\n频道模型：${channelModel || "-"}`,
        );
        return true;
      }
      if (arg === "clear") {
        if (sessionId) {
          clearSessionModel(sessionId);
        }
        await sendReply(provider, message, "✅ 模型偏好已清除。");
        return true;
      }
      if (sessionId) {
        setSessionModel(sessionId, arg);
        await sendReply(provider, message, `✅ 会话模型已设置为 ${arg}`);
      } else {
        setChannelModel(message.channelId, arg);
        await sendReply(provider, message, `✅ 频道模型已设置为 ${arg}`);
      }
      return true;
    }
    case "agent": {
      const arg = command.args.join(" ").trim();
      const sessionId = getThreadSession(message.threadId);
      if (!arg) {
        const sessionAgent = sessionId ? getSessionAgent(sessionId) : undefined;
        const channelAgent = getChannelAgent(message.channelId);
        await sendReply(
          provider,
          message,
          `会话代理：${sessionAgent || "-"}\n频道代理：${channelAgent || "-"}`,
        );
        return true;
      }
      if (sessionId) {
        setSessionAgent(sessionId, arg);
        await sendReply(provider, message, `✅ 会话代理已设置为 ${arg}`);
      } else {
        setChannelAgent(message.channelId, arg);
        await sendReply(provider, message, `✅ 频道代理已设置为 ${arg}`);
      }
      return true;
    }
    case "compact": {
      await sendReply(
        provider,
        message,
        "飞书暂未实现压缩功能。",
      );
      return true;
    }
    case "mention-required": {
      const current = getThreadMentionRequired(message.threadId) ?? true;
      const value = parseBooleanArg(command.args[0]);
      if (value === null) {
        await sendReply(
          provider,
          message,
          `当前线程需@机器人：${current ? "是" : "否"}。用法：/mention-required true|false`,
        );
        return true;
      }

      if (value && !options.botUserId) {
        await sendReply(
          provider,
          message,
          "请先在 feishu.json 配置 botUserId（机器人 open_id / user_id），否则无法判断是否@。",
        );
        return true;
      }

      setThreadMentionRequired(message.threadId, value);
      await sendReply(
        provider,
        message,
        `✅ 已设置该线程需@机器人：${value ? "是" : "否"}`,
      );
      return true;
    }
    case "update":
    case "deploy": {
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
        const pullResult = execSync("git pull", { encoding: "utf-8" }).trim();
        output += `✓ git pull 完成\n`;

        // 检查是否有新的提交
        const newCommit = execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
        if (newCommit !== currentCommit) {
          output += `✓ 更新到新提交: ${newCommit}\n`;

          // 检查 pnpm-lock.yaml 是否变化
          const lockChanged = execSync(
            `git diff ${currentCommit} ${newCommit} --name-only | grep -q "pnpm-lock.yaml" && echo "changed" || echo "same"`,
            { encoding: "utf-8" }
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
    }
    case "help": {
      const lines = [
        "**命令帮助**",
        "",
        "**会话**",
        "- `/new-session` 新建会话",
        "- `/resume <会话ID>` 绑定会话",
        "- `/abort` 中止当前请求",
        "- `/queue` 查看队列",
        "- `/context [会话ID]` 查看上下文占用",
        "- `/list-sessions` 列出会话",
        "",
        "**模型与代理**",
        "- `/model <提供商/模型|clear>` 设置/清除模型",
        "- `/agent <名称>` 设置 agent",
        "",
        "**项目目录**",
        "- `/project` 查看当前目录",
        "- `/project <path>` 设置当前频道目录",
        "- `/dir` 等同 `/project`",
        "",
        "**运行**",
        "- `/mention-required <true|false>` 线程是否必须@机器人",
        "- `/update` 或 `/deploy` 更新代码并重启",
        "- `/compact` 压缩会话（占位）",
        "- `/help` 查看帮助",
      ];
      await sendReply(provider, message, lines.join("\n"));
      return true;
    }
    default:
      return false;
  }
}
