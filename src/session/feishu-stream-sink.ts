import {
  ASSISTANT_THINKING_MARKER,
  assistantCardStates,
  buildAssistantCardText,
  detectPanelStates,
  extractAmiyaXml,
  splitAssistantDetails,
  splitFooterLines,
} from "../providers/feishu/assistant-card-state.js"
import type { IncomingMessage, MessagePart, MessageProvider } from "../types.js"
import { sanitizeMarkdownForPreview } from "./markdown-preview.js"
import { createThrottledRenderer } from "./throttle.js"
import { logWith } from "./utils.js"

type PanelStates = {
  hasThinkingPanel: boolean
  hasToolPanel: boolean
  thinkingContent?: string
  toolContent?: string
}

export function createFeishuStreamSink(options: StreamSinkOptions) {
  const { provider, message, logger } = options
  const updateSupported = typeof provider.updateMessage === "function"
  let currentMessageId: string | null = null
  let currentCardId: string | null = null
  let currentElementId: string | null = null
  let currentSequence = 1
  let lastRenderedText = ""
  let lastPanelStates: PanelStates | null = null
  let lastMessageParts: MessagePart[] | null = null

  const truncateForCard = (text: string) => {
    if (text.length <= options.maxMessageChars) {
      return text
    }
    const suffix = "\n\n...(truncated)"
    const allowed = Math.max(0, options.maxMessageChars - suffix.length)
    return `${text.slice(0, allowed)}${suffix}`
  }

  const sendNewMessage = async (text: string, mode: "streaming" | "final") => {
    const payload = { text, mode }
    const result = provider.replyMessage
      ? await provider.replyMessage(message, payload)
      : await provider.sendMessage(
          { channelId: message.channelId, threadId: message.threadId },
          payload,
        )
    if (result.cardId) currentCardId = result.cardId
    if (result.elementId) currentElementId = result.elementId
    return result.messageId
  }

  const updateMessage = async (
    messageId: string,
    text: string,
    mode: "streaming" | "final",
    status?: "info" | "warning" | "error",
    messageParts?: MessagePart[],
  ): Promise<boolean> => {
    const updater = provider.updateMessage
    if (!updateSupported || !updater) return false
    return await updater(messageId, {
      text,
      mode,
      status,
      cardId: currentCardId || undefined,
      elementId: currentElementId || undefined,
      messageParts,
    })
  }

  const renderText = async (text: string) => {
    const preview = sanitizeMarkdownForPreview(text)
    const truncated = truncateForCard(preview)
    if (truncated === lastRenderedText) return
    if (!currentMessageId) {
      currentMessageId = await sendNewMessage(truncated, "streaming")
      lastRenderedText = truncated
      return
    }
    const ok = await updateMessage(
      currentMessageId,
      truncated,
      "streaming",
      undefined,
      lastMessageParts || undefined,
    )
    if (ok) {
      lastRenderedText = truncated
      return
    }
    logWith(logger, `Stream update failed messageId=${currentMessageId}`, "debug")
  }

  const throttled = createThrottledRenderer(
    async (text) => {
      await renderText(text)
    },
    Math.max(0, options.throttleMs),
  )

  return {
    async start() {
      const placeholderId = await sendNewMessage("", "streaming")
      currentMessageId = placeholderId
      lastRenderedText = ""
      return {
        messageId: placeholderId,
        cardId: currentCardId || undefined,
        elementId: currentElementId || undefined,
      }
    },
    async render(text: string) {
      const { cleanedText, messageParts } = extractAmiyaXml(text)
      lastMessageParts = messageParts.length > 0 ? messageParts : lastMessageParts
      throttled.update(cleanedText)
      lastPanelStates = detectPanelStates(text)
    },
    async finalize(finalText: string, footer: string) {
      await throttled.flush()
      const combined = finalText.trim() ? `${finalText.trim()}\n\n${footer}` : footer
      if (!combined) return

      const { cleanedText, xmlBlock, messageParts } = extractAmiyaXml(combined)
      if (messageParts.length > 0) {
        lastMessageParts = messageParts
      }
      const { body, footer: parsedFooter } = splitFooterLines(cleanedText)
      let { main, details } = splitAssistantDetails(body)

      const finalPanelStates: PanelStates = detectPanelStates(combined)

      if (lastPanelStates) {
        if (!finalPanelStates.hasThinkingPanel && lastPanelStates.hasThinkingPanel) {
          const thinkingContent = lastPanelStates.thinkingContent ?? ''
          const thinkingBlock = thinkingContent ? `${ASSISTANT_THINKING_MARKER}\n${thinkingContent}` : ASSISTANT_THINKING_MARKER
          main = `${thinkingBlock}\n\n${main}`
        }
        if (!finalPanelStates.hasToolPanel && lastPanelStates.hasToolPanel && lastPanelStates.toolContent) {
          const separator = details ? `\n\n${details}` : ''
          details = `${lastPanelStates.toolContent}${separator}`
        }
      }

      const combinedBody = [main, details].filter(Boolean).join('\n\n').trim()
      const combinedWithFooter = parsedFooter
        ? (combinedBody ? `${combinedBody}\n\n${parsedFooter}` : parsedFooter)
        : combinedBody
      const combinedWithXml = xmlBlock
        ? (combinedWithFooter ? `${combinedWithFooter}\n\n${xmlBlock}` : xmlBlock)
        : combinedWithFooter

      const state = currentMessageId && currentCardId && currentElementId
        ? {
            cardId: currentCardId,
            elementId: currentElementId,
            main,
            details,
            meta: parsedFooter,
            showDetails: false,
            showMeta: false,
            sequence: currentSequence,
            hasThinkingPanel: finalPanelStates.hasThinkingPanel || lastPanelStates?.hasThinkingPanel,
            hasToolPanel: finalPanelStates.hasToolPanel || lastPanelStates?.hasToolPanel,
            thinkingContent: finalPanelStates.thinkingContent || lastPanelStates?.thinkingContent,
            toolContent: finalPanelStates.toolContent || lastPanelStates?.toolContent,
          }
        : null

      const rendered = state ? buildAssistantCardText(state) : combinedWithXml
      const truncated = truncateForCard(rendered)

      if (currentMessageId) {
        const ok = await updateMessage(
          currentMessageId,
          truncateForCard(combinedWithFooter),
          "final",
          undefined,
          lastMessageParts || undefined,
        )
        if (!ok) {
          await sendNewMessage(truncated, "final")
        }
      } else {
        await sendNewMessage(truncated, "final")
      }

      const feishuClient = provider.getFeishuClient?.()
      if (feishuClient && state && currentCardId) {
        await feishuClient.updateAssistantCardEntityWithId?.(currentCardId, {
          sequence: currentSequence,
          text: state.main,
          details: state.details,
          meta: state.meta,
          showDetails: state.showDetails,
          showMeta: state.showMeta,
        })
        currentSequence += 1
        state.sequence = currentSequence
      }

      if (state && currentMessageId) {
        assistantCardStates.set(currentMessageId, state)
      }
      lastRenderedText = truncated
    },
    async fail(reason: string) {
      const text = `⚠️ ${reason}`
      if (currentMessageId) {
        const ok = await updateMessage(currentMessageId, text, "final", "error")
        if (ok) return
      }
      await sendNewMessage(text, "final")
    },
    detach() {
      currentMessageId = null
      currentCardId = null
      currentElementId = null
      lastRenderedText = ""
      logWith(logger, "Stream sink detached; future replies will start a new card", "debug")
    },
    getMessageIds() {
      return currentMessageId ? [currentMessageId] : []
    },
  }
}

export interface StreamSinkOptions {
  provider: MessageProvider
  message: IncomingMessage
  throttleMs: number
  maxMessageChars: number
  mode: "update" | "append"
  logger?: (message: string, level?: "debug" | "info" | "warn" | "error") => void
}
