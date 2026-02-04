import { describe, expect, it } from "vitest";

import { markdownToFeishuPost } from "../src/feishu-markdown.js";
import {
  extractTextFromPromptResult,
  extractTextWithAttachmentsFromPromptResult,
} from "../src/session/format.js";
import { splitMarkdownIntoChunks } from "../src/session/stream-utils.js";

describe("markdownToFeishuPost", () => {
  it("extracts H1 title and keeps body", () => {
    const input = "# Title\n\nParagraph with **bold** text.";
    const post = markdownToFeishuPost(input);
    expect(post.title).toBe("Title");
    expect(post.content).toHaveLength(1);
    expect(post.content[0]).toHaveLength(1);
    expect(post.content[0][0].tag).toBe("md");
    if (post.content[0][0].tag === "md") {
      expect(post.content[0][0].text).toBe("Paragraph with **bold** text.");
    }
  });

  it("returns empty content for empty input", () => {
    const post = markdownToFeishuPost("\n\n  \n");
    expect(post.title).toBeUndefined();
    expect(post.content).toHaveLength(0);
  });
});

describe("extractTextFromPromptResult", () => {
  it("formats tool output blocks", () => {
    const result = {
      data: {
        parts: [
          { type: "text", text: "Main reply" },
          {
            type: "tool",
            tool: "bash",
            state: { status: "completed", output: "line1\nline2" },
          },
        ],
      },
    };
    const text = extractTextFromPromptResult(result);
    expect(text).toContain("— 子任务/工具输出 —");
    expect(text).toContain("> [#bash]");
    expect(text).toContain("```\nline1\nline2\n```");
  });
});

describe("extractTextWithAttachmentsFromPromptResult", () => {
  it("moves long bash output to attachment", () => {
    const result = {
      data: {
        parts: [
          {
            type: "tool",
            tool: "bash",
            state: { status: "completed", output: "x".repeat(20) },
          },
        ],
      },
    };
    const { text, attachments } = extractTextWithAttachmentsFromPromptResult(result, {
      maxInlineChars: 10,
      attachmentTools: ["bash"],
    });
    expect(attachments).toHaveLength(1);
    expect(attachments[0].fileName).toBe("bash-output-1.log");
    expect(text).toContain("输出过长");
    expect(text).not.toContain("x".repeat(20));
  });
});

describe("splitMarkdownIntoChunks", () => {
  it("respects maxChars and preserves content", () => {
    const input = "line1\n\nline2\nline3\n\nline4";
    const chunks = splitMarkdownIntoChunks(input, 10);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(10);
    }
    expect(chunks.join("")).toBe(input);
  });
});
