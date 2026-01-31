import { isRecord } from "./utils.js";

export function extractTextFromPromptResult(result: unknown): string {
  let parts: unknown = [];
  if (isRecord(result)) {
    const data = result.data;
    if (isRecord(data) && Array.isArray(data.parts)) {
      parts = data.parts;
    } else if (Array.isArray(result.parts)) {
      parts = result.parts;
    }
  }

  if (!Array.isArray(parts)) return "";

  const textParts: string[] = [];
  const toolOutputs: string[] = [];
  const subtaskLines: string[] = [];
  let hasReasoning = false;

  for (const part of parts) {
    if (!isRecord(part)) continue;
    const type = part.type;

    if (type === "text") {
      const text = typeof part.text === "string" ? part.text : "";
      if (text) textParts.push(text);
      continue;
    }

    if (type === "reasoning") {
      hasReasoning = true;
      continue;
    }

    if (type === "subtask") {
      const description =
        typeof part.description === "string" ? part.description : "";
      const agent = typeof part.agent === "string" ? part.agent : "";
      const prompt = typeof part.prompt === "string" ? part.prompt : "";
      const label = description || prompt || "子任务";
      const agentInfo = agent ? `（agent: ${agent}）` : "";
      subtaskLines.push(`- ${label}${agentInfo}`);
      continue;
    }

    if (type === "tool") {
      const toolName = typeof part.tool === "string" ? part.tool : "tool";
      if (toolName === "question") {
        continue;
      }
      const state = isRecord(part.state) ? part.state : undefined;
      if (!state) continue;
      const status = typeof state.status === "string" ? state.status : "unknown";

      if (status === "completed") {
        const output = typeof state.output === "string" ? state.output : "";
        if (output) {
          toolOutputs.push(`[#${toolName}] ${output}`);
        }
      } else if (status === "error") {
        const error = typeof state.error === "string" ? state.error : "unknown";
        toolOutputs.push(`[#${toolName}] ❌ ${error}`);
      } else if (status === "running" || status === "pending") {
        const input = isRecord(state.input) ? JSON.stringify(state.input) : "";
        const title =
          typeof state.title === "string" && state.title.length > 0
            ? state.title
            : "";
        const header = title ? `${title} (${status})` : status;
        if (input) {
          toolOutputs.push(`[#${toolName}] ${header}\n${input}`);
        } else {
          toolOutputs.push(`[#${toolName}] ${header}`);
        }
      }
      continue;
    }
  }

  const sections: string[] = [];
  const text = textParts.join("\n").trim();
  if (text) sections.push(text);

  if (subtaskLines.length > 0) {
    sections.push("— 子任务 —");
    sections.push(subtaskLines.join("\n"));
  }

  if (toolOutputs.length > 0) {
    sections.push("— 子任务/工具输出 —");
    sections.push(toolOutputs.join("\n"));
  }

  if (hasReasoning) {
    sections.unshift("— 思考中 —");
  }

  return sections.join("\n\n").trim();
}
