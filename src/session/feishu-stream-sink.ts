import type { IncomingMessage, MessageProvider } from "../types.js"
import { sanitizeMarkdownForPreview } from "./markdown-preview.js"
import { splitMarkdownIntoChunks } from "./stream-utils.js"
import { createThrottledRenderer } from "./throttle.js"
import { logWith } from "./utils.js"

export interface StreamSinkOptions {
  provider: MessageProvider
  message: IncomingMessage
  throttleMs: number
  maxMessageChars: number
  mode: "update" | "append"
  maxUpdateCount: number
  logger?: (message: string, level?: "debug" | "info" | "warn" | "error") => void
}

export function createFeishuStreamSink(options: StreamSinkOptions) {
  const { provider, message, logger } = options
  const updateSupported = typeof provider.updateMessage === "function"
  let mode: "update" | "append" = updateSupported ? options.mode : "append"
  let currentMessageId: string | null = null
  let messageIds: string[] = []
  let updateCount = 0
  let lastRenderedText = ""

  const sendNewMessage = async (text: string): Promise<string> => {
    if (provider.replyMessage) {
      const result = await provider.replyMessage(message, { text })
      return result.messageId
    }
    const result = await provider.sendMessage(
      { channelId: message.channelId, threadId: message.threadId },
      { text },
    )
    return result.messageId
  }

  const updateMessage = async (text: string): Promise<boolean> => {
    if (!currentMessageId || !provider.updateMessage) return false
    if (updateCount >= options.maxUpdateCount) {
      mode = "append"
      return false
    }
    const ok = await provider.updateMessage(currentMessageId, { text })
    if (ok) {
      updateCount += 1
    } else {
      mode = "append"
    }
    return ok
  }

  const appendDelta = async (text: string) => {
    if (!text) return
    const chunks = splitMarkdownIntoChunks(text, options.maxMessageChars)
    for (const chunk of chunks) {
      const id = await sendNewMessage(chunk)
      messageIds.push(id)
      currentMessageId = id
      updateCount = 0
    }
  }

  const renderText = async (text: string) => {
    if (!text) return

    if (mode === "append" || !updateSupported) {
      const delta =
        lastRenderedText && text.startsWith(lastRenderedText)
          ? text.slice(lastRenderedText.length)
          : text
      await appendDelta(delta)
      lastRenderedText = text
      return
    }

    const chunks = splitMarkdownIntoChunks(text, options.maxMessageChars)
    if (chunks.length === 0) return

    if (!currentMessageId) {
      const id = await sendNewMessage(chunks[0])
      currentMessageId = id
      messageIds = [id]
      updateCount = 0
    }

    const existingCount = messageIds.length
    if (chunks.length > existingCount) {
      const currentIndex = existingCount - 1
      if (currentIndex >= 0) {
        const ok = await updateMessage(chunks[currentIndex])
        if (!ok) {
          const delta =
            lastRenderedText && text.startsWith(lastRenderedText)
              ? text.slice(lastRenderedText.length)
              : text
          await appendDelta(delta)
          lastRenderedText = text
          return
        }
      }

      for (let i = existingCount; i < chunks.length; i += 1) {
        const id = await sendNewMessage(chunks[i])
        messageIds.push(id)
        currentMessageId = id
        updateCount = 0
      }
    } else {
      const ok = await updateMessage(chunks[chunks.length - 1])
      if (!ok) {
        const delta =
          lastRenderedText && text.startsWith(lastRenderedText)
            ? text.slice(lastRenderedText.length)
            : text
        await appendDelta(delta)
        lastRenderedText = text
        return
      }
    }

    lastRenderedText = text
  }

  const throttled = createThrottledRenderer(
    async (text) => {
      const preview = sanitizeMarkdownForPreview(text)
      await renderText(preview)
    },
    Math.max(0, options.throttleMs),
  )

  return {
    async start() {
      const placeholderId = await sendNewMessage("⏳ 生成中...")
      currentMessageId = placeholderId
      messageIds = [placeholderId]
      updateCount = 0
      lastRenderedText = ""
      return placeholderId
    },
    async render(text: string) {
      throttled.update(text)
    },
    async finalize(finalText: string, footer: string) {
      await throttled.flush()
      const combined = finalText.trim() ? `${finalText.trim()}\n\n${footer}` : footer

      if (!combined) return

      if (mode === "append" || !updateSupported) {
        const delta =
          lastRenderedText && combined.startsWith(lastRenderedText)
            ? combined.slice(lastRenderedText.length)
            : combined
        await appendDelta(delta)
        lastRenderedText = combined
        return
      }

      const chunks = splitMarkdownIntoChunks(combined, options.maxMessageChars)
      if (chunks.length === 0) return

      const existingCount = messageIds.length
      if (existingCount === 0) {
        const id = await sendNewMessage(chunks[0])
        currentMessageId = id
        messageIds = [id]
        updateCount = 0
      }

      if (chunks.length > messageIds.length) {
        for (let i = messageIds.length; i < chunks.length; i += 1) {
          const id = await sendNewMessage(chunks[i])
          messageIds.push(id)
          currentMessageId = id
          updateCount = 0
        }
      }

      if (currentMessageId) {
        const ok = await updateMessage(chunks[chunks.length - 1])
        if (!ok) {
          logWith(logger, "Finalize update failed, switching to append", "warn")
          const delta =
            lastRenderedText && combined.startsWith(lastRenderedText)
              ? combined.slice(lastRenderedText.length)
              : combined
          await appendDelta(delta)
        }
      }

      lastRenderedText = combined
    },
    async fail(reason: string) {
      if (currentMessageId && provider.updateMessage) {
        await provider.updateMessage(currentMessageId, { text: `⚠️ ${reason}` })
        return
      }
      await sendNewMessage(`⚠️ ${reason}`)
    },
    detach() {
      mode = "append"
      currentMessageId = null
      messageIds = []
      updateCount = 0
      lastRenderedText = ""
      logWith(logger, "Stream sink detached; future replies will append", "debug")
    },
    getMessageIds() {
      return messageIds
    },
  }
}
