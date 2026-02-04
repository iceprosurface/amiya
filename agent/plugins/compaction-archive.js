import fs from 'fs'
import path from 'path'

const MAX_MESSAGE_CHARS = 2000

function sanitizeFilename(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50) || 'conversation'
}

function extractTextFromParts(parts) {
  if (!Array.isArray(parts)) return ''
  const textParts = []
  for (const part of parts) {
    if (!part) continue
    if (part.type === 'text' && typeof part.text === 'string') {
      textParts.push(part.text)
      continue
    }
    if (part.type === 'tool' && part.state && typeof part.state.output === 'string') {
      textParts.push(part.state.output)
    }
  }
  return textParts.join('\n').trim()
}

function formatTranscriptMarkdown(messages, title) {
  const now = new Date()
  const formatDateTime = (d) => d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })

  const lines = []
  lines.push(`# ${title || 'Conversation'}`)
  lines.push('')
  lines.push(`Archived: ${formatDateTime(now)}`)
  lines.push('')
  lines.push('---')
  lines.push('')

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : 'Assistant'
    const content = msg.content.length > MAX_MESSAGE_CHARS
      ? msg.content.slice(0, MAX_MESSAGE_CHARS) + '...'
      : msg.content
    lines.push(`**${sender}**: ${content}`)
    lines.push('')
  }

  return lines.join('\n')
}

function resolveConversationsDir(directory) {
  const groupDir = '/workspace/group'
  if (fs.existsSync(groupDir)) return path.join(groupDir, 'conversations')
  return path.join(directory || process.cwd(), 'conversations')
}

export const CompactionArchivePlugin = async ({ client, directory }) => {
  return {
    'experimental.session.compacting': async (input) => {
      try {
        const sessionId = input?.session?.id || input?.session_id || input?.sessionId || input?.id
        if (!sessionId) return

        const conversationsDir = resolveConversationsDir(directory)
        fs.mkdirSync(conversationsDir, { recursive: true })

        const sessionResp = await client.session.get({
          path: { id: sessionId },
          query: directory ? { directory } : undefined,
        }).catch(() => null)
        const session = sessionResp?.data ?? sessionResp
        const title = session?.title || ''

        const msgResp = await client.session.messages({
          path: { id: sessionId },
          query: directory ? { directory } : undefined,
        }).catch(() => null)
        const rawMessages = msgResp?.data ?? msgResp
        if (!Array.isArray(rawMessages) || rawMessages.length === 0) return

        const messages = rawMessages
          .map((entry) => {
            const info = entry?.info ?? entry?.message ?? entry?.meta ?? entry
            const role = info?.role || info?.type || (info?.isUser ? 'user' : 'assistant')
            const parts = entry?.parts || entry?.content || []
            const content = extractTextFromParts(parts)
            if (!content) return null
            return {
              role: role === 'user' ? 'user' : 'assistant',
              content,
            }
          })
          .filter(Boolean)

        if (messages.length === 0) return

        const date = new Date().toISOString().split('T')[0]
        const name = sanitizeFilename(title || `session-${sessionId.slice(0, 8)}`)
        const filePath = path.join(
          conversationsDir,
          `${date}-${name}-${sessionId.slice(0, 8)}.md`,
        )
        if (fs.existsSync(filePath)) return

        const markdown = formatTranscriptMarkdown(messages, title || null)
        fs.writeFileSync(filePath, markdown)
      } catch {
      }
    },
  }
}
