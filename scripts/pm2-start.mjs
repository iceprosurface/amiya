import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const targetDirArg = process.argv[2];
if (!targetDirArg || targetDirArg === "--help" || targetDirArg === "-h") {
  console.error("Usage: node scripts/pm2-start.mjs /path/to/your/project");
  process.exit(1);
}

const repoRoot = process.cwd();
const targetDir = path.resolve(targetDirArg);
const dataDir = path.join(targetDir, ".amiya");
const configPath = path.join(dataDir, "pm2.config.cjs");
const bootstrapPath = path.join(dataDir, "bootstrap.sh");
const scriptPath = path.join(repoRoot, "dist", "index.js");

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const bootstrapContent = `#!/usr/bin/env bash\nset -euo pipefail\n\ncd \"${repoRoot.replace(/\\/g, "\\\\")}\"\nnode \"${scriptPath.replace(/\\/g, "\\\\")}\" -- \"${targetDir.replace(/\\/g, "\\\\")}\"\n`;

const configContent = `module.exports = {\n  apps: [\n    {\n      name: \"amiya\",\n      script: \"${bootstrapPath.replace(/\\/g, "\\\\")}\",\n      cwd: \"${repoRoot.replace(/\\/g, "\\\\")}\",\n      instances: 1,\n      autorestart: true,\n      watch: false,\n      env: {\n        NODE_ENV: \"production\",\n      },\n    },\n  ],\n};\n`;

fs.writeFileSync(bootstrapPath, bootstrapContent, "utf8");
fs.chmodSync(bootstrapPath, 0o755);
fs.writeFileSync(configPath, configContent, "utf8");

console.log(`Generated bootstrap script at: ${bootstrapPath}`);
console.log(`Generated PM2 config at: ${configPath}`);

execSync("pnpm build", { stdio: "inherit" });
execSync(`pm2 start ${configPath}`, { stdio: "inherit" });
execSync("pm2 save", { stdio: "inherit" });

console.log("PM2 start complete.");
