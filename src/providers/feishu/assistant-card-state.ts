import type { MessagePart } from '../../types.js'
import { t } from '../../i18n/index.js'

export type AssistantCardState = {
  cardId: string
  elementId: string
  main: string
  details?: string
  meta?: string
  showDetails: boolean
  showMeta: boolean
  sequence: number
  hasThinkingPanel?: boolean
  hasToolPanel?: boolean
  thinkingContent?: string
  toolContent?: string
}

export const assistantCardStates = new Map<string, AssistantCardState>()

export type AssistantMessagePart = MessagePart

export type AssistantStepBlock = {
  title?: string
  parts: AssistantMessagePart[]
  completed?: boolean
}

const getOrderIndex = (part: AssistantMessagePart): number | null => {
  if (typeof part.orderIndex === 'number' && Number.isFinite(part.orderIndex)) {
    return part.orderIndex
  }
  const fallback = (part as Record<string, unknown>).order_index
  if (typeof fallback === 'number' && Number.isFinite(fallback)) {
    return fallback
  }
  return null
}

const readStepTitle = (part: AssistantMessagePart): string | undefined => {
  const candidates = [part.text, part.description, part.prompt]
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim()
    }
  }
  return undefined
}

export function buildAssistantStepsFromParts(parts: AssistantMessagePart[]): {
  steps: AssistantStepBlock[]
  hasStepMarkers: boolean
} {
  if (parts.length === 0) {
    return { steps: [], hasStepMarkers: false }
  }

  const hasOrderIndex = parts.some((part) => getOrderIndex(part) !== null)
  const orderedParts = hasOrderIndex
    ? parts
      .map((part, index) => ({ part, index, orderIndex: getOrderIndex(part) }))
      .sort((a, b) => {
        const aIndex = a.orderIndex ?? Number.MAX_SAFE_INTEGER
        const bIndex = b.orderIndex ?? Number.MAX_SAFE_INTEGER
        if (aIndex !== bIndex) return aIndex - bIndex
        return a.index - b.index
      })
      .map(({ part }) => part)
    : parts

  const steps: AssistantStepBlock[] = []
  let current: AssistantStepBlock | null = null
  let hasStepMarkers = false
  const shouldPushStep = (step: AssistantStepBlock) =>
    step.parts.length > 0 || (typeof step.title === 'string' && step.title.trim().length > 0)

  for (const part of orderedParts) {
    const type = part.type
    if (type === 'step-start') {
      hasStepMarkers = true
      if (current && shouldPushStep(current)) {
        steps.push(current)
      }
      current = { title: readStepTitle(part), parts: [], completed: false }
      continue
    }
    if (type === 'step-finish') {
      hasStepMarkers = true
      if (!current) {
        current = { parts: [], completed: true }
      } else {
        current.completed = true
      }
      if (current && shouldPushStep(current)) {
        steps.push(current)
      }
      current = null
      continue
    }

    if (!current) {
      current = { parts: [] }
    }
    current.parts.push(part)
  }

  if (current && shouldPushStep(current)) {
    steps.push(current)
  }

  if (steps.length === 0) {
    return { steps: [{ parts: orderedParts }], hasStepMarkers }
  }

  return { steps, hasStepMarkers }
}

const AMIYA_XML_RE = /<!--AMYIA_XML([\s\S]*?)-->/

const decodeEntities = (value: string) =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')

const extractCdata = (value: string) => {
  const cdataMatch = value.match(/<!\[CDATA\[([\s\S]*?)\]\]>/)
  if (cdataMatch) return cdataMatch[1] ?? ''
  return decodeEntities(value)
}

const parseXmlAttributes = (attrs: string) => {
  const result: Record<string, string> = {}
  const attrRe = /(\w+)="([^"]*)"/g
  let match: RegExpExecArray | null = null
  while (true) {
    match = attrRe.exec(attrs)
    if (!match) break
    result[match[1]] = decodeEntities(match[2] ?? '')
  }
  return result
}

const extractXmlTag = (input: string, tag: string): string | undefined => {
  const tagRe = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`)
  const match = input.match(tagRe)
  if (!match) return undefined
  return extractCdata(match[1] ?? '')
}

const parseToolRunsFromAmiyaXml = (xml: string): AssistantToolRun[] => {
  const runs: AssistantToolRun[] = []
  const toolRunRe = /<tool-run\b([^>]*)>([\s\S]*?)<\/tool-run>/g
  let match: RegExpExecArray | null = null
  while (true) {
    match = toolRunRe.exec(xml)
    if (!match) break
    const attrs = parseXmlAttributes(match[1] ?? '')
    const body = match[2] ?? ''
    const tool = attrs.tool || 'tool'
    const status = (attrs.status as AssistantToolRun['status']) || 'unknown'
    const outputTruncated = attrs.outputTruncated === 'true'
    const outputFileName = attrs.outputFileName
    const input = extractXmlTag(body, 'input')
    const output = extractXmlTag(body, 'output')
    const error = extractXmlTag(body, 'error')

    const run: AssistantToolRun = {
      tool,
      status,
    }

    if (status === 'running' || status === 'pending') {
      run.input = input || ''
    } else if (error && status === 'error') {
      run.output = error
    } else if (output) {
      run.output = output
    }

    if (outputTruncated) {
      run.outputTooLong = true
    }
    if (outputFileName) {
      run.outputFileName = outputFileName
    }
    runs.push(run)
  }
  return runs
}

const parsePartsFromAmiyaXml = (xml: string): AssistantMessagePart[] => {
  const parts: AssistantMessagePart[] = []
  const partRe = /<part\b([^>]*)>([\s\S]*?)<\/part>/g
  let match: RegExpExecArray | null = null
  while (true) {
    match = partRe.exec(xml)
    if (!match) break
    const attrs = parseXmlAttributes(match[1] ?? '')
    const body = match[2] ?? ''
    const type = attrs.type || 'unknown'
    const orderIndexRaw = attrs.orderIndex
    const orderIndex = orderIndexRaw ? Number(orderIndexRaw) : undefined
    const part: AssistantMessagePart = {
      type,
      orderIndex: Number.isFinite(orderIndex) ? orderIndex : undefined,
    }
    if (attrs.messageId) part.messageID = attrs.messageId

    if (type === 'text') {
      part.text = extractXmlTag(body, 'text')
    } else if (type === 'reasoning') {
      part.reasoning = extractXmlTag(body, 'reasoning')
    } else if (type === 'subtask') {
      if (attrs.description) part.description = attrs.description
      if (attrs.prompt) part.prompt = attrs.prompt
      if (attrs.agent) part.agent = attrs.agent
    } else if (type === 'step-start') {
      part.text = extractXmlTag(body, 'text')
    } else if (type === 'tool') {
      const toolName = attrs.tool || 'tool'
      const status = attrs.status || 'unknown'
      const state: Record<string, unknown> = { status }
      if (attrs.title) state.title = attrs.title
      const input = extractXmlTag(body, 'input')
      const output = extractXmlTag(body, 'output')
      const error = extractXmlTag(body, 'error')
      if (input) state.input = input
      if (output) state.output = output
      if (error) state.error = error
      if (attrs.outputTruncated === 'true') state.outputTruncated = true
      if (attrs.outputFileName) state.outputFileName = attrs.outputFileName
      part.tool = toolName
      part.state = state
    }

    parts.push(part)
  }
  return parts
}

export function extractAmiyaXml(text: string): {
  cleanedText: string
  toolRuns: AssistantToolRun[]
  messageParts: AssistantMessagePart[]
  xmlBlock?: string
} {
  const match = text.match(AMIYA_XML_RE)
  if (!match) return { cleanedText: text, toolRuns: [], messageParts: [] }
  const xmlPayload = match[1] ?? ''
  const cleanedText = text.replace(AMIYA_XML_RE, '').trim()
  const toolRuns = parseToolRunsFromAmiyaXml(xmlPayload)
  const messageParts = parsePartsFromAmiyaXml(xmlPayload)
  return { cleanedText, toolRuns, messageParts, xmlBlock: match[0] }
}

export function buildAssistantCardText(state: AssistantCardState): string {
  const lines: string[] = []
  const mainText = state.main.trim()
  if (mainText) {
    lines.push(mainText)
  }

  if (state.details && state.details.trim().length > 0) {
    if (state.showDetails) {
      lines.push(state.details.trim())
    } else {
      lines.push(t('feishu.collapsedTool'))
    }
  }

  if (state.meta && state.meta.trim().length > 0) {
    if (state.showMeta) {
      lines.push(`---\n_${state.meta.trim()}_`)
    } else {
      lines.push(t('feishu.collapsedMeta'))
    }
  }

  if (lines.length === 0) {
    return '...'
  }

  return lines.join('\n\n')
}

export function splitAssistantDetails(text: string): { main: string; details?: string } {
  const toolMarker = getAssistantToolOutputMarker()
  const subtaskMarker = getAssistantSubtaskMarker()
  const toolIndex = text.indexOf(toolMarker)
  const subtaskIndex = text.indexOf(subtaskMarker)
  const markerIndex = toolIndex >= 0
    ? toolIndex
    : subtaskIndex >= 0
      ? subtaskIndex
      : -1
  if (markerIndex < 0) {
    return { main: text.trim() }
  }
  const main = text.slice(0, markerIndex).trim()
  const details = text.slice(markerIndex).trim()
  return { main, details }
}

export const getAssistantThinkingMarker = () => t('markers.thinking')
export const getAssistantSubtaskMarker = () => t('markers.subtask')
export const getAssistantToolOutputMarker = () => t('markers.toolOutput')

export function splitAssistantThinkingBlock(text: string): { thinkingContent?: string; body: string } {
  const lines = text.split('\n')
  let i = 0
  while (i < lines.length && lines[i]?.trim().length === 0) i += 1
  if (i >= lines.length || lines[i]?.trim() !== getAssistantThinkingMarker()) {
    return { body: text.trim() }
  }
  i += 1
  while (i < lines.length && lines[i]?.trim().length === 0) i += 1

  const body = lines.slice(i).join('\n').trim()
  return { thinkingContent: '', body }
}

export function splitAssistantThinking(text: string): { thinking: boolean; body: string } {
  const lines = text.split('\n')
  let i = 0
  while (i < lines.length && lines[i]?.trim().length === 0) i += 1
  if (i < lines.length && lines[i]?.trim() === getAssistantThinkingMarker()) {
    i += 1
    while (i < lines.length && lines[i]?.trim().length === 0) i += 1
    return { thinking: true, body: lines.slice(i).join('\n').trim() }
  }
  return { thinking: false, body: text.trim() }
}

export type AssistantToolRun = {
  tool: string
  status: 'completed' | 'running' | 'pending' | 'error' | 'unknown'
  durationText?: string
  input?: string
  output?: string
  outputTooLong?: boolean
  outputFileName?: string
}

function parseDurationText(header: string): string | undefined {
  const match = header.match(/\b(\d+(?:\.\d+)?)(ms|s)\b/)
  if (!match) return undefined
  return `${match[1]}${match[2]}`
}

export function parseAssistantToolRuns(details?: string): AssistantToolRun[] {
  if (!details) return []
  const trimmed = details.trim()
  if (!trimmed) return []

  const xmlRuns = extractAmiyaXml(trimmed).toolRuns
  if (xmlRuns.length > 0) return xmlRuns

  const lines = trimmed.split('\n')
  let i = 0
  while (i < lines.length && lines[i]?.trim().length === 0) i += 1
  if (i < lines.length && lines[i]?.trim() === getAssistantToolOutputMarker()) {
    i += 1
  }
  while (i < lines.length && lines[i]?.trim().length === 0) i += 1

  const runs: AssistantToolRun[] = []
  const headerRe = /^>\s*\[#([^\]\s]+)\](.*)$/
  const fenceRe = /^```/

  while (i < lines.length) {
    const line = lines[i] ?? ''
    const headerMatch = line.match(headerRe)
    if (!headerMatch) {
      i += 1
      continue
    }

    const tool = (headerMatch[1] ?? 'tool').trim() || 'tool'
    const rest = (headerMatch[2] ?? '').trim()
    const durationText = parseDurationText(rest)

    let status: AssistantToolRun['status'] = 'completed'
    if (rest.includes('❌')) {
      status = 'error'
    } else if (rest.includes('running')) {
      status = 'running'
    } else if (rest.includes('pending')) {
      status = 'pending'
    } else if (rest.length > 0) {
      status = 'unknown'
    }

    i += 1
    while (i < lines.length && lines[i]?.trim().length === 0) i += 1

    let body = ''
    let hasCodeBlock = false
    if (i < lines.length && fenceRe.test(lines[i] ?? '')) {
      hasCodeBlock = true
      i += 1
      const bodyLines: string[] = []
      while (i < lines.length && !fenceRe.test(lines[i] ?? '')) {
        bodyLines.push(lines[i] ?? '')
        i += 1
      }
      if (i < lines.length && fenceRe.test(lines[i] ?? '')) {
        i += 1
      }
      body = bodyLines.join('\n').replace(/\s+$/, '')
    }

    const run: AssistantToolRun = {
      tool,
      status,
      durationText,
    }

    const attachmentNameMatch = rest.match(/\b([A-Za-z0-9._-]+\.(?:log|txt))\b/)
    const attachmentName = attachmentNameMatch?.[1]
    const lowerRest = rest.toLowerCase()
    const mentionsTooLong = lowerRest.includes('too long')
      || rest.includes(t('feishu.outputTooLong'))

    if (!hasCodeBlock) {
      if (mentionsTooLong) {
        run.outputTooLong = true
        if (attachmentName) run.outputFileName = attachmentName
        run.output = rest
      } else if (rest.length > 0 && status !== 'running' && status !== 'pending') {
        run.output = rest
      }
      runs.push(run)
      continue
    }

    if (status === 'running' || status === 'pending') {
      run.input = body
    } else {
      run.output = body
    }
    runs.push(run)
  }

  return runs
}

export function splitFooterLines(text: string): { body: string; footer?: string } {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  if (lines.length === 0) return { body: '' }

  const durationPrefix = t('stats.duration', { value: '' })
  const contextPrefix = t('stats.context', { value: '' })
  const sessionPrefix = t('stats.session', { value: '' })
  const modelPrefix = t('stats.model', { value: '' })
  const versionPrefix = t('stats.version', { value: '' })
  const doneLabel = t('labels.thinkingDone')
  const contextLabel = t('stats.context', { value: '' }).trim()

  const footerLines: string[] = []
  while (lines.length > 0) {
    const last = lines[lines.length - 1]
    if (
      last.startsWith(durationPrefix)
      || last.startsWith(contextPrefix)
      || last.startsWith(sessionPrefix)
      || last.startsWith(modelPrefix)
      || last.startsWith(versionPrefix)
      || (doneLabel && last.includes(doneLabel))
      || (contextLabel && last.includes(contextLabel))
    ) {
      footerLines.unshift(lines.pop() as string)
    } else {
      break
    }
  }

  const body = lines.join('\n').trim()
  const footer = footerLines.length > 0 ? footerLines.join('\n') : undefined
  return { body, footer }
}

export function detectPanelStates(text: string): {
  hasThinkingPanel: boolean
  hasToolPanel: boolean
  thinkingContent?: string
  toolContent?: string
} {
  const { cleanedText, toolRuns } = extractAmiyaXml(text)
  const hasThinkingPanel = cleanedText.includes(getAssistantThinkingMarker())
  const hasToolPanel = toolRuns.length > 0
    || cleanedText.includes(getAssistantToolOutputMarker())
    || cleanedText.includes(getAssistantSubtaskMarker())

  let thinkingContent: string | undefined
  let toolContent: string | undefined

  if (hasThinkingPanel) {
    const { thinkingContent: content } = splitAssistantThinkingBlock(cleanedText)
    thinkingContent = content ?? ''
  }

  if (hasToolPanel) {
    if (toolRuns.length > 0) {
      toolContent = getAssistantToolOutputMarker()
    } else {
      const { body } = splitAssistantThinkingBlock(cleanedText)
      const { details } = splitAssistantDetails(body)
      if (details) {
        toolContent = details
      }
    }
  }

  return { hasThinkingPanel, hasToolPanel, thinkingContent, toolContent }
}
