import { execSync } from "node:child_process";

let cachedVersion: string | null | undefined;

export function getRuntimeVersion(): string | null {
  if (cachedVersion !== undefined) return cachedVersion;
  try {
    const hash = execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
    cachedVersion = hash || null;
  } catch {
    cachedVersion = null;
  }
  return cachedVersion;
}
