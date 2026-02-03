import type { Logger } from "winston";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { loadRuntimeConfig, setDataDir, setWorkspaceBaseDir } from "./config.js";
import { initI18n, t } from "./i18n/index.js";
import { defaultLogger, setupLogger } from "./logger/index.js";
import {
  validateConfig,
  type FeishuConfig,
} from "./providers/feishu/feishu-config.js";
import { createFeishuProvider } from "./providers/feishu/feishu-provider.js";
import { acquireSingleInstanceLock } from "./runtime/single-instance-lock.js";
import { shutdownOpencodeServers } from "./opencode.js";
import { handleIncomingMessage } from "./session/session-handler.js";
import { getRuntimeVersion } from "./version.js";

export async function startAmiya(targetDir: string) {
  const logger = setupLogger(targetDir);
  logger.info(`Amiya starting... target: ${targetDir}`);

  setDataDir(join(targetDir, ".amiya"));
  const runtimeConfig = loadRuntimeConfig((message, level) => {
    logger.log({ level: level || "info", message });
  });
  initI18n(runtimeConfig.locale);
  if (runtimeConfig.workspaceDir) {
    setWorkspaceBaseDir(runtimeConfig.workspaceDir);
  }

  const loaded = loadFeishuConfig(targetDir, logger);
  if (!loaded) {
    logger.error(t("index.feishuInvalid"));
    logger.info(t("index.feishuHint"));
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

  let botUserId = config.botUserId;
  if (!botUserId && typeof provider.getBotUserId === 'function') {
    try {
      const detectedBotUserId = await provider.getBotUserId();
      if (detectedBotUserId) {
        botUserId = detectedBotUserId;
        logger.info(`Auto-detected botUserId: ${botUserId}`);
      } else {
        logger.warn('Failed to auto-detect botUserId from API');
      }
    } catch (error) {
      logger.warn(`Auto-detection of botUserId failed: ${error}`);
    }
  }

  const opencodeConfig = config.model ? { model: config.model } : undefined;

  provider.onMessage(async (message, extra) => {
    await handleIncomingMessage(message, {
      provider,
      projectDirectory: targetDir,
      logger: (msg, level) =>
        logger.log({ level: level || "info", message: msg }),
      opencodeConfig,
      streaming: config.streaming,
      toolOutputFileThreshold: config.toolOutputFileThreshold,
      requireUserWhitelist: config.requireUserWhitelist,
      adminUserIds: config.adminUserIds,
      botUserId: botUserId,
      adminChatId: config.adminChatId
        ?? (config.allowedChatIds && config.allowedChatIds.length > 0 ? config.allowedChatIds[0] : undefined),
      sendApprovalCard: (adminChatId: string, params: { requestId: string; channelId: string; userId: string; userName?: string }) => {
        const client = provider.getFeishuClient?.();
        if (!client || typeof client.sendApprovalCard !== 'function') return Promise.resolve(null);
        return client.sendApprovalCard(adminChatId, params);
      },
      sendApprovalCardInThread: (messageId: string, params: { requestId: string; channelId: string; userId: string; userName?: string }) => {
        const client = provider.getFeishuClient?.();
        if (!client || typeof client.replyApprovalCardWithId !== 'function') return Promise.resolve(null);
        return client.replyApprovalCardWithId(messageId, params, { replyInThread: true });
      },
      updateApprovalCard: (messageId: string, status: 'approved' | 'rejected', actionBy: string) => {
        const client = provider.getFeishuClient?.();
        if (!client || typeof client.updateApprovalCard !== 'function') return Promise.resolve(false);
        return client.updateApprovalCard(messageId, status, actionBy);
      },
      isCardAction: extra?.isCardAction,
      cardActionData: extra?.cardActionData,
      questionResponse: extra?.questionResponse,
      questionNav: extra?.questionNav,
      permissionResponse: extra?.permissionResponse,
      workspaceAction: extra?.workspaceAction,
    });
  });

  await provider.start();
  logger.info(t("index.online"));

  setInterval(() => {
    logger.debug(t("index.heartbeat"));
  }, 60000);

  let cleaningUp = false;
  const cleanup = async (signal: string, exitCode = 0) => {
    if (cleaningUp) return;
    cleaningUp = true;
    logger.info(`Signal ${signal}, cleaning up...`);
    try {
      await provider.stop();
      logger.info(t("index.providerStopped"));
    } catch (e) {
      logger.error(t("index.providerStopFailed", { error: String(e) }));
    }
    try {
      shutdownOpencodeServers();
      logger.info("OpenCode servers stopped");
    } catch (e) {
      logger.error(t("index.serverStopFailed", { error: String(e) }));
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
