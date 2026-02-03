import { t } from "../i18n/index.js";
import { isRecord } from "./utils.js";

const XML_OUTPUT_MAX_CHARS = 4000;

type ToolRunXml = {
  tool: string;
  status: string;
  title?: string;
  input?: string;
  output?: string;
  error?: string;
  outputTruncated?: boolean;
  outputFileName?: string;
  partId?: string;
  messageId?: string;
};

type PartXml = {
  type: string;
  orderIndex: number;
  messageId?: string;
  text?: string;
  reasoning?: string;
  description?: string;
  prompt?: string;
  agent?: string;
  tool?: string;
  status?: string;
  title?: string;
  input?: string;
  output?: string;
  error?: string;
  outputTruncated?: boolean;
  outputFileName?: string;
};

const truncateForXml = (text: string | undefined): { value?: string; truncated: boolean } => {
  if (!text) return { value: text, truncated: false };
  if (text.length <= XML_OUTPUT_MAX_CHARS) return { value: text, truncated: false };
  return { value: text.slice(0, XML_OUTPUT_MAX_CHARS), truncated: true };
};

const escapeAttribute = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const wrapCdata = (value: string) => {
  const safe = value.split("]]>").join("]]]><![CDATA[>");
  return `<![CDATA[${safe}]]>`;
};

const buildAmiyaXmlEnvelope = (runs: ToolRunXml[], parts: PartXml[]): string => {
  if (runs.length === 0 && parts.length === 0) return "";
  const partBlocks = parts.length > 0
    ? `<parts>${parts
        .map((part) => {
          const attrs: string[] = [
            `type="${escapeAttribute(part.type)}"`,
            `orderIndex="${part.orderIndex}"`,
          ];
          if (part.messageId) attrs.push(`messageId="${escapeAttribute(part.messageId)}"`);
          if (part.tool) attrs.push(`tool="${escapeAttribute(part.tool)}"`);
          if (part.status) attrs.push(`status="${escapeAttribute(part.status)}"`);
          if (part.title) attrs.push(`title="${escapeAttribute(part.title)}"`);
          if (part.description) attrs.push(`description="${escapeAttribute(part.description)}"`);
          if (part.prompt) attrs.push(`prompt="${escapeAttribute(part.prompt)}"`);
          if (part.agent) attrs.push(`agent="${escapeAttribute(part.agent)}"`);
          if (part.outputTruncated) attrs.push('outputTruncated="true"');
          if (part.outputFileName) {
            attrs.push(`outputFileName="${escapeAttribute(part.outputFileName)}"`);
          }
          const text = part.text ? `<text encoding="text">${wrapCdata(part.text)}</text>` : "";
          const reasoning = part.reasoning
            ? `<reasoning encoding="text">${wrapCdata(part.reasoning)}</reasoning>`
            : "";
          const input = part.input ? `<input encoding="text">${wrapCdata(part.input)}</input>` : "";
          const output = part.output ? `<output encoding="text">${wrapCdata(part.output)}</output>` : "";
          const error = part.error ? `<error encoding="text">${wrapCdata(part.error)}</error>` : "";
          return `<part ${attrs.join(" ")}>${text}${reasoning}${input}${output}${error}</part>`;
        })
        .join("")}</parts>`
    : "";
  const runBlocks = runs
    .map((run) => {
      const attrs: string[] = [
        `tool="${escapeAttribute(run.tool)}"`,
        `status="${escapeAttribute(run.status)}"`,
      ];
      if (run.title) attrs.push(`title="${escapeAttribute(run.title)}"`);
      if (run.partId) attrs.push(`partId="${escapeAttribute(run.partId)}"`);
      if (run.messageId) attrs.push(`messageId="${escapeAttribute(run.messageId)}"`);
      if (run.outputTruncated) attrs.push('outputTruncated="true"');
      if (run.outputFileName) {
        attrs.push(`outputFileName="${escapeAttribute(run.outputFileName)}"`);
      }
      const input = run.input ? `<input encoding="text">${wrapCdata(run.input)}</input>` : "";
      const output = run.output ? `<output encoding="text">${wrapCdata(run.output)}</output>` : "";
      const error = run.error ? `<error encoding="text">${wrapCdata(run.error)}</error>` : "";
      return `<tool-run ${attrs.join(" ")}>${input}${output}${error}</tool-run>`;
    })
    .join("");
  const toolRunsBlock = runs.length > 0
    ? `<tool-runs>${runBlocks}</tool-runs>`
    : "";
  return `<!--AMYIA_XML<amiya version="1">${partBlocks}${toolRunsBlock}</amiya>-->`;
};

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

export function buildAmiyaXmlFromParts(parts: unknown[]): string {
  if (parts.length === 0) return "";
  const toolRuns: ToolRunXml[] = [];
  const partBlocks: PartXml[] = [];
  for (const part of parts) {
    if (!isRecord(part)) continue;
    if (part.type !== "tool") continue;
    const toolName = typeof part.tool === "string" ? part.tool : "tool";
    if (toolName === "question") continue;
    const state = isRecord(part.state) ? part.state : undefined;
    if (!state) continue;
    const status = typeof state.status === "string" ? state.status : "unknown";
    const title = typeof state.title === "string" ? state.title : undefined;
    const partId = typeof part.id === "string" ? part.id : undefined;
    const messageId = typeof part.messageID === "string" ? part.messageID : undefined;

    if (status === "completed") {
      const output = typeof state.output === "string" ? state.output : "";
      const truncated = truncateForXml(output);
      toolRuns.push({
        tool: toolName,
        status,
        title,
        output: truncated.value,
        outputTruncated: truncated.truncated,
        partId,
        messageId,
      });
      continue;
    }

    if (status === "error") {
      const error = typeof state.error === "string" ? state.error : "";
      const truncated = truncateForXml(error);
      toolRuns.push({
        tool: toolName,
        status,
        title,
        error: truncated.value,
        outputTruncated: truncated.truncated,
        partId,
        messageId,
      });
      continue;
    }

    if (status === "running" || status === "pending") {
      const inputValue = state.input;
      const inputText =
        typeof inputValue === "string"
          ? inputValue
          : inputValue !== undefined
            ? JSON.stringify(inputValue)
            : "";
      const truncated = truncateForXml(inputText);
      toolRuns.push({
        tool: toolName,
        status,
        title,
        input: truncated.value,
        outputTruncated: truncated.truncated,
        partId,
        messageId,
      });
    }
  }
  for (const [orderIndex, part] of parts.entries()) {
    if (!isRecord(part)) continue;
    const type = typeof part.type === "string" ? part.type : "unknown";
    const messageId = typeof part.messageID === "string" ? part.messageID : undefined;
    const partBlock: PartXml = { type, orderIndex, messageId };
    if (type === "text") {
      const text = typeof part.text === "string" ? part.text : "";
      const truncated = truncateForXml(text);
      partBlock.text = truncated.value;
    } else if (type === "reasoning") {
      const reasoning = typeof part.reasoning === "string"
        ? part.reasoning
        : typeof part.text === "string"
          ? part.text
          : "";
      const truncated = truncateForXml(reasoning);
      partBlock.reasoning = truncated.value;
    } else if (type === "subtask") {
      partBlock.description = typeof part.description === "string" ? part.description : undefined;
      partBlock.prompt = typeof part.prompt === "string" ? part.prompt : undefined;
      partBlock.agent = typeof part.agent === "string" ? part.agent : undefined;
    } else if (type === "step-start") {
      const title = typeof part.text === "string"
        ? part.text
        : typeof part.description === "string"
          ? part.description
          : typeof part.prompt === "string"
            ? part.prompt
            : "";
      const truncated = truncateForXml(title);
      partBlock.text = truncated.value;
    } else if (type === "tool") {
      const toolName = typeof part.tool === "string" ? part.tool : "tool";
      if (toolName !== "question") {
        partBlock.tool = toolName;
        const state = isRecord(part.state) ? part.state : undefined;
        const status = typeof state?.status === "string" ? state.status : "unknown";
        partBlock.status = status;
        partBlock.title = typeof state?.title === "string" ? state.title : undefined;
        const inputValue = state?.input;
        const inputText =
          typeof inputValue === "string"
            ? inputValue
            : inputValue !== undefined
              ? JSON.stringify(inputValue)
              : "";
        const outputValue = state?.output;
        const outputText =
          typeof outputValue === "string"
            ? outputValue
            : outputValue !== undefined
              ? JSON.stringify(outputValue)
              : "";
        const errorValue = state?.error;
        const errorText =
          typeof errorValue === "string"
            ? errorValue
            : errorValue !== undefined
              ? JSON.stringify(errorValue)
              : "";
        if (status === "completed") {
          const truncated = truncateForXml(outputText);
          partBlock.output = truncated.value;
          partBlock.outputTruncated = truncated.truncated;
        } else if (status === "error") {
          const truncated = truncateForXml(errorText);
          partBlock.error = truncated.value;
          partBlock.outputTruncated = truncated.truncated;
        } else if (status === "running" || status === "pending") {
          const truncated = truncateForXml(inputText);
          partBlock.input = truncated.value;
          partBlock.outputTruncated = truncated.truncated;
        }
      }
    }
    partBlocks.push(partBlock);
  }

  return buildAmiyaXmlEnvelope(toolRuns, partBlocks);
}

export function extractTextFromPromptResult(result: unknown): string {
  const parts = extractPartsFromPromptResult(result);
  if (parts.length === 0) return "";

  const textParts: string[] = [];
  const toolOutputs: string[] = [];
  const subtaskLines: string[] = [];
  const toolRuns: ToolRunXml[] = [];
  let hasReasoning = false;

  for (const part of parts) {
    if (!isRecord(part)) {
      // skip
    } else {
      const type = part.type;

      if (type === "text") {
        const text = typeof part.text === "string" ? part.text : "";
        if (text) textParts.push(text);
      } else if (type === "reasoning") {
        hasReasoning = true;
      } else if (type === "subtask") {
        const description =
          typeof part.description === "string" ? part.description : "";
        const agent = typeof part.agent === "string" ? part.agent : "";
        const prompt = typeof part.prompt === "string" ? part.prompt : "";
        const label = description || prompt || t("labels.subtask");
        const agentInfo = agent ? t("labels.agentInfo", { agent }) : "";
        subtaskLines.push(`- ${label}${agentInfo}`);
      } else if (type === "tool") {
        const toolName = typeof part.tool === "string" ? part.tool : "tool";
        if (toolName !== "question") {
          const state = isRecord(part.state) ? part.state : undefined;
          if (!state) {
            // ignore
          } else {
            const status = typeof state.status === "string" ? state.status : "unknown";
            const title = typeof state.title === "string" ? state.title : undefined;
            const inputValue = state.input;
            const inputText =
              typeof inputValue === "string"
                ? inputValue
                : inputValue !== undefined
                  ? JSON.stringify(inputValue)
                  : "";

            const formatToolBlock = (label: string, body?: string): string => {
              if (body && body.trim().length > 0) {
                return `> ${label}\n\n\`\`\`\n${body}\n\`\`\``;
              }
              return `> ${label}`;
            };

            if (status === "completed") {
              const output = typeof state.output === "string" ? state.output : "";
              toolOutputs.push(formatToolBlock(`[#${toolName}]`, output));
              const truncated = truncateForXml(output);
              toolRuns.push({
                tool: toolName,
                status,
                title,
                output: truncated.value,
                outputTruncated: truncated.truncated,
                partId: typeof part.id === "string" ? part.id : undefined,
                messageId: typeof part.messageID === "string" ? part.messageID : undefined,
              });
            } else if (status === "error") {
              const error = typeof state.error === "string" ? state.error : "unknown";
              toolOutputs.push(formatToolBlock(`[#${toolName}] ❌`, error));
              const truncated = truncateForXml(error);
              toolRuns.push({
                tool: toolName,
                status,
                title,
                error: truncated.value,
                outputTruncated: truncated.truncated,
                partId: typeof part.id === "string" ? part.id : undefined,
                messageId: typeof part.messageID === "string" ? part.messageID : undefined,
              });
            } else if (status === "running" || status === "pending") {
              const title =
                typeof state.title === "string" && state.title.length > 0
                  ? state.title
                  : "";
              const header = title ? `${title} (${status})` : status;
              toolOutputs.push(formatToolBlock(`[#${toolName}] ${header}`, inputText));
              const truncated = truncateForXml(inputText);
              toolRuns.push({
                tool: toolName,
                status,
                title,
                input: truncated.value,
                outputTruncated: truncated.truncated,
                partId: typeof part.id === "string" ? part.id : undefined,
                messageId: typeof part.messageID === "string" ? part.messageID : undefined,
              });
            }
          }
        }
      }
    }
  }

  const sections: string[] = [];
  const text = textParts.join("\n").trim();
  if (text) sections.push(text);

  if (subtaskLines.length > 0) {
    sections.push(t("markers.subtask"));
    sections.push(subtaskLines.join("\n"));
  }

  if (toolOutputs.length > 0) {
    sections.push(t("markers.toolOutput"));
    sections.push(toolOutputs.join("\n"));
  }

  if (hasReasoning) {
    sections.unshift(t("markers.thinking"));
  }
  const xml = buildAmiyaXmlFromParts(parts);
  if (xml) sections.push(xml);

  return sections.join("\n\n").trim();
}

export type ToolAttachment = {
  tool: string;
  fileName: string;
  content: string;
  mimeType: string;
};

export type TextWithAttachments = {
  text: string;
  attachments: ToolAttachment[];
};

export function extractTextWithAttachmentsFromPromptResult(
  result: unknown,
  options?: {
    maxInlineChars?: number;
    attachmentTools?: string[];
  },
): TextWithAttachments {
  const parts = extractPartsFromPromptResult(result);
  if (parts.length === 0) return { text: "", attachments: [] };

  const maxInlineChars = options?.maxInlineChars ?? 8000;
  const attachmentTools = options?.attachmentTools ?? ["bash"];
  const textParts: string[] = [];
  const toolOutputs: string[] = [];
  const subtaskLines: string[] = [];
  const attachments: ToolAttachment[] = [];
  const toolRuns: ToolRunXml[] = [];
  let hasReasoning = false;

  const formatToolBlock = (label: string, body?: string): string => {
    if (body && body.trim().length > 0) {
      return `> ${label}\n\n\`\`\`\n${body}\n\`\`\``;
    }
    return `> ${label}`;
  };

  const shouldAttach = (toolName: string, body: string) =>
    attachmentTools.includes(toolName) && body.length > maxInlineChars;

  const buildAttachmentName = (toolName: string, index: number) =>
    `${toolName}-output-${index}.log`;

  for (const part of parts) {
    if (!isRecord(part)) {
      // skip
    } else {
      const type = part.type;

      if (type === "text") {
        const text = typeof part.text === "string" ? part.text : "";
        if (text) textParts.push(text);
      } else if (type === "reasoning") {
        hasReasoning = true;
      } else if (type === "subtask") {
        const description =
          typeof part.description === "string" ? part.description : "";
        const agent = typeof part.agent === "string" ? part.agent : "";
        const prompt = typeof part.prompt === "string" ? part.prompt : "";
        const label = description || prompt || t("labels.subtask");
        const agentInfo = agent ? t("labels.agentInfo", { agent }) : "";
        subtaskLines.push(`- ${label}${agentInfo}`);
      } else if (type === "tool") {
        const toolName = typeof part.tool === "string" ? part.tool : "tool";
        if (toolName !== "question") {
          const state = isRecord(part.state) ? part.state : undefined;
          if (!state) {
            // ignore
          } else {
            const status = typeof state.status === "string" ? state.status : "unknown";
            const title = typeof state.title === "string" ? state.title : undefined;
            const inputValue = state.input;
            const inputText =
              typeof inputValue === "string"
                ? inputValue
                : inputValue !== undefined
                  ? JSON.stringify(inputValue)
                  : "";

            if (status === "completed") {
              const output = typeof state.output === "string" ? state.output : "";
              if (output && shouldAttach(toolName, output)) {
                const fileName = buildAttachmentName(toolName, attachments.length + 1);
                attachments.push({
                  tool: toolName,
                  fileName,
                  content: output,
                  mimeType: "text/plain",
                });
                toolOutputs.push(
                  `> [#${toolName}] ${t("opencode.outputTooLong", { fileName })}`,
                );
                const truncated = truncateForXml(output);
                toolRuns.push({
                  tool: toolName,
                  status,
                  title,
                  output: truncated.value,
                  outputTruncated: true,
                  outputFileName: fileName,
                  partId: typeof part.id === "string" ? part.id : undefined,
                  messageId: typeof part.messageID === "string" ? part.messageID : undefined,
                });
              } else {
                toolOutputs.push(formatToolBlock(`[#${toolName}]`, output));
                const truncated = truncateForXml(output);
                toolRuns.push({
                  tool: toolName,
                  status,
                  title,
                  output: truncated.value,
                  outputTruncated: truncated.truncated,
                  partId: typeof part.id === "string" ? part.id : undefined,
                  messageId: typeof part.messageID === "string" ? part.messageID : undefined,
                });
              }
            } else if (status === "error") {
              const error = typeof state.error === "string" ? state.error : "unknown";
              toolOutputs.push(formatToolBlock(`[#${toolName}] ❌`, error));
              const truncated = truncateForXml(error);
              toolRuns.push({
                tool: toolName,
                status,
                title,
                error: truncated.value,
                outputTruncated: truncated.truncated,
                partId: typeof part.id === "string" ? part.id : undefined,
                messageId: typeof part.messageID === "string" ? part.messageID : undefined,
              });
            } else if (status === "running" || status === "pending") {
              const title =
                typeof state.title === "string" && state.title.length > 0
                  ? state.title
                  : "";
              const header = title ? `${title} (${status})` : status;
              toolOutputs.push(formatToolBlock(`[#${toolName}] ${header}`, inputText));
              const truncated = truncateForXml(inputText);
              toolRuns.push({
                tool: toolName,
                status,
                title,
                input: truncated.value,
                outputTruncated: truncated.truncated,
                partId: typeof part.id === "string" ? part.id : undefined,
                messageId: typeof part.messageID === "string" ? part.messageID : undefined,
              });
            }
          }
        }
      }
    }
  }

  const sections: string[] = [];
  const text = textParts.join("\n").trim();
  if (text) sections.push(text);

  if (subtaskLines.length > 0) {
    sections.push(t("markers.subtask"));
    sections.push(subtaskLines.join("\n"));
  }

  if (toolOutputs.length > 0) {
    sections.push(t("markers.toolOutput"));
    sections.push(toolOutputs.join("\n"));
  }

  if (hasReasoning) {
    sections.unshift(t("markers.thinking"));
  }
  const xml = buildAmiyaXmlFromParts(parts);
  if (xml) sections.push(xml);

  return { text: sections.join("\n\n").trim(), attachments };
}
