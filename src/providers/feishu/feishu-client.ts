import * as lark from '@larksuiteoapi/node-sdk'
import type { FeishuConfig } from './feishu-config'
import { feishuPostToJson, markdownToFeishuPost } from './markdown-adapter.js'

export function createFeishuClient(
  config: FeishuConfig,
  logger?: (message: string, level?: 'debug' | 'info' | 'warn' | 'error') => void,
) {
  const client = new lark.Client({
    appId: config.appId,
    appSecret: config.appSecret,
    domain: config.useLark ? lark.Domain.Lark : lark.Domain.Feishu,
    loggerLevel: config.debug ? lark.LoggerLevel.debug : lark.LoggerLevel.info,
  })

  const log = (message: string, level: 'debug' | 'info' | 'warn' | 'error' = 'info') => {
    if (logger) {
      logger(`[Feishu] ${message}`, level)
    } else if (config.debug) {
      // console.log(`[Feishu][${level}] ${message}`)
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
  }) => {
    const optionText = params.options
      .map((opt) => (opt.description ? `- **${opt.label}**：${opt.description}` : `- **${opt.label}**`))
      .join('\n')

    return {
      config: {
        wide_screen_mode: true,
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
            content: `**${params.questionText}**\n${optionText}`,
          },
        },
        {
          tag: 'action',
          actions: params.options.map((opt) => ({
            tag: 'button',
            text: {
              tag: 'plain_text',
              content: opt.label,
            },
            value: {
              action: 'question',
              question_id: params.questionId,
              answer_label: opt.label,
            },
          })),
        },
      ],
    }
  }

  return {
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

        await client.im.message.update({
          path: { message_id: messageId },
          data: {
            msg_type: 'interactive',
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
