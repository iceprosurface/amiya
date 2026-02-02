import * as lark from '@larksuiteoapi/node-sdk'
import type { FeishuConfig } from './feishu-config'
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
          content: '用户访问审批',
          tag: 'plain_text',
        },
      },
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: `**用户**: ${userName}\n**用户ID**: ${params.userId}\n**频道**: ${params.channelId}`,
          },
        },
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: {
                tag: 'plain_text',
                content: '同意',
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
                content: '拒绝',
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
      ? `\n\n_第 ${params.questionIndex + 1}/${params.totalQuestions} 题_`
      : ''
    const selectedText = params.selectedLabels && params.selectedLabels.length > 0
      ? `\n\n**已选**：${params.selectedLabels.join('，')}`
      : ''

    if (params.completed) {
      return {
        config: {
          wide_screen_mode: true,
        },
        header: {
          template: 'green',
          title: {
            content: params.title || '已提交',
            tag: 'plain_text',
          },
        },
        elements: [
          {
            tag: 'div',
            text: {
              tag: 'lark_md',
              content: `✅ 已提交问题回答${progressText}`,
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
      text: { tag: 'plain_text', content: params.nextLabel || '下一步' },
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
            text: { tag: 'plain_text', content: '上一步' },
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
          content: params.title || '请选择',
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
      : '_无匹配规则_'
    const statusLabel = params.status === 'approved'
      ? `✅ 已允许（${params.replyLabel || 'once'}）`
      : params.status === 'rejected'
        ? '❌ 已拒绝'
        : '⚠️ 需要权限确认'

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
            content: '权限请求已处理',
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
          content: '权限请求',
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
              text: { tag: 'plain_text', content: '仅本次允许' },
              type: 'primary',
              value: {
                action: 'permission',
                request_id: params.requestId,
                reply: 'once',
              },
            },
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '始终允许' },
              value: {
                action: 'permission',
                request_id: params.requestId,
                reply: 'always',
              },
            },
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '拒绝' },
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
        const statusText = status === 'approved' ? '已同意' : '已拒绝'
        const color = status === 'approved' ? 'green' : 'red'

        const cardContent = {
      config: {
        wide_screen_mode: true,
        update_multi: true,
      },
          header: {
            template: color,
            title: {
              content: '用户访问审批',
              tag: 'plain_text',
            },
          },
          elements: [
            {
              tag: 'div',
              text: {
                tag: 'lark_md',
                content: `审批${statusText}，操作人: ${actionBy}`,
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
  }
}

export type FeishuClientInstance = ReturnType<typeof createFeishuClient>
