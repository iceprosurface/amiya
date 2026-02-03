import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let dataDir: string | null = null;
let workspaceBaseDir: string | null = null;

export type RuntimeConfig = {
  locale?: string;
  workspaceDir?: string;
};

type RuntimeLogger = (message: string, level?: "debug" | "info" | "warn" | "error") => void;

export function getDataDir(): string {
  if (!dataDir) {
    dataDir = path.join(process.cwd(), ".amiya");
  }
  return dataDir;
}

export function setDataDir(dir: string): void {
  const resolved = path.resolve(dir);
  if (!fs.existsSync(resolved)) {
    fs.mkdirSync(resolved, { recursive: true });
  }
  dataDir = resolved;
}

function resolveHomePath(input: string): string {
  if (!input.startsWith("~/")) return input;
  const home = os.homedir();
  return home ? path.join(home, input.slice(2)) : input;
}

export function getWorkspaceBaseDir(): string {
  if (!workspaceBaseDir) {
    workspaceBaseDir = path.join(os.homedir(), ".amiya-project");
  }
  if (!fs.existsSync(workspaceBaseDir)) {
    fs.mkdirSync(workspaceBaseDir, { recursive: true });
  }
  return workspaceBaseDir;
}

export function setWorkspaceBaseDir(dir: string): void {
  const resolved = path.resolve(resolveHomePath(dir));
  if (!fs.existsSync(resolved)) {
    fs.mkdirSync(resolved, { recursive: true });
  }
  workspaceBaseDir = resolved;
}

export function loadRuntimeConfig(logger?: RuntimeLogger): RuntimeConfig {
  const configPath = path.join(getDataDir(), "config.json");
  if (!fs.existsSync(configPath)) return {};
  try {
    const content = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== "object") return {};
    const record = parsed as Record<string, unknown>;
    const locale = typeof record.locale === "string" ? record.locale : undefined;
    const workspaceDir = typeof record.workspaceDir === "string" ? record.workspaceDir : undefined;
    return { locale, workspaceDir };
  } catch (error) {
    logger?.(`Failed to read ${configPath}: ${error}`, "warn");
    return {};
  }
}
