import type { Logger } from "winston";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { setDataDir } from "./config.js";
import { handleIncomingMessage } from "./session/session-handler.js";
import { setupLogger, defaultLogger } from "./logger/index.js";
import { acquireSingleInstanceLock } from "./runtime/single-instance-lock.js";
import { createFeishuProvider } from "./providers/feishu/feishu-provider.js";
import { getRuntimeVersion } from "./version.js";
import {
  type FeishuConfig,
  validateConfig,
} from "./providers/feishu/feishu-config.js";
import type { MessageProvider } from "./types.js";

export async function startAmiya(targetDir: string) {
  const logger = setupLogger(targetDir);
  logger.info(`Amiya starting... target: ${targetDir}`);

  const loaded = loadFeishuConfig(targetDir, logger);
  if (!loaded) {
    logger.error("feishu.json 配置无效或缺失。");
    logger.info("请在当前目录或 .amiya 下创建 feishu.json");
    process.exit(1);
  }

  const { config, path: configPath } = loaded;
  logger.info(`Loaded config: ${configPath}`);
  logger.info(`Config directory: ${dirname(configPath)}`);

  try {
    process.chdir(targetDir);
    logger.debug(`Working directory: ${targetDir}`);
  } catch (err) {
    logger.warn(`Failed to chdir: ${err}`);
  }

  setDataDir(join(targetDir, ".amiya"));

  const runtimeVersion = getRuntimeVersion();
  if (runtimeVersion) {
    logger.info(`Version: ${runtimeVersion}`);
  }

  let lockRelease: (() => void) | null = null;
  try {
    const lock = acquireSingleInstanceLock(
      join(targetDir, ".amiya", "amiya.lock"),
      (msg, level) => {
        logger.log({ level: level || "info", message: msg });
      },
    );
    lockRelease = lock.release;
  } catch (e) {
    logger.error(`Failed to acquire lock: ${e}`);
    process.exit(1);
  }

  const provider = createFeishuProvider({
    config,
    logger: (msg, level) =>
      logger.log({ level: level || "info", message: msg }),
  });

  const opencodeConfig = config.model ? { model: config.model } : undefined;

  provider.onMessage(async (message, extra) => {
    await handleIncomingMessage(message, {
      provider,
      projectDirectory: targetDir,
      logger: (msg, level) =>
        logger.log({ level: level || "info", message: msg }),
      opencodeConfig,
      streaming: config.streaming,
      requireUserWhitelist: config.requireUserWhitelist,
      adminUserIds: config.adminUserIds,
      botUserId: config.botUserId,
      adminChatId: config.adminChatId
        ?? (config.allowedChatIds && config.allowedChatIds.length > 0 ? config.allowedChatIds[0] : undefined),
      sendApprovalCard: (adminChatId: string, params: { requestId: string; channelId: string; userId: string; userName?: string }) => {
        const providerWithClient = provider as MessageProvider & { getFeishuClient?: () => Record<string, unknown> | null };
        const client = providerWithClient.getFeishuClient?.();
        if (!client || typeof client.sendApprovalCard !== 'function') return Promise.resolve(null);
        return client.sendApprovalCard(adminChatId, params) as Promise<string | null>;
      },
      sendApprovalCardInThread: (messageId: string, params: { requestId: string; channelId: string; userId: string; userName?: string }) => {
        const providerWithClient = provider as MessageProvider & { getFeishuClient?: () => Record<string, unknown> | null };
        const client = providerWithClient.getFeishuClient?.();
        if (!client || typeof client.replyApprovalCardWithId !== 'function') return Promise.resolve(null);
        return client.replyApprovalCardWithId(messageId, params, { replyInThread: true }) as Promise<string | null>;
      },
      updateApprovalCard: (messageId: string, status: 'approved' | 'rejected', actionBy: string) => {
        const providerWithClient = provider as MessageProvider & { getFeishuClient?: () => Record<string, unknown> | null };
        const client = providerWithClient.getFeishuClient?.();
        if (!client || typeof client.updateApprovalCard !== 'function') return Promise.resolve(false);
        return client.updateApprovalCard(messageId, status, actionBy) as Promise<boolean>;
      },
      isCardAction: extra?.isCardAction,
      cardActionData: extra?.cardActionData,
      questionResponse: extra?.questionResponse,
      questionNav: extra?.questionNav,
      permissionResponse: extra?.permissionResponse,
    });
  });

  await provider.start();
  logger.info("Amiya 已上线 ✅");

  setInterval(() => {
    logger.debug("Amiya 心跳检测");
  }, 60000);

  let cleaningUp = false;
  const cleanup = async (signal: string, exitCode = 0) => {
    if (cleaningUp) return;
    cleaningUp = true;
    logger.info(`Signal ${signal}, cleaning up...`);
    try {
      await provider.stop();
      logger.info("提供商已停止");
    } catch (e) {
      logger.error(`停止提供商失败：${e}`);
    }
    try {
      lockRelease?.();
    } catch {
      // ignore
    }
    process.exit(exitCode);
  };

  process.once("exit", () => {
    try {
      lockRelease?.();
    } catch {
      // ignore
    }
  });

  process.once("uncaughtException", (err) => {
    logger.error(`Uncaught exception: ${err}`);
    cleanup("uncaughtException", 1).catch(() => {});
  });

  process.once("unhandledRejection", (reason) => {
    logger.error(`Unhandled rejection: ${String(reason)}`);
    cleanup("unhandledRejection", 1).catch(() => {});
  });

  process.on("SIGINT", () => cleanup("SIGINT"));
  process.on("SIGTERM", () => cleanup("SIGTERM"));
}

function loadFeishuConfig(
  projectDir: string,
  logger: Logger,
): { config: FeishuConfig; path: string } | null {
  const paths = [
    join(projectDir, ".amiya", "feishu.json"),
    join(projectDir, "feishu.json"),
    resolve(projectDir, "../.amiya/feishu.json"),
    resolve(projectDir, "../feishu.json"),
    join(process.cwd(), ".amiya", "feishu.json"),
    join(process.cwd(), "feishu.json"),
  ];

  for (const configPath of paths) {
    if (existsSync(configPath)) {
      try {
        const content = readFileSync(configPath, "utf-8");
        const config = JSON.parse(content);
        if (validateConfig(config)) return { config, path: configPath };
        logger.error(`Invalid config: ${configPath}`);
      } catch (error) {
        logger.error(`Failed to read config ${configPath}: ${error}`);
      }
    }
  }

  return null;
}

function parseStartArgs(argv: string[]) {
  const args = [...argv];
  let start = false;
  let target: string | undefined;

  const startIndex = args.findIndex((arg) => arg === "--start" || arg.startsWith("--start="));
  if (startIndex !== -1) {
    start = true;
    const arg = args[startIndex];
    if (arg.startsWith("--start=")) {
      target = arg.slice("--start=".length) || undefined;
    } else {
      const next = args[startIndex + 1];
      if (next && !next.startsWith("-")) target = next;
    }
  }

  const sepIndex = args.indexOf("--");
  if (sepIndex !== -1) {
    const next = args[sepIndex + 1];
    if (next && !next.startsWith("-")) target = next;
  }

  const targetDir =
    target && target !== "."
      ? resolve(process.cwd(), target)
      : process.cwd();

  return { start, targetDir };
}

const { start, targetDir } = parseStartArgs(process.argv.slice(2));
if (start) {
  startAmiya(targetDir).catch((err) => {
    defaultLogger.error(`Bot startup failed: ${err}`);
    process.exit(1);
  });
}
