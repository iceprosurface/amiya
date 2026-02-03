import * as lark from '@larksuiteoapi/node-sdk'
import type { FeishuConfig } from './feishu-config'
import {
  buildAssistantStepsFromParts,
  extractAmiyaXml,
  getAssistantSubtaskMarker,
  getAssistantToolOutputMarker,
  parseAssistantToolRuns,
  splitAssistantDetails,
  splitAssistantThinkingBlock,
  splitFooterLines,
  type AssistantMessagePart,
  type AssistantToolRun,
} from './assistant-card-state'
import { t } from '../../i18n/index.js'
import { feishuPostToJson, markdownToFeishuPost } from './markdown-adapter.js'

export function createFeishuClient(
  config: FeishuConfig,
  logger?: (message: string, level?: 'debug' | 'info' | 'warn' | 'error') => void,
) {
  const fetcher = globalThis.fetch as unknown as (...args: unknown[]) => Promise<unknown>
  const FormDataCtor = globalThis.FormData as unknown as (new () => {
    set: (name: string, value: unknown, fileName?: string) => void
  })
  const BlobCtor = globalThis.Blob as unknown as (new (parts: unknown[], options?: { type?: string }) => unknown)
  const client = new lark.Client({
    appId: config.appId,
    appSecret: config.appSecret,
    domain: config.useLark ? lark.Domain.Lark : lark.Domain.Feishu,
    loggerLevel: config.debug ? lark.LoggerLevel.debug : lark.LoggerLevel.info,
  })
  const baseUrl = config.useLark ? 'https://open.larksuite.com' : 'https://open.feishu.cn'

  const log = (message: string, level: 'debug' | 'info' | 'warn' | 'error' = 'info') => {
    if (logger) {
      logger(`[Feishu] ${message}`, level)
    } else if (config.debug) {
      // console.log(`[Feishu][${level}] ${message}`)
    }
  }

  let cachedBotUserId: string | null = null

  const extractTenantToken = (result: unknown): string | null => {
    if (!result || typeof result !== 'object') return null
    const record = result as Record<string, unknown>
    const data = record.data as Record<string, unknown> | undefined
    const directToken = record.tenant_access_token
    const nestedToken = data?.tenant_access_token
    const resolved = typeof nestedToken === 'string' && nestedToken.length > 0
      ? nestedToken
      : typeof directToken === 'string' && directToken.length > 0
        ? directToken
        : null
    return resolved
  }

  async function fetchTenantAccessToken(): Promise<string | null> {
    try {
      const tokenResult = await client.auth.v3.tenantAccessToken.internal({
        data: {
          app_id: config.appId,
          app_secret: config.appSecret,
        },
      })

      let tenantToken = extractTenantToken(tokenResult)
      if (!tenantToken) {
        const directTokenResult = await client.request({
          method: 'POST',
          url: '/open-apis/auth/v3/tenant_access_token/internal',
          data: {
            app_id: config.appId,
            app_secret: config.appSecret,
          },
        })
        tenantToken = extractTenantToken(directTokenResult)
      }

      if (!tenantToken) {
        log('No tenant_access_token in response', 'warn')
        return null
      }

      return tenantToken
    } catch (error) {
      log(`Failed to fetch tenant_access_token: ${error}`, 'warn')
      return null
    }
  }

  async function getBotUserId(): Promise<string | null> {
    if (cachedBotUserId) {
      return cachedBotUserId
    }

    if (config.botUserId) {
      cachedBotUserId = config.botUserId
      log('Using configured botUserId', 'debug')
      return cachedBotUserId
    }

    try {
      const tenantToken = await fetchTenantAccessToken()
      if (!tenantToken) return null

      const botInfoResult = await client.request({
        method: 'GET',
        url: '/open-apis/bot/v3/info',
      }, lark.withTenantToken(tenantToken))

      if (!botInfoResult || typeof botInfoResult !== 'object') {
        log('Invalid bot info response', 'warn')
        return null
      }

      const botInfoRecord = botInfoResult as Record<string, unknown>
      const botInfoData = botInfoRecord.data as Record<string, unknown> | undefined
      const bot = (botInfoData?.bot as Record<string, unknown> | undefined)
        ?? (botInfoRecord.bot as Record<string, unknown> | undefined)
      const openId = bot?.open_id ?? botInfoData?.open_id ?? botInfoRecord.open_id
      const userId = bot?.user_id ?? botInfoData?.user_id ?? botInfoRecord.user_id
      log(
        `Bot info response keys: top=[${Object.keys(botInfoRecord).join(',')}] data=[${botInfoData ? Object.keys(botInfoData).join(',') : ''}] bot=[${bot ? Object.keys(bot).join(',') : ''}]`,
        'debug',
      )
      const resolvedId = typeof openId === 'string' && openId.length > 0
        ? openId
        : typeof userId === 'string' && userId.length > 0
          ? userId
          : null

      if (resolvedId) {
        cachedBotUserId = resolvedId
        log(`Auto-detected botUserId: ${resolvedId}`, 'info')
        return cachedBotUserId
      }

      log('Bot open_id/user_id not found in bot info response', 'warn')
      return null
    } catch (error) {
      log(`Failed to fetch botUserId: ${error}`, 'warn')
      return null
    }
  }

  function extractMessageId(result: unknown): string | null {
    if (!result || typeof result !== 'object') return null
    const r = result as Record<string, unknown>
    const direct = r.message_id
    if (typeof direct === 'string' && direct) return direct

    const data = r.data
    if (data && typeof data === 'object') {
      const d = data as Record<string, unknown>
      const nested = d.message_id
      if (typeof nested === 'string' && nested) return nested
    }

    return null
  }

  function extractFileKey(result: unknown): string | null {
    if (!result || typeof result !== 'object') return null
    const record = result as Record<string, unknown>
    const data = record.data
    if (!data || typeof data !== 'object') return null
    const fileKey = (data as Record<string, unknown>).file_key
    return typeof fileKey === 'string' && fileKey.length > 0 ? fileKey : null
  }

  function extractCardId(result: unknown): string | null {
    if (!result || typeof result !== 'object') return null
    const record = result as Record<string, unknown>
    const data = record.data
    if (data && typeof data === 'object') {
      const cardId = (data as Record<string, unknown>).card_id
      if (typeof cardId === 'string' && cardId.length > 0) return cardId
    }
    const direct = (record as Record<string, unknown>).card_id
    return typeof direct === 'string' && direct.length > 0 ? direct : null
  }

  async function requestCardKit<T>(
    method: 'POST' | 'PATCH' | 'PUT',
    path: string,
    body: Record<string, unknown>,
  ): Promise<T | null> {
    try {
      if (!fetcher) {
        log('CardKit request requires fetch support', 'warn')
        return null
      }
      const tenantToken = await fetchTenantAccessToken()
      if (!tenantToken) return null
      const payloadStr = JSON.stringify(body)
      log(`CardKit ${method} ${path} payload_size=${payloadStr.length}B`, 'debug')
      if (method === 'POST' && path === '/open-apis/cardkit/v1/cards') {
        const dataStr = typeof body.data === 'string' ? body.data : ''
        if (dataStr) {
          try {
            const card = JSON.parse(dataStr) as { schema?: string; body?: { elements?: Array<{ tag?: string }> } }
            const tags = (card.body?.elements || []).map((element) => element.tag || '?').join(',')
            log(
              `CardKit create summary schema=${card.schema || '?'} elements=${card.body?.elements?.length ?? 0} tags=${tags || '-'}`,
              'debug',
            )
          } catch {
            log(`CardKit create summary data_size=${dataStr.length}B`, 'debug')
          }
        }
      }
      const response = await fetcher(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${tenantToken}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: payloadStr,
      }) as { ok?: boolean; status?: number; statusText?: string; json?: () => Promise<unknown> }
      if (!response || response.ok === false) {
        const status = response?.status ?? 'unknown'
        const statusText = response?.statusText ?? ''
        log(`CardKit request failed: ${method} ${path} ${status} ${statusText}`, 'warn')
        return null
      }
      const result = (await response.json?.().catch(() => null)) as T | null
      const resultStr = JSON.stringify(result)
      log(`CardKit ${method} ${path} response_status=${response.status} response_size=${resultStr.length}B`, 'debug')
      if (method === 'POST' && path === '/open-apis/cardkit/v1/cards') {
        const code = (result as Record<string, unknown> | null)?.code
        const cardId = extractCardId(result)
        log(`CardKit create result code=${code ?? 'unknown'} card_id=${cardId ?? '-'}`, 'debug')
      }
      return result
    } catch (error) {
      log(`CardKit request failed: ${error}`, 'error')
      return null
    }
  }

  const buildAssistantCardContent = (params: {
    text: string
    footer?: string
    title?: string
    streaming?: boolean
    status?: 'info' | 'warning' | 'error'
    elementId?: string
    details?: string
    meta?: string
    showDetails?: boolean
    showMeta?: boolean
    messageParts?: AssistantMessagePart[]
  }) => {
    const elementId = params.elementId || 'assistant_content'
    const template = params.status === 'error'
      ? 'red'
      : params.status === 'warning'
        ? 'orange'
        : 'blue'
    const title = params.title && params.title.trim().length > 0
      ? params.title
      : 'Amiya'

    const TOOL_OUTPUT_MAX_INLINE_CHARS = 1800
    const TOOL_INPUT_MAX_INLINE_CHARS = 1200
    const TOOL_OUTPUT_MAX_INLINE_LINES = 50

    const extractContextPercent = (text: string): string | null => {
      const contextLabel = t('stats.context', { value: '' }).trim()
      if (!contextLabel) return null
      const escaped = contextLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const match = text.match(new RegExp(`${escaped}\\s*([0-9.]+%)`))
      return match ? match[1] : null
    }

    const buildMetaList = (text: string): string => {
      const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
      if (lines.length === 0) return ''
      return lines.map((line) => `- ${line}`).join('\n')
    }

    const xmlPayload = extractAmiyaXml(params.text)
    const messageParts = Array.isArray(params.messageParts) && params.messageParts.length > 0
      ? params.messageParts
      : xmlPayload.messageParts
    const { cleanedText, toolRuns } = xmlPayload
    const { body, footer } = splitFooterLines(cleanedText)
    const elements: Record<string, unknown>[] = []

    const buildToolElements = (runs: AssistantToolRun[]) => {
      const toolElements: Record<string, unknown>[] = []
      if (runs.length === 0) return toolElements
      for (const run of runs) {
        const statusText = run.status
        const durationText = run.durationText || '-'
        const inputText = run.input || ''
        const outputText = run.output || ''

        const inputField = (() => {
          if (!inputText) return '-'
          const lines = inputText.split('\n')
          if (lines.length > TOOL_OUTPUT_MAX_INLINE_LINES) {
            return t('feishu.inputTooLong')
          }
          const trimmed = inputText.replace(/\s+$/, '')
          if (trimmed.length > TOOL_INPUT_MAX_INLINE_CHARS) {
            return t('feishu.inputTooLong')
          }
          return trimmed
        })()

        const outputField = (() => {
          if (run.outputTooLong) {
            const hint = run.outputFileName
              ? t('feishu.outputInFile', { fileName: run.outputFileName })
              : t('feishu.outputTooLong')
            return hint
          }
          if (!outputText) return '-'
          const lines = outputText.split('\n')
          if (lines.length > TOOL_OUTPUT_MAX_INLINE_LINES) {
            return t('feishu.outputTooLong')
          }
          const trimmed = outputText.replace(/\s+$/, '')
          if (trimmed.length > TOOL_OUTPUT_MAX_INLINE_CHARS) {
            return t('feishu.outputTooLong')
          }
          return trimmed
        })()

        toolElements.push({
          tag: 'div',
          fields: [
            {
              is_short: true,
              text: { tag: 'plain_text', content: t('feishu.toolLabel', { tool: run.tool }) },
            },
            {
              is_short: true,
              text: { tag: 'plain_text', content: t('feishu.statusLabel', { status: statusText }) },
            },
            {
              is_short: true,
              text: { tag: 'plain_text', content: t('feishu.durationLabel', { duration: durationText }) },
            },
            {
              is_short: false,
              text: { tag: 'plain_text', content: t('feishu.inputLabel', { input: inputField }) },
            },
            {
              is_short: false,
              text: { tag: 'plain_text', content: t('feishu.outputLabel', { output: outputField }) },
            },
          ],
        })
      }
      return toolElements
    }

    const formatDurationText = (part: AssistantMessagePart): string | undefined => {
      const time = part.time
      if (!time || typeof time !== 'object') return undefined
      const start = (time as Record<string, unknown>).start
      const end = (time as Record<string, unknown>).end
      if (typeof start !== 'number' || typeof end !== 'number' || end < start) return undefined
      const seconds = (end - start) / 1000
      if (!Number.isFinite(seconds)) return undefined
      return `${seconds.toFixed(1)}s`
    }

    const buildToolRunsFromParts = (parts: AssistantMessagePart[]): AssistantToolRun[] => {
      const runs: AssistantToolRun[] = []
      for (const part of parts) {
        if (part.type !== 'tool') continue
        const toolName = typeof part.tool === 'string' ? part.tool : 'tool'
        if (toolName === 'question') continue
        const state = part.state && typeof part.state === 'object'
          ? (part.state as Record<string, unknown>)
          : undefined
        if (!state) continue
        const statusRaw = typeof state.status === 'string' ? state.status : 'unknown'
        const status: AssistantToolRun['status'] =
          statusRaw === 'completed'
          || statusRaw === 'running'
          || statusRaw === 'pending'
          || statusRaw === 'error'
          || statusRaw === 'unknown'
            ? statusRaw
            : 'unknown'
        const inputValue = state.input
        const inputText =
          typeof inputValue === 'string'
            ? inputValue
            : inputValue !== undefined
              ? JSON.stringify(inputValue)
              : ''
        const outputValue = state.output
        const outputText =
          typeof outputValue === 'string'
            ? outputValue
            : outputValue !== undefined
              ? JSON.stringify(outputValue)
              : ''
        const errorValue = state.error
        const errorText =
          typeof errorValue === 'string'
            ? errorValue
            : errorValue !== undefined
              ? JSON.stringify(errorValue)
              : ''

        const run: AssistantToolRun = {
          tool: toolName,
          status,
          durationText: formatDurationText(part),
          input: inputText,
        }

        if (status === 'completed') {
          run.output = outputText
        } else if (status === 'error') {
          run.output = errorText
        } else if (status === 'running' || status === 'pending') {
          // input already set above
        } else if (outputText) {
          run.output = outputText
        }

        const outputTruncated = typeof state.outputTruncated === 'boolean'
          ? state.outputTruncated
          : undefined
        const outputFileName = typeof state.outputFileName === 'string'
          ? state.outputFileName
          : undefined
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

    const buildSubtaskLines = (parts: AssistantMessagePart[]) => {
      const lines: string[] = []
      for (const part of parts) {
        if (part.type !== 'subtask') continue
        const description = typeof part.description === 'string' ? part.description : ''
        const agent = typeof part.agent === 'string' ? part.agent : ''
        const prompt = typeof part.prompt === 'string' ? part.prompt : ''
        const label = description || prompt || t('labels.subtask')
        const agentInfo = agent ? t('labels.agentInfo', { agent }) : ''
        lines.push(`- ${label}${agentInfo}`)
      }
      return lines
    }

    const collectReasoningText = (parts: AssistantMessagePart[]) => {
      const lines: string[] = []
      for (const part of parts) {
        if (part.type !== 'reasoning') continue
        const reasoning = typeof part.reasoning === 'string'
          ? part.reasoning
          : typeof part.text === 'string'
            ? part.text
            : ''
        if (reasoning.trim()) lines.push(reasoning.trim())
      }
      return lines.join('\n')
    }

    if (messageParts.length > 0) {
      const grouped: Array<{ messageId?: string; parts: AssistantMessagePart[] }> = []
      for (const part of messageParts) {
        const messageId = typeof part.messageID === 'string' ? part.messageID : undefined
        const last = grouped[grouped.length - 1]
        if (!last || last.messageId !== messageId) {
          grouped.push({ messageId, parts: [part] })
        } else {
          last.parts.push(part)
        }
      }
      const showMessageHeader = grouped.length > 1
      const reasoningLabel = params.streaming
        ? t('feishu.reasoningStreaming')
        : t('feishu.reasoningLabel')

      grouped.forEach((group, groupIndex) => {
        if (showMessageHeader) {
          elements.push({
            tag: 'markdown',
            content: t('feishu.replyGroup', { index: groupIndex + 1 }),
          })
        }

        const { steps } = buildAssistantStepsFromParts(group.parts)

        for (const step of steps) {

          const reasoningText = collectReasoningText(step.parts)
          if (reasoningText) {
            if (reasoningText.length > 150) {
              elements.push({
                tag: 'collapsible_panel',
                expanded: false,
                header: {
                  title: {
                    tag: 'plain_text',
                    content: reasoningLabel,
                  },
                },
                elements: [
                  {
                    tag: 'div',
                    text: { tag: 'plain_text', content: reasoningText },
                  },
                ],
              })
            } else {
              elements.push({
                tag: 'markdown',
                content: `**${reasoningLabel}**: ${reasoningText}`,
              })
            }
          }

          const textParts = step.parts
            .filter((part) => part.type === 'text')
            .map((part) => (typeof part.text === 'string' ? part.text : ''))
            .filter((text) => text.trim().length > 0)
          if (textParts.length > 0) {
            elements.push({
              tag: 'markdown',
              content: textParts.join('\n'),
            })
          }

          const subtaskLines = buildSubtaskLines(step.parts)
          if (subtaskLines.length > 0) {
            elements.push({
              tag: 'markdown',
              content: t('feishu.subtaskGroup', { lines: subtaskLines.join('\n') }),
            })
          }

          const runs = buildToolRunsFromParts(step.parts)
          for (const run of runs) {
            const toolLabel = run.tool
              ? `${t('feishu.toolOutputLabel')}: ${run.tool}`
              : t('feishu.toolOutputLabel')
            elements.push({
              tag: 'collapsible_panel',
              expanded: false,
              header: {
                title: {
                  tag: 'plain_text',
                  content: toolLabel,
                },
              },
              elements: buildToolElements([run]),
            })
          }
        }
      })

      if (elements.length === 0) {
        elements.push({
          tag: 'markdown',
          content: '...',
          element_id: elementId,
        })
      }

      const metaText = params.meta ?? footer
      if (metaText && metaText.trim().length > 0) {
        const contextPercent = extractContextPercent(metaText)
        const footerContent = metaText.trim()
        const metaTitle = contextPercent
          ? t('feishu.metaTitleWithContext', { value: contextPercent })
          : t('feishu.metaTitle')
        const metaList = buildMetaList(footerContent)
        elements.push({
          tag: 'collapsible_panel',
          expanded: false,
          header: {
            title: { tag: 'plain_text', content: metaTitle },
          },
          elements: [{
            tag: 'div',
            text: { tag: 'lark_md', content: metaList || footerContent },
          }],
        })
      }
    } else {
      const derived = (() => {
        const { thinkingContent, body: bodyWithoutThinking } = splitAssistantThinkingBlock(body)
        let { main, details } = splitAssistantDetails(bodyWithoutThinking)
        if ((!details || details.trim().length === 0) && toolRuns.length > 0) {
          details = getAssistantToolOutputMarker()
        }
        return {
          text: params.details || params.meta ? cleanedText : main,
          details: params.details ?? details,
          meta: params.meta ?? footer,
          thinkingContent,
          toolRuns,
        }
      })()

      const contextPercent = derived.meta ? extractContextPercent(derived.meta) : null
      const mainText = derived.text.trim()

      if (derived.thinkingContent !== undefined) {
        const thinkingTitle = params.streaming
          ? t('feishu.thinkingTitleStreaming')
          : t('feishu.thinkingTitleDone')
        elements.push({
          tag: 'collapsible_panel',
          expanded: false,
          header: {
            title: {
              tag: 'plain_text',
              content: thinkingTitle,
            },
          },
          elements: [
            {
              tag: 'div',
              text: {
                tag: 'plain_text',
                content: derived.thinkingContent || thinkingTitle,
              },
            },
          ],
        })
      }

      elements.push({
        tag: 'markdown',
        content: mainText || '...',
        element_id: elementId,
      })

      if (derived.details && derived.details.trim().length > 0) {
        const runs = derived.toolRuns.length > 0
          ? derived.toolRuns
          : parseAssistantToolRuns(derived.details)
        const trimmedDetails = derived.details.trim()
        const subtaskMarker = getAssistantSubtaskMarker()
        const toolMarker = getAssistantToolOutputMarker()
        const isSubtaskOnly = trimmedDetails.startsWith(subtaskMarker)
          && !trimmedDetails.startsWith(toolMarker)

        let handledDetails = false
        if (isSubtaskOnly) {
          const markerRe = new RegExp(`^${subtaskMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'u')
          const subtaskBody = trimmedDetails.replace(markerRe, '').trim()
          elements.push({
            tag: 'collapsible_panel',
            expanded: false,
            header: {
              title: {
                tag: 'plain_text',
                content: params.streaming ? t('feishu.stepInProgress') : t('labels.subtask'),
              },
            },
            elements: [
              {
                tag: 'div',
                text: {
                  tag: 'plain_text',
                  content: subtaskBody || t('feishu.stepBodyInProgress'),
                },
              },
            ],
          })
          handledDetails = true
        }

        if (!handledDetails && params.streaming) {
          elements.push({
            tag: 'collapsible_panel',
            expanded: false,
            header: {
              title: {
                tag: 'plain_text',
                content: t('feishu.toolOutputRunning'),
              },
            },
            elements: [
              {
                tag: 'div',
                text: {
                  tag: 'plain_text',
                  content: t('feishu.toolOutputRunningBody'),
                },
              },
            ],
          })
          handledDetails = true
        }

        if (!handledDetails) {
          if (runs.length === 0) {
            elements.push({
              tag: 'collapsible_panel',
              expanded: false,
              header: {
                title: {
                  tag: 'plain_text',
                  content: t('feishu.toolOutputLabel'),
                },
              },
              elements: [{
                tag: 'div',
                text: {
                  tag: 'plain_text',
                  content: derived.details.trim(),
                },
              }],
            })
          } else {
            elements.push({
              tag: 'collapsible_panel',
              expanded: false,
              header: {
                title: {
                  tag: 'plain_text',
                  content: runs.length > 0
                    ? t('feishu.toolOutputLabelWithCount', { count: runs.length })
                    : t('feishu.toolOutputLabel'),
                },
              },
              elements: buildToolElements(runs),
            })
          }
        }
      }

      if (derived.meta && derived.meta.trim().length > 0) {
        const footerContent = derived.meta.trim()
        const metaTitle = contextPercent
          ? t('feishu.metaTitleWithContext', { value: contextPercent })
          : t('feishu.metaTitle')
        const metaList = buildMetaList(footerContent)
        const metaElements = [{
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: metaList || footerContent,
          },
        }]
        elements.push({
          tag: 'collapsible_panel',
          expanded: false,
          header: {
            title: {
              tag: 'plain_text',
              content: metaTitle,
            },
          },
          elements: metaElements,
        })
      }
    }

    return {
      schema: '2.0',
      config: {
        update_multi: true,
        width_mode: 'fill',
        summary: {
          content: params.streaming ? '[Generating]' : '',
        },
        ...(params.streaming ? { streaming_mode: true } : {}),
      },
      header: {
        template,
        title: {
          content: params.streaming
            ? t('feishu.cardTitleStreaming', { title })
            : title,
          tag: 'plain_text',
        },
      },
      body: {
        elements,
      },
    }
  }

  const buildApprovalCardContent = (params: {
    requestId: string
    channelId: string
    userId: string
    userName?: string
  }) => {
    const userName = params.userName || params.userId
    return {
      config: {
        wide_screen_mode: true,
        update_multi: true,
      },
      header: {
        template: 'turquoise',
        title: {
          content: t('feishu.userApprovalTitle'),
          tag: 'plain_text',
        },
      },
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: t('feishu.userLabel', {
              name: userName,
              userId: params.userId,
              channelId: params.channelId,
            }),
          },
        },
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: {
                tag: 'plain_text',
                content: t('feishu.approve'),
              },
              type: 'primary',
              value: {
                action: 'approve',
                request_id: params.requestId,
              },
            },
            {
              tag: 'button',
              text: {
                tag: 'plain_text',
                content: t('feishu.reject'),
              },
              type: 'danger',
              value: {
                action: 'reject',
                request_id: params.requestId,
              },
            },
          ],
        },
      ],
    }
  }

  const buildWorkspaceBindCardContent = (params: { userId: string }) => {
    return {
      schema: '2.0',
      config: {
        wide_screen_mode: true,
        update_multi: true,
      },
      header: {
        template: 'blue',
        title: {
          content: t('feishu.workspaceBindTitle'),
          tag: 'plain_text',
        },
      },
      body: {
        elements: [
          {
            tag: 'div',
            text: {
              tag: 'lark_md',
              content: t('feishu.workspaceBindBody', { userId: params.userId }),
            },
          },
          {
            tag: 'form',
            name: 'workspace_bind',
            elements: [
              {
                tag: 'input',
                name: 'workspace_name',
                required: true,
                placeholder: {
                  tag: 'plain_text',
                  content: t('feishu.workspaceNamePlaceholder'),
                },
              },
              {
                tag: 'button',
                name: 'workspace_bind_submit',
                text: {
                  tag: 'plain_text',
                  content: t('feishu.workspaceBindSubmit'),
                },
                type: 'primary',
                action_type: 'form_submit',
                value: {
                  action: 'workspace-bind',
                },
              },
            ],
          },
        ],
      },
    }
  }

  const buildWorkspaceJoinApprovalCardContent = (params: {
    requestId: string
    workspaceName: string
    requesterUserId: string
    requesterUserName?: string
    ownerUserId: string
  }) => {
    const requester = params.requesterUserName || params.requesterUserId
    return {
      config: {
        wide_screen_mode: true,
        update_multi: true,
      },
      header: {
        template: 'orange',
        title: {
          content: t('feishu.workspaceJoinTitle'),
          tag: 'plain_text',
        },
      },
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: t('feishu.workspaceJoinBody', {
              name: params.workspaceName,
              userName: requester,
              userId: params.requesterUserId,
              ownerId: params.ownerUserId,
            }),
          },
        },
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: {
                tag: 'plain_text',
                content: t('feishu.workspaceJoinApprove'),
              },
              type: 'primary',
              value: {
                action: 'workspace-join-approve',
                request_id: params.requestId,
              },
            },
            {
              tag: 'button',
              text: {
                tag: 'plain_text',
                content: t('feishu.workspaceJoinReject'),
              },
              type: 'danger',
              value: {
                action: 'workspace-join-reject',
                request_id: params.requestId,
              },
            },
          ],
        },
      ],
    }
  }

  const buildWorkspaceBindApprovalCardContent = (params: {
    requestId: string
    workspaceName: string
    requesterUserId: string
    requesterUserName?: string
    channelId: string
  }) => {
    const requester = params.requesterUserName || params.requesterUserId
    return {
      config: {
        wide_screen_mode: true,
        update_multi: true,
      },
      header: {
        template: 'orange',
        title: {
          content: t('feishu.workspaceBindApprovalTitle'),
          tag: 'plain_text',
        },
      },
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: t('feishu.workspaceBindApprovalBody', {
              name: params.workspaceName,
              userName: requester,
              userId: params.requesterUserId,
              channelId: params.channelId,
            }),
          },
        },
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: {
                tag: 'plain_text',
                content: t('feishu.workspaceBindApprove'),
              },
              type: 'primary',
              value: {
                action: 'workspace-bind-approve',
                request_id: params.requestId,
              },
            },
            {
              tag: 'button',
              text: {
                tag: 'plain_text',
                content: t('feishu.workspaceBindReject'),
              },
              type: 'danger',
              value: {
                action: 'workspace-bind-reject',
                request_id: params.requestId,
              },
            },
          ],
        },
      ],
    }
  }

  const buildQuestionCardContent = (params: {
    title: string
    questionId: string
    questionText: string
    options: Array<{ label: string; description?: string }>
    questionIndex: number
    totalQuestions: number
    selectedLabels?: string[]
    nextLabel?: string
    completed?: boolean
  }) => {
    const optionText = params.options
      .map((opt) => (opt.description ? `- **${opt.label}**：${opt.description}` : `- **${opt.label}**`))
      .join('\n')
    const progressText = params.totalQuestions > 0
      ? t('feishu.questionProgress', {
          index: params.questionIndex + 1,
          total: params.totalQuestions,
        })
      : ''
    const selectedText = params.selectedLabels && params.selectedLabels.length > 0
      ? t('feishu.questionSelected', {
          labels: params.selectedLabels.join(', '),
        })
      : ''

    if (params.completed) {
      return {
        config: {
          wide_screen_mode: true,
        },
        header: {
          template: 'green',
          title: {
            content: params.title || t('feishu.submittedTitle'),
            tag: 'plain_text',
          },
        },
        elements: [
          {
            tag: 'div',
            text: {
            tag: 'lark_md',
            content: t('feishu.submittedBody', { progress: progressText }),
          },
        },
      ],
    }
    }

    const actions = params.options.map((opt) => ({
      tag: 'button',
      text: {
        tag: 'plain_text',
        content: opt.label,
      },
      value: {
        action: 'question',
        question_id: params.questionId,
        answer_label: opt.label,
        question_index: params.questionIndex,
      },
    }))

    const isLast = params.questionIndex + 1 >= params.totalQuestions
    const nextButton: Record<string, unknown> = {
      tag: 'button',
      text: { tag: 'plain_text', content: params.nextLabel || t('feishu.nextLabel') },
      value: {
        action: 'question-nav',
        question_id: params.questionId,
        question_index: params.questionIndex,
        direction: 'next',
      },
    }
    if (isLast) {
      nextButton.type = 'primary'
    }

    const navActions = [
      params.questionIndex > 0
        ? {
            tag: 'button',
            text: { tag: 'plain_text', content: t('feishu.prevLabel') },
            value: {
              action: 'question-nav',
              question_id: params.questionId,
              question_index: params.questionIndex,
              direction: 'prev',
            },
          }
        : null,
      nextButton,
    ].filter(Boolean)

    return {
      config: {
        wide_screen_mode: true,
        update_multi: true,
      },
      header: {
        template: 'blue',
        title: {
          content: params.title || t('feishu.chooseTitle'),
          tag: 'plain_text',
        },
      },
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: `**${params.questionText}**${selectedText}\n${optionText}${progressText}`,
          },
        },
        {
          tag: 'action',
          actions,
        },
        {
          tag: 'action',
          actions: navActions,
        },
      ],
    }
  }

  const buildPermissionCardContent = (params: {
    requestId: string
    permission: string
    patterns: string[]
    status?: 'approved' | 'rejected' | 'pending'
    replyLabel?: string
  }) => {
    const patternText = params.patterns.length > 0
      ? params.patterns.map((pattern) => `- \`${pattern}\``).join('\n')
      : t('feishu.ruleNoMatch')
    const rawReplyLabel = params.replyLabel || 'once'
    const replyLabel = rawReplyLabel === 'always'
      ? t('feishu.allowAlways')
      : rawReplyLabel === 'once'
        ? t('feishu.allowOnce')
        : rawReplyLabel
    const statusLabel = params.status === 'approved'
      ? (rawReplyLabel === 'always'
        ? t('feishu.approvalAlways', { label: replyLabel })
        : t('feishu.approvalOnce', { label: replyLabel }))
      : params.status === 'rejected'
        ? t('feishu.approvalRejected')
        : t('feishu.approvalPending')

    if (params.status && params.status !== 'pending') {
      const template = params.status === 'approved' ? 'green' : 'red'
      return {
        config: {
          wide_screen_mode: true,
          update_multi: true,
        },
        header: {
          template,
          title: {
            content: t('feishu.approvalHandled'),
            tag: 'plain_text',
          },
        },
        elements: [
          {
            tag: 'div',
            text: {
              tag: 'lark_md',
              content: `${statusLabel}\n\n**Type:** \`${params.permission}\`\n**Patterns:**\n${patternText}`,
            },
          },
        ],
      }
    }

    return {
      config: {
        wide_screen_mode: true,
        update_multi: true,
      },
      header: {
        template: 'orange',
        title: {
          content: t('feishu.approvalRequest'),
          tag: 'plain_text',
        },
      },
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: `${statusLabel}\n\n**Type:** \`${params.permission}\`\n**Patterns:**\n${patternText}`,
          },
        },
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: t('feishu.allowOnce') },
              type: 'primary',
              value: {
                action: 'permission',
                request_id: params.requestId,
                reply: 'once',
              },
            },
            {
              tag: 'button',
              text: { tag: 'plain_text', content: t('feishu.allowAlways') },
              value: {
                action: 'permission',
                request_id: params.requestId,
                reply: 'always',
              },
            },
            {
              tag: 'button',
              text: { tag: 'plain_text', content: t('feishu.deny') },
              type: 'danger',
              value: {
                action: 'permission',
                request_id: params.requestId,
                reply: 'reject',
              },
            },
          ],
        },
      ],
    }
  }

  return {
    async uploadTextFile(params: {
      content: string
      fileName: string
      fileType?: string
      mimeType?: string
    }): Promise<string | null> {
      try {
        if (!FormDataCtor || !BlobCtor || !fetcher) {
          log('File upload requires fetch/FormData/Blob support', 'warn')
          return null
        }
        const tenantToken = await fetchTenantAccessToken()
        if (!tenantToken) return null
        const form = new FormDataCtor()
        form.set('file_type', params.fileType ?? 'stream')
        form.set('file_name', params.fileName)
        const blob = new BlobCtor([params.content], {
          type: params.mimeType ?? 'text/plain',
        })
        form.set('file', blob, params.fileName)
        const response = await fetcher(`${baseUrl}/open-apis/im/v1/files`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${tenantToken}`,
          },
          body: form,
        }) as { ok?: boolean; status?: number; statusText?: string; json?: () => Promise<unknown> }
        if (!response || response.ok === false) {
          const status = response?.status ?? 'unknown'
          const statusText = response?.statusText ?? ''
          log(`Upload file failed: ${status} ${statusText}`, 'warn')
          return null
        }
        const payload = (await response.json?.().catch(() => null)) as unknown
        const fileKey = extractFileKey(payload)
        if (!fileKey) {
          log('Upload file response missing file_key', 'warn')
          return null
        }
        return fileKey
      } catch (error) {
        log(`Upload file failed: ${error}`, 'error')
        return null
      }
    },

    async sendFileMessage(chatId: string, fileKey: string): Promise<string | null> {
      try {
        const result: unknown = await client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'file',
            content: JSON.stringify({ file_key: fileKey }),
          },
        })
        return extractMessageId(result)
      } catch (error) {
        log(`Send file message failed: ${error}`, 'error')
        return null
      }
    },

    async replyFileMessageWithId(
      messageId: string,
      fileKey: string,
      options?: { replyInThread?: boolean },
    ): Promise<string | null> {
      try {
        const params: Parameters<typeof client.im.message.reply>[0] = {
          path: { message_id: messageId },
          data: {
            msg_type: 'file',
            content: JSON.stringify({ file_key: fileKey }),
          },
        }
        if (options?.replyInThread) {
          ; (params.data as Record<string, unknown>).reply_in_thread = true
        }
        const result: unknown = await client.im.message.reply(params)
        return extractMessageId(result)
      } catch (error) {
        log(`Reply file message failed: ${error}`, 'error')
        return null
      }
    },
    async sendTextMessage(chatId: string, text: string): Promise<boolean> {
      try {
        await client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'text',
            content: JSON.stringify({ text }),
          },
        })
        log(`Message sent to ${chatId}`, 'debug')
        return true
      } catch (error) {
        log(`Send message failed: ${error}`, 'error')
        return false
      }
    },

    async sendRichTextMessage(chatId: string, markdown: string): Promise<boolean> {
      try {
        const post = markdownToFeishuPost(markdown)
        await client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'post',
            content: feishuPostToJson(post),
          },
        })
        log(`Rich text message sent to ${chatId}`, 'debug')
        return true
      } catch (error) {
        log(`Send rich text message failed: ${error}`, 'error')
        return false
      }
    },

    async sendTextMessageWithId(chatId: string, text: string): Promise<string | null> {
      try {
        const result: unknown = await client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'text',
            content: JSON.stringify({ text }),
          },
        })
        const messageId = extractMessageId(result)
        if (!messageId) {
          log(`Message sent to ${chatId} but missing message_id`, 'warn')
        }
        return messageId
      } catch (error) {
        log(`Send message failed: ${error}`, 'error')
        return null
      }
    },

    async sendRichTextMessageWithId(chatId: string, markdown: string): Promise<string | null> {
      try {
        const post = markdownToFeishuPost(markdown)
        const result: unknown = await client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'post',
            content: feishuPostToJson(post),
          },
        })
        const messageId = extractMessageId(result)
        if (!messageId) {
          log(`Rich text message sent to ${chatId} but missing message_id`, 'warn')
        }
        return messageId
      } catch (error) {
        log(`Send rich text message failed: ${error}`, 'error')
        return null
      }
    },

    async replyMessage(messageId: string, text: string, options?: { replyInThread?: boolean }): Promise<boolean> {
      try {
        const params: Parameters<typeof client.im.message.reply>[0] = {
          path: { message_id: messageId },
          data: {
            msg_type: 'text',
            content: JSON.stringify({ text }),
          },
        }

        if (options?.replyInThread) {
          ; (params.data as Record<string, unknown>).reply_in_thread = true
        }

        await client.im.message.reply(params)
        return true
      } catch (error) {
        log(`Reply message failed: ${error}`, 'error')
        return false
      }
    },

    async replyRichTextMessage(messageId: string, markdown: string, options?: { replyInThread?: boolean }): Promise<boolean> {
      try {
        const params: Parameters<typeof client.im.message.reply>[0] = {
          path: { message_id: messageId },
          data: {
            msg_type: 'post',
            content: feishuPostToJson(markdownToFeishuPost(markdown)),
          },
        }

        if (options?.replyInThread) {
          ; (params.data as Record<string, unknown>).reply_in_thread = true
        }

        await client.im.message.reply(params)
        return true
      } catch (error) {
        log(`Reply rich text message failed: ${error}`, 'error')
        return false
      }
    },

    async replyMessageWithId(
      messageId: string,
      text: string,
      options?: { replyInThread?: boolean },
    ): Promise<string | null> {
      try {
        const params: Parameters<typeof client.im.message.reply>[0] = {
          path: { message_id: messageId },
          data: {
            msg_type: 'text',
            content: JSON.stringify({ text }),
          },
        }

        if (options?.replyInThread) {
          ; (params.data as Record<string, unknown>).reply_in_thread = true
        }

        const result: unknown = await client.im.message.reply(params)
        return extractMessageId(result)
      } catch (error) {
        log(`Reply message failed: ${error}`, 'error')
        return null
      }
    },

    async replyRichTextMessageWithId(
      messageId: string,
      markdown: string,
      options?: { replyInThread?: boolean },
    ): Promise<string | null> {
      try {
        const params: Parameters<typeof client.im.message.reply>[0] = {
          path: { message_id: messageId },
          data: {
            msg_type: 'post',
            content: feishuPostToJson(markdownToFeishuPost(markdown)),
          },
        }

        if (options?.replyInThread) {
          ; (params.data as Record<string, unknown>).reply_in_thread = true
        }

        const result: unknown = await client.im.message.reply(params)
        return extractMessageId(result)
      } catch (error) {
        log(`Reply rich text message failed: ${error}`, 'error')
        return null
      }
    },

    async updateTextMessage(messageId: string, text: string): Promise<boolean> {
      try {
        await client.im.message.update({
          path: { message_id: messageId },
          data: {
            msg_type: 'text',
            content: JSON.stringify({ text }),
          },
        })
        return true
      } catch (error) {
        log(`Update message failed: ${error}`, 'error')
        return false
      }
    },

    async updateRichTextMessage(messageId: string, markdown: string): Promise<boolean> {
      try {
        await client.im.message.update({
          path: { message_id: messageId },
          data: {
            msg_type: 'post',
            content: feishuPostToJson(markdownToFeishuPost(markdown)),
          },
        })
        return true
      } catch (error) {
        log(`Update rich text message failed: ${error}`, 'error')
        return false
      }
    },

    isChatAllowed(chatId: string): boolean {
      if (!config.allowedChatIds || config.allowedChatIds.length === 0) {
        return true
      }
      return config.allowedChatIds.includes(chatId)
    },

    async addReaction(messageId: string, emoji: string): Promise<boolean> {
      try {
        await client.im.v1.messageReaction.create({
          path: { message_id: messageId },
          data: {
            reaction_type: {
              emoji_type: emoji,
            },
          },
        })
        log(`Added reaction '${emoji}' to message ${messageId}`, 'debug')
        return true
      } catch (error) {
        log(`Add reaction failed: ${error}`, 'error')
        return false
      }
    },

    async getBotUserId(): Promise<string | null> {
      return await getBotUserId()
    },

    getRawClient() {
      return client
    },

    async sendApprovalCard(
      adminChatId: string,
      params: {
        requestId: string
        channelId: string
        userId: string
        userName?: string
      },
    ): Promise<string | null> {
      try {
        const cardContent = buildApprovalCardContent(params)

        const result: unknown = await client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: adminChatId,
            msg_type: 'interactive',
            content: JSON.stringify(cardContent),
          },
        })

        const messageId = extractMessageId(result)
        if (!messageId) {
          log(`Approval card sent to ${adminChatId} but missing message_id`, 'warn')
        } else {
          log(`Approval card sent to ${adminChatId} for request ${params.requestId}`, 'info')
        }
        return messageId
      } catch (error) {
        log(`Send approval card failed: ${error}`, 'error')
        return null
      }
    },
    async sendWorkspaceBindApprovalCard(
      adminChatId: string,
      params: {
        requestId: string
        channelId: string
        workspaceName: string
        requesterUserId: string
        requesterUserName?: string
      },
    ): Promise<string | null> {
      try {
        const cardContent = buildWorkspaceBindApprovalCardContent(params)

        const result: unknown = await client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: adminChatId,
            msg_type: 'interactive',
            content: JSON.stringify(cardContent),
          },
        })

        const messageId = extractMessageId(result)
        if (!messageId) {
          log(`Workspace bind approval card sent to ${adminChatId} but missing message_id`, 'warn')
        } else {
          log(`Workspace bind approval card sent to ${adminChatId} for request ${params.requestId}`, 'info')
        }
        return messageId
      } catch (error) {
        log(`Send workspace bind approval card failed: ${error}`, 'error')
        return null
      }
    },

    async replyQuestionCardWithId(
      messageId: string,
      params: {
        title: string
        questionId: string
        questionText: string
        options: Array<{ label: string; description?: string }>
        questionIndex: number
        totalQuestions: number
        selectedLabels?: string[]
        nextLabel?: string
      },
      options?: { replyInThread?: boolean },
    ): Promise<string | null> {
      try {
        log(
          `Sending question card questionId=${params.questionId} options=${params.options.length}`,
          'debug',
        )
        const cardContent = buildQuestionCardContent(params)
        const replyParams: Parameters<typeof client.im.message.reply>[0] = {
          path: { message_id: messageId },
          data: {
            msg_type: 'interactive',
            content: JSON.stringify(cardContent),
          },
        }

        if (options?.replyInThread) {
          ;(replyParams.data as Record<string, unknown>).reply_in_thread = true
        }

        const result: unknown = await client.im.message.reply(replyParams)
        const replyId = extractMessageId(result)
        if (!replyId) {
          log(`Question card reply to ${messageId} but missing message_id`, 'warn')
        }
        return replyId
      } catch (error) {
        log(`Reply question card failed: ${error}`, 'error')
        return null
      }
    },

    async replyPermissionCardWithId(
      messageId: string,
      params: {
        requestId: string
        permission: string
        patterns: string[]
      },
      options?: { replyInThread?: boolean },
    ): Promise<string | null> {
      try {
        const cardContent = buildPermissionCardContent({
          requestId: params.requestId,
          permission: params.permission,
          patterns: params.patterns,
          status: 'pending',
        })
        const replyParams: Parameters<typeof client.im.message.reply>[0] = {
          path: { message_id: messageId },
          data: {
            msg_type: 'interactive',
            content: JSON.stringify(cardContent),
          },
        }

        if (options?.replyInThread) {
          ;(replyParams.data as Record<string, unknown>).reply_in_thread = true
        }

        const result: unknown = await client.im.message.reply(replyParams)
        return extractMessageId(result)
      } catch (error) {
        log(`Reply permission card failed: ${error}`, 'error')
        return null
      }
    },

    async updatePermissionCardWithId(
      messageId: string,
      params: {
        requestId: string
        permission: string
        patterns: string[]
        status: 'approved' | 'rejected'
        replyLabel?: string
      },
    ): Promise<boolean> {
      try {
        const cardContent = buildPermissionCardContent({
          requestId: params.requestId,
          permission: params.permission,
          patterns: params.patterns,
          status: params.status,
          replyLabel: params.replyLabel,
        })
        await client.im.message.patch({
          path: { message_id: messageId },
          data: {
            content: JSON.stringify(cardContent),
          },
        })
        return true
      } catch (error) {
        log(`Update permission card failed: ${error}`, 'error')
        return false
      }
    },

    async updateQuestionCardWithId(
      messageId: string,
      params: {
        title: string
        questionId: string
        questionText: string
        options: Array<{ label: string; description?: string }>
        questionIndex: number
        totalQuestions: number
        selectedLabels?: string[]
        nextLabel?: string
        completed?: boolean
      },
    ): Promise<boolean> {
      try {
        const cardContent = buildQuestionCardContent(params)
        await client.im.message.patch({
          path: { message_id: messageId },
          data: {
            content: JSON.stringify(cardContent),
          },
        })
        return true
      } catch (error) {
        log(`Update question card failed: ${error}`, 'error')
        return false
      }
    },

    async sendAssistantCardMessageWithId(
      chatId: string,
      params: {
        text: string
        footer?: string
        title?: string
        streaming?: boolean
        status?: 'info' | 'warning' | 'error'
        messageParts?: AssistantMessagePart[]
      },
    ): Promise<{ messageId: string; cardId: string; elementId: string } | null> {
      try {
        const elementId = 'assistant_content'
        const cardContent = buildAssistantCardContent({
          ...params,
          elementId,
          showDetails: false,
          showMeta: false,
        })
        const cardResult = await requestCardKit<Record<string, unknown>>(
          'POST',
          '/open-apis/cardkit/v1/cards',
          {
            type: 'card_json',
            data: JSON.stringify(cardContent),
          },
        )
        const cardId = extractCardId(cardResult)
        if (!cardId) {
          log(`Assistant card create failed: missing card_id`, 'warn')
          return null
        }

        const result: unknown = await client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'interactive',
            content: JSON.stringify({ card_id: cardId }),
          },
        })
        const messageId = extractMessageId(result)
        if (!messageId) {
          log(`Assistant card sent to ${chatId} but missing message_id`, 'warn')
          return null
        }
        return { messageId, cardId, elementId }
      } catch (error) {
        log(`Send assistant card failed: ${error}`, 'error')
        return null
      }
    },

    async replyAssistantCardMessageWithId(
      messageId: string,
      params: {
        text: string
        footer?: string
        title?: string
        streaming?: boolean
        status?: 'info' | 'warning' | 'error'
        messageParts?: AssistantMessagePart[]
      },
      options?: { replyInThread?: boolean },
    ): Promise<{ messageId: string; cardId: string; elementId: string } | null> {
      try {
        const cardContent = buildAssistantCardContent({
          ...params,
          showDetails: false,
          showMeta: false,
        })
        const replyParams: Parameters<typeof client.im.message.reply>[0] = {
          path: { message_id: messageId },
          data: {
            msg_type: 'interactive',
            content: JSON.stringify(cardContent),
          },
        }

        if (options?.replyInThread) {
          ;(replyParams.data as Record<string, unknown>).reply_in_thread = true
        }

        const result: unknown = await client.im.message.reply(replyParams)
        const replyId = extractMessageId(result)
        if (!replyId) {
          log(`Assistant card reply to ${messageId} but missing message_id`, 'warn')
          return null
        }
        return { messageId: replyId, cardId: '', elementId: '' }
      } catch (error) {
        log(`Reply assistant card failed: ${error}`, 'error')
        return null
      }
    },

    async updateAssistantCardMessageWithId(
      messageId: string,
      params: {
        text: string
        footer?: string
        title?: string
        streaming?: boolean
        status?: 'info' | 'warning' | 'error'
        messageParts?: AssistantMessagePart[]
      },
    ): Promise<boolean> {
      try {
        const cardContent = buildAssistantCardContent({
          ...params,
          showDetails: false,
          showMeta: false,
        })
        await client.im.message.patch({
          path: { message_id: messageId },
          data: {
            content: JSON.stringify(cardContent),
          },
        })
        return true
      } catch (error) {
        log(`Update assistant card failed: ${error}`, 'error')
        return false
      }
    },
    async updateAssistantCardElementContentWithId(
      cardId: string,
      elementId: string,
      content: string,
    ): Promise<boolean> {
      const result = await requestCardKit<Record<string, unknown>>(
        'PUT',
        `/open-apis/cardkit/v1/cards/${cardId}/elements/${elementId}/content`,
        { content },
      )
      return Boolean(result)
    },
    async updateAssistantCardConfigWithId(
      cardId: string,
      params: {
        sequence: number
        streaming?: boolean
        summary?: string
      },
    ): Promise<boolean> {
      const config = {
        streaming_mode: params.streaming === true,
        update_multi: true,
        width_mode: 'fill',
        summary: params.summary ? { content: params.summary } : undefined,
      }
      const settings = { config }
      const result = await requestCardKit<Record<string, unknown>>(
        'PATCH',
        `/open-apis/cardkit/v1/cards/${cardId}/settings`,
        {
          sequence: params.sequence,
          settings: JSON.stringify(settings),
        },
      )
      return Boolean(result)
    },
    async updateAssistantCardEntityWithId(
      cardId: string,
      params: {
        sequence: number
        text: string
        details?: string
        meta?: string
        showDetails: boolean
        showMeta: boolean
        title?: string
        status?: 'info' | 'warning' | 'error'
      },
    ): Promise<boolean> {
      const cardContent = buildAssistantCardContent({
        text: params.text,
        details: params.details,
        meta: params.meta,
        showDetails: params.showDetails,
        showMeta: params.showMeta,
        title: params.title,
        status: params.status,
        streaming: false,
        elementId: 'assistant_content',
      })
      const result = await requestCardKit<Record<string, unknown>>(
        'PUT',
        `/open-apis/cardkit/v1/cards/${cardId}`,
        {
          sequence: params.sequence,
          card: cardContent,
        },
      )
      return Boolean(result)
    },

    async replyApprovalCardWithId(
      messageId: string,
      params: {
        requestId: string
        channelId: string
        userId: string
        userName?: string
      },
      options?: { replyInThread?: boolean },
    ): Promise<string | null> {
      try {
        const cardContent = buildApprovalCardContent(params)
        const replyParams: Parameters<typeof client.im.message.reply>[0] = {
          path: { message_id: messageId },
          data: {
            msg_type: 'interactive',
            content: JSON.stringify(cardContent),
          },
        }

        if (options?.replyInThread) {
          ;(replyParams.data as Record<string, unknown>).reply_in_thread = true
        }

        const result: unknown = await client.im.message.reply(replyParams)
        const replyId = extractMessageId(result)
        if (!replyId) {
          log(`Approval card reply to ${messageId} but missing message_id`, 'warn')
        }
        return replyId
      } catch (error) {
        log(`Reply approval card failed: ${error}`, 'error')
        return null
      }
    },

    async updateApprovalCard(
      messageId: string,
      status: 'approved' | 'rejected',
      actionBy: string,
    ): Promise<boolean> {
      try {
        const statusText = status === 'approved'
          ? t('status.approved')
          : t('status.rejected')
        const color = status === 'approved' ? 'green' : 'red'

        const cardContent = {
      config: {
        wide_screen_mode: true,
        update_multi: true,
      },
          header: {
            template: color,
            title: {
              content: t('feishu.userApprovalTitle'),
              tag: 'plain_text',
            },
          },
          elements: [
            {
              tag: 'div',
              text: {
                tag: 'lark_md',
                content: t('feishu.approvalStatus', { status: statusText, actionBy }),
              },
            },
          ],
        }

        await client.im.message.patch({
          path: { message_id: messageId },
          data: {
            content: JSON.stringify(cardContent),
          },
        })

        log(`Approval card ${messageId} updated to ${statusText}`, 'debug')
        return true
      } catch (error) {
        log(`Update approval card failed: ${error}`, 'error')
        return false
      }
    },
    async replyWorkspaceBindCardWithId(
      messageId: string,
      params: { userId: string },
      options?: { replyInThread?: boolean },
    ): Promise<string | null> {
      try {
        const cardContent = buildWorkspaceBindCardContent(params)
        const replyParams: Parameters<typeof client.im.message.reply>[0] = {
          path: { message_id: messageId },
          data: {
            msg_type: 'interactive',
            content: JSON.stringify(cardContent),
          },
        }

        if (options?.replyInThread) {
          ;(replyParams.data as Record<string, unknown>).reply_in_thread = true
        }

        const result: unknown = await client.im.message.reply(replyParams)
        const replyId = extractMessageId(result)
        if (!replyId) {
          log(`Workspace bind card reply to ${messageId} but missing message_id`, 'warn')
        }
        return replyId
      } catch (error) {
        log(`Reply workspace bind card failed: ${error}`, 'error')
        return null
      }
    },
    async replyWorkspaceJoinApprovalCardWithId(
      messageId: string,
      params: {
        requestId: string
        workspaceName: string
        requesterUserId: string
        requesterUserName?: string
        ownerUserId: string
      },
      options?: { replyInThread?: boolean },
    ): Promise<string | null> {
      try {
        const cardContent = buildWorkspaceJoinApprovalCardContent(params)
        const replyParams: Parameters<typeof client.im.message.reply>[0] = {
          path: { message_id: messageId },
          data: {
            msg_type: 'interactive',
            content: JSON.stringify(cardContent),
          },
        }

        if (options?.replyInThread) {
          ;(replyParams.data as Record<string, unknown>).reply_in_thread = true
        }

        const result: unknown = await client.im.message.reply(replyParams)
        const replyId = extractMessageId(result)
        if (!replyId) {
          log(`Workspace join card reply to ${messageId} but missing message_id`, 'warn')
        }
        return replyId
      } catch (error) {
        log(`Reply workspace join card failed: ${error}`, 'error')
        return null
      }
    },
    async updateWorkspaceJoinApprovalCard(
      messageId: string,
      status: 'approved' | 'rejected',
      actionBy: string,
    ): Promise<boolean> {
      try {
        const statusText = status === 'approved'
          ? t('status.approved')
          : t('status.rejected')
        const color = status === 'approved' ? 'green' : 'red'

        const cardContent = {
          config: {
            wide_screen_mode: true,
            update_multi: true,
          },
          header: {
            template: color,
            title: {
              content: t('feishu.workspaceJoinTitle'),
              tag: 'plain_text',
            },
          },
          elements: [
            {
              tag: 'div',
              text: {
                tag: 'lark_md',
                content: t('feishu.workspaceJoinStatus', { status: statusText, actionBy }),
              },
            },
          ],
        }

        await client.im.message.patch({
          path: { message_id: messageId },
          data: {
            content: JSON.stringify(cardContent),
          },
        })

        log(`Workspace join card ${messageId} updated to ${statusText}`, 'debug')
        return true
      } catch (error) {
        log(`Update workspace join card failed: ${error}`, 'error')
        return false
      }
    },
    async updateWorkspaceBindApprovalCard(
      messageId: string,
      status: 'approved' | 'rejected',
      actionBy: string,
    ): Promise<boolean> {
      try {
        const statusText = status === 'approved'
          ? t('status.approved')
          : t('status.rejected')
        const color = status === 'approved' ? 'green' : 'red'

        const cardContent = {
          config: {
            wide_screen_mode: true,
            update_multi: true,
          },
          header: {
            template: color,
            title: {
              content: t('feishu.workspaceBindApprovalTitle'),
              tag: 'plain_text',
            },
          },
          elements: [
            {
              tag: 'div',
              text: {
                tag: 'lark_md',
                content: t('feishu.workspaceBindApprovalStatus', { status: statusText, actionBy }),
              },
            },
          ],
        }

        await client.im.message.patch({
          path: { message_id: messageId },
          data: {
            content: JSON.stringify(cardContent),
          },
        })

        log(`Workspace bind approval card ${messageId} updated to ${statusText}`, 'debug')
        return true
      } catch (error) {
        log(`Update workspace bind approval card failed: ${error}`, 'error')
        return false
      }
    },
  }
}

export type FeishuClientInstance = ReturnType<typeof createFeishuClient>
