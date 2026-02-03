import { upsertMessagePart, upsertMessageRenderCache, upsertToolRun } from "../database.js"
import { getOpencodeClientV2 } from "../opencode.js"
import { buildAmiyaXmlFromParts, extractTextFromPromptResult } from "./format.js"
import { isRecord, logWith } from "./utils.js"

export interface StreamingControllerOptions {
  directory: string
  sessionId: string
  threadId: string
  abortSignal: AbortSignal
  startedAt: number
  onTextUpdate?: (messageId: string, text: string, isComplete: boolean) => Promise<void>
  onQuestionAsked?: (questionRequest: {
    id?: string
    sessionID?: string
    questions?: unknown
  }) => Promise<void>
  onPermissionAsked?: (permissionRequest: {
    id?: string
    sessionID?: string
    permission?: string
    patterns?: string[]
  }) => Promise<void>
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

type QuestionAskedEvent = {
  type: "question.asked"
  properties?: {
    id?: string
    sessionID?: string
    questions?: unknown
  }
}

type PermissionAskedEvent = {
  type: "permission.asked"
  properties?: {
    id?: string
    sessionID?: string
    permission?: string
    patterns?: string[]
  }
}

function isMessageUpdatedEvent(event: unknown): event is MessageUpdatedEvent {
  return isRecord(event) && event.type === "message.updated"
}

function isMessagePartUpdatedEvent(event: unknown): event is MessagePartUpdatedEvent {
  return isRecord(event) && event.type === "message.part.updated"
}

function isQuestionAskedEvent(event: unknown): event is QuestionAskedEvent {
  return isRecord(event) && event.type === "question.asked"
}

function isPermissionAskedEvent(event: unknown): event is PermissionAskedEvent {
  return isRecord(event) && event.type === "permission.asked"
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
  const acceptedAssistantMessageIds = new Set<string>()
  const textCacheByMessageId = new Map<string, string>()
  const renderedPayloadByMessageId = new Map<string, string>()
  let started = false

  const handleTextUpdate = async (messageId: string, text: string, isComplete: boolean) => {
    if (!options.onTextUpdate) return
    try {
      await options.onTextUpdate(messageId, text, isComplete)
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

  const updateTextCache = async (messageId: string) => {
    if (!options.onTextUpdate) return
    const bucket = messageParts.get(messageId)
    if (!bucket) return
    const orderedParts = bucket.order
      .map((id) => bucket.parts.get(id))
      .filter((part): part is Record<string, unknown> => Boolean(part))
    const nextText = extractTextFromPromptResult({ data: { parts: orderedParts } })
    const xml = buildAmiyaXmlFromParts(orderedParts)
    const combined = xml ? `${nextText}\n\n${xml}` : nextText
    const previousRendered = renderedPayloadByMessageId.get(messageId)
    if (combined === previousRendered) return
    renderedPayloadByMessageId.set(messageId, combined)
    const previousText = textCacheByMessageId.get(messageId)
    if (nextText !== previousText) {
      textCacheByMessageId.set(messageId, nextText)
      upsertMessageRenderCache({
        sessionId: options.sessionId,
        messageId,
        renderedText: nextText,
      })
    }
    await handleTextUpdate(messageId, combined, false)
  }

  const getRenderedPayload = (messageId: string) =>
    renderedPayloadByMessageId.get(messageId)
    ?? textCacheByMessageId.get(messageId)
    ?? ""

  const persistMessagePart = (
    part: Record<string, unknown>,
    messageId: string,
    partId: string,
    orderIndex: number,
  ) => {
    const type = typeof part.type === "string" ? part.type : "unknown"
    const record = {
      partId,
      sessionId: options.sessionId,
      messageId,
      orderIndex,
      type,
      text: typeof part.text === "string" ? part.text : undefined,
      reasoning: typeof part.reasoning === "string" ? part.reasoning : undefined,
      subtaskDescription: typeof part.description === "string" ? part.description : undefined,
      subtaskPrompt: typeof part.prompt === "string" ? part.prompt : undefined,
      subtaskAgent: typeof part.agent === "string" ? part.agent : undefined,
      startedAt:
        isRecord(part.time) && typeof part.time.start === "number" ? part.time.start : undefined,
      completedAt:
        isRecord(part.time) && typeof part.time.end === "number" ? part.time.end : undefined,
    }

    if (type === "tool") {
      const toolName = typeof part.tool === "string" ? part.tool : "tool"
      const state = isRecord(part.state) ? part.state : undefined
      const status = typeof state?.status === "string" ? state.status : undefined
      const title = typeof state?.title === "string" ? state.title : undefined
      const input = state?.input
      const inputText =
        typeof input === "string"
          ? input
          : input !== undefined
            ? JSON.stringify(input)
            : undefined
      const outputText = typeof state?.output === "string" ? state.output : undefined
      const errorText = typeof state?.error === "string" ? state.error : undefined
      upsertMessagePart({
        ...record,
        toolName,
        toolStatus: status,
        toolTitle: title,
        inputText,
        outputText,
        errorText,
      })
      return
    }

    upsertMessagePart(record)
  }

  const persistToolRunFromPart = (
    part: Record<string, unknown>,
    messageId: string,
    partId: string,
  ) => {
    const toolName = typeof part.tool === "string" ? part.tool : "tool"
    if (toolName === "question") return
    const state = isRecord(part.state) ? part.state : undefined
    if (!state) return
    const status = typeof state.status === "string" ? state.status : "unknown"
    const title = typeof state.title === "string" ? state.title : undefined
    const input = state.input
    const inputJson =
      typeof input === "string"
        ? input
        : input !== undefined
          ? JSON.stringify(input)
          : undefined
    const outputText = typeof state.output === "string" ? state.output : undefined
    const errorText = typeof state.error === "string" ? state.error : undefined

    upsertToolRun({
      partId,
      sessionId: options.sessionId,
      threadId: options.threadId,
      messageId,
      toolName,
      status,
      title,
      inputJson,
      outputText,
      errorText,
    })
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

      logWith(
        options.logger,
        `Stream message.updated session=${info.sessionID || "-"} message=${info.id || "-"} role=${info.role || "-"} created=${info.time?.created ?? "-"} completed=${info.time?.completed ?? "-"}`,
        "debug",
      )

      if (info.id) {
        messageMeta.set(info.id, {
          role: info.role,
          createdAt: info.time?.created,
        })
      }

        if (info.role === "assistant" && info.id) {
          const createdAt = info.time?.created
          if (!shouldAcceptAssistant(createdAt)) return
          if (!acceptedAssistantMessageIds.has(info.id)) {
            acceptedAssistantMessageIds.add(info.id)
            logWith(
              options.logger,
              `Stream assistant message accepted id=${info.id} created=${createdAt ?? "-"}`,
              "debug",
            )
          }
          await updateTextCache(info.id)
          if (info.time?.completed) {
            await handleTextUpdate(info.id, getRenderedPayload(info.id), true)
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

      const deltaSize =
        typeof event.properties?.delta === "string" ? event.properties.delta.length : 0
      const partTextSize = typeof part.text === "string" ? part.text.length : 0
      logWith(
        options.logger,
        `Stream part.updated session=${part.sessionID || "-"} message=${messageId} part=${partId} type=${part.type || "-"} deltaChars=${deltaSize} textChars=${partTextSize}`,
        "debug",
      )

      const meta = messageMeta.get(messageId)
      if (meta?.role && meta.role !== "assistant") {
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
      const orderIndex = bucket.order.indexOf(partId)
      persistMessagePart(nextPart, messageId, partId, orderIndex)

      if (part.type === "tool") {
        persistToolRunFromPart(nextPart, messageId, partId)
      }

      if (acceptedAssistantMessageIds.has(messageId)) {
        await updateTextCache(messageId)
      }
    }

    if (isQuestionAskedEvent(event)) {
      const payload = event.properties
      if (!payload || payload.sessionID !== options.sessionId) return
      if (options.onQuestionAsked) {
        await options.onQuestionAsked(payload)
      }
    }

    if (isPermissionAskedEvent(event)) {
      const payload = event.properties
      if (!payload || payload.sessionID !== options.sessionId) return
      if (options.onPermissionAsked) {
        await options.onPermissionAsked(payload)
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
