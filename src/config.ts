import fs from "node:fs";
import path from "node:path";

let dataDir: string | null = null;

export type RuntimeConfig = {
  locale?: string;
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

export function loadRuntimeConfig(logger?: RuntimeLogger): RuntimeConfig {
  const configPath = path.join(getDataDir(), "config.json");
  if (!fs.existsSync(configPath)) return {};
  try {
    const content = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== "object") return {};
    const record = parsed as Record<string, unknown>;
    const locale = typeof record.locale === "string" ? record.locale : undefined;
    return { locale };
  } catch (error) {
    logger?.(`Failed to read ${configPath}: ${error}`, "warn");
    return {};
  }
}
