import { isRecord } from "./utils.js";

export function extractPartsFromPromptResult(result: unknown): unknown[] {
  if (!isRecord(result)) return [];

  const data = isRecord(result.data) ? result.data : undefined;
  if (Array.isArray(data?.parts)) return data.parts;
  if (Array.isArray(result.parts)) return result.parts;

  const message = isRecord(data?.message) ? data.message : undefined;
  if (Array.isArray(message?.parts)) return message.parts;
  const messageContent = isRecord(message?.content) ? message.content : undefined;
  if (Array.isArray(messageContent?.parts)) return messageContent.parts;

  const messages = Array.isArray(data?.messages) ? data.messages : undefined;
  const firstMessage = isRecord(messages?.[0]) ? messages?.[0] : undefined;
  if (Array.isArray(firstMessage?.parts)) return firstMessage.parts;
  const firstContent = isRecord(firstMessage?.content) ? firstMessage.content : undefined;
  if (Array.isArray(firstContent?.parts)) return firstContent.parts;

  const resultData = isRecord(data?.result) ? data.result : undefined;
  if (Array.isArray(resultData?.parts)) return resultData.parts;
  const resultMessage = isRecord(resultData?.message) ? resultData.message : undefined;
  if (Array.isArray(resultMessage?.parts)) return resultMessage.parts;

  return [];
}

export function extractTextFromPromptResult(result: unknown): string {
  const parts = extractPartsFromPromptResult(result);
  if (parts.length === 0) return "";

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

      const formatToolBlock = (label: string, body?: string): string => {
        if (body && body.trim().length > 0) {
          return `> ${label}\n\n\`\`\`\n${body}\n\`\`\``;
        }
        return `> ${label}`;
      };

      if (status === "completed") {
        const output = typeof state.output === "string" ? state.output : "";
        toolOutputs.push(formatToolBlock(`[#${toolName}]`, output));
      } else if (status === "error") {
        const error = typeof state.error === "string" ? state.error : "unknown";
        toolOutputs.push(formatToolBlock(`[#${toolName}] ❌`, error));
      } else if (status === "running" || status === "pending") {
        const input = isRecord(state.input) ? JSON.stringify(state.input) : "";
        const title =
          typeof state.title === "string" && state.title.length > 0
            ? state.title
            : "";
        const header = title ? `${title} (${status})` : status;
        toolOutputs.push(formatToolBlock(`[#${toolName}] ${header}`, input));
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
