import { getOpencodeClientV2 } from "../opencode.js"
import { extractTextFromPromptResult } from "./format.js"
import { isRecord, logWith } from "./utils.js"

export interface StreamingControllerOptions {
  directory: string
  sessionId: string
  threadId: string
  abortSignal: AbortSignal
  startedAt: number
  onTextUpdate: (text: string, isComplete: boolean) => Promise<void>
  logger?: (message: string, level?: "debug" | "info" | "warn" | "error") => void
}

type MessageUpdatedEvent = {
  type: "message.updated"
  properties?: {
    info?: {
      id?: string
      sessionID?: string
      role?: string
      time?: { created?: number; completed?: number }
    }
  }
}

type MessagePartUpdatedEvent = {
  type: "message.part.updated"
  properties?: {
    part?: Record<string, unknown> & {
      id?: string
      sessionID?: string
      messageID?: string
      type?: string
      text?: string
      time?: { start?: number; end?: number }
    }
    delta?: string
  }
}

function isMessageUpdatedEvent(event: unknown): event is MessageUpdatedEvent {
  return isRecord(event) && event.type === "message.updated"
}

function isMessagePartUpdatedEvent(event: unknown): event is MessagePartUpdatedEvent {
  return isRecord(event) && event.type === "message.part.updated"
}

export async function createStreamingController(
  options: StreamingControllerOptions,
): Promise<{ start: () => void; stop: () => void }> {
  const client = getOpencodeClientV2(options.directory)
  if (!client) {
    logWith(options.logger, `Streaming unavailable: no v2 client for ${options.directory}`, "warn")
    return {
      start: () => {},
      stop: () => {},
    }
  }

  const abortController = new AbortController()
  const messageMeta = new Map<string, { role?: string; createdAt?: number }>()
  const messageParts = new Map<
    string,
    { order: string[]; parts: Map<string, Record<string, unknown>> }
  >()
  let assistantMessageId: string | null = null
  let textCache = ""
  let started = false

  const handleTextUpdate = async (text: string, isComplete: boolean) => {
    try {
      await options.onTextUpdate(text, isComplete)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logWith(options.logger, `Streaming onTextUpdate failed: ${message}`, "debug")
    }
  }

  const getMessageBucket = (messageId: string) => {
    const existing = messageParts.get(messageId)
    if (existing) return existing
    const bucket = { order: [] as string[], parts: new Map<string, Record<string, unknown>>() }
    messageParts.set(messageId, bucket)
    return bucket
  }

  const updateTextCache = async () => {
    if (!assistantMessageId) return
    const bucket = messageParts.get(assistantMessageId)
    if (!bucket) return
    const orderedParts = bucket.order
      .map((id) => bucket.parts.get(id))
      .filter((part): part is Record<string, unknown> => Boolean(part))
    const nextText = extractTextFromPromptResult({ data: { parts: orderedParts } })
    if (nextText === textCache) return
    textCache = nextText
    await handleTextUpdate(textCache, false)
  }

  const shouldAcceptAssistant = (createdAt: number | undefined) => {
    if (!createdAt) return true
    return createdAt >= options.startedAt - 1000
  }

  const handleEvent = async (event: unknown) => {
    if (isMessageUpdatedEvent(event)) {
      const info = event.properties?.info
      if (!info || info.sessionID !== options.sessionId) {
        return
      }

      if (info.id) {
        messageMeta.set(info.id, {
          role: info.role,
          createdAt: info.time?.created,
        })
      }

      if (info.role === "assistant") {
        const createdAt = info.time?.created
        if (!assistantMessageId) {
          if (shouldAcceptAssistant(createdAt)) {
            assistantMessageId = info.id || null
            await updateTextCache()
          } else {
            return
          }
        }
        if (assistantMessageId && info.id === assistantMessageId && info.time?.completed) {
          await handleTextUpdate(textCache, true)
        }
      }
      return
    }

    if (isMessagePartUpdatedEvent(event)) {
      const part = event.properties?.part
      if (!part || part.sessionID !== options.sessionId) return

      const messageId = part.messageID
      const partId = part.id
      if (!messageId || !partId) return

      const meta = messageMeta.get(messageId)
      if (meta?.role && meta.role !== "assistant") {
        return
      }

      if (assistantMessageId && messageId !== assistantMessageId) {
        return
      }

      const bucket = getMessageBucket(messageId)
      const existing = bucket.parts.get(partId)
      const nextPart: Record<string, unknown> = isRecord(existing) ? { ...existing } : {}

      if (isRecord(part)) {
        Object.assign(nextPart, part)
      }

      if (part.type === "text") {
        const prevText = typeof nextPart.text === "string" ? nextPart.text : ""
        let nextText = prevText
        if (typeof event.properties?.delta === "string" && event.properties.delta.length > 0) {
          nextText = prevText + event.properties.delta
        } else if (typeof part.text === "string") {
          nextText = part.text
        }
        nextPart.text = nextText
      }

      bucket.parts.set(partId, nextPart)
      if (!bucket.order.includes(partId)) {
        bucket.order.push(partId)
      }

      if (assistantMessageId && messageId === assistantMessageId) {
        await updateTextCache()
      }
    }
  }

  options.abortSignal.addEventListener("abort", () => {
    if (!abortController.signal.aborted) {
      abortController.abort(options.abortSignal.reason)
    }
  })

  return {
    start: () => {
      if (started) return
      started = true
      void (async () => {
        try {
          const result = await client.event.subscribe(
            { directory: options.directory },
            { signal: abortController.signal },
          )
          for await (const event of result.stream) {
            if (abortController.signal.aborted) break
            await handleEvent(event)
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          logWith(options.logger, `Streaming stopped: ${message}`, "debug")
        }
      })()
    },
    stop: () => {
      if (!abortController.signal.aborted) {
        abortController.abort("streaming stopped")
      }
    },
  }
}
