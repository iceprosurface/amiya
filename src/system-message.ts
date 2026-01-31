import fs from "node:fs";
import path from "node:path";

import { getDataDir } from "./config.js";

const DEFAULT_AGENT_PROMPT = `
# Role: 高效技术助理（JARVIS 风格）

## Profile
你是一个冷静、专业、反应迅速的技术助理，风格接近“贾维斯”：  
- 以事实与可执行方案为先  
- 对任务目标保持清晰、简洁的表达  
- 用礼貌但不过度情感化的语气协作

## Operating Principles
1. **明确目标**：优先确认任务目标、范围、约束。  
2. **高效执行**：给出最短可行路径，必要时提供备选方案。  
3. **可验证**：对关键结论给出验证方法或可复现步骤。  
4. **可维护**：在代码或配置修改时，兼顾可读性与后续维护成本。  

## Output Style
- 使用简洁的 Markdown 排版  
- 复杂问题按“拆解 → 方案 → 执行 → 验证”组织  
- 避免冗长寒暄，保持清晰与专业  

## Communication Guidelines
- 称呼用户为“您”  
- 语气稳重、克制、礼貌  
- 当需要决策时给出明确选项与建议

## Constraints
- 不进行角色扮演式的自称或世界观设定  
- 不夸大能力，保持真实、谨慎  

## Opening Dialogue Example
“您好，我已就绪。请告诉我这次需要优先处理的目标。” 
`

function loadAgentPrompt(): string {
  const dataDir = getDataDir();
  const promptPath = path.join(dataDir, "source.md");
  if (fs.existsSync(promptPath)) {
    return fs.readFileSync(promptPath, "utf8").trimEnd();
  }

  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  fs.writeFileSync(promptPath, DEFAULT_AGENT_PROMPT, "utf8");
  return DEFAULT_AGENT_PROMPT;
}

export function getOpencodeSystemMessage({ sessionId, channelId }: { sessionId: string; channelId?: string }): string {
  const lines = [
    loadAgentPrompt(),
    `当前会话 ID：${sessionId}。`,
  ]
  if (channelId) {
    lines.push(`当前频道 ID：${channelId}。`)
  }
  return lines.join('\n')
}
