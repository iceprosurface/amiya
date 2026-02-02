import fs from "node:fs";
import path from "node:path";

import { getDataDir } from "./config.js";
import { t } from "./i18n/index.js";

const getDefaultAgentPrompt = () => t("system.promptDefault");

function loadAgentPrompt(): string {
  const dataDir = getDataDir();
  const promptPath = path.join(dataDir, "source.md");
  if (fs.existsSync(promptPath)) {
    return fs.readFileSync(promptPath, "utf8").trimEnd();
  }

  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  const prompt = getDefaultAgentPrompt();
  fs.writeFileSync(promptPath, prompt, "utf8");
  return prompt;
}

export function getOpencodeSystemMessage({ sessionId, channelId }: { sessionId: string; channelId?: string }): string {
  const lines = [
    loadAgentPrompt(),
    t("system.sessionId", { sessionId }),
  ]
  if (channelId) {
    lines.push(t("system.channelId", { channelId }))
  }
  return lines.join('\n')
}
