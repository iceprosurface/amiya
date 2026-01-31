import fs from "node:fs";
import path from "node:path";

let dataDir: string | null = null;

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
