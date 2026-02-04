import fs from 'fs'
import path from 'path'

import { createOpencodeClient, createOpencodeServer } from '@opencode-ai/sdk'

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---'
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---'

const DEFAULT_SYSTEM_PROMPT = [
  'You are an assistant running inside a container.',
  'You can read/write files under /workspace.',
  'To send a message back to Feishu, write a JSON file into /workspace/ipc/messages.',
  'Format: {"type":"message","chatJid":"...","text":"..."}',
  'To schedule tasks, write JSON into /workspace/ipc/tasks with type:',
  '  schedule_task | pause_task | resume_task | cancel_task | refresh_groups | register_group.',
  'Keep replies concise and return only the final answer unless asked to detail steps.',
].join('\n')

function log(message, data) {
  const line = data ? `${message} ${JSON.stringify(data)}` : message
  process.stderr.write(`${line}\n`)
}

function ensureOpencodePath() {
  const candidates = [
    '/root/.opencode/bin/opencode',
    '/home/node/.opencode/bin/opencode',
  ]
  let found = false
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      const dir = path.dirname(candidate)
      if (!process.env.PATH?.includes(dir)) {
        process.env.PATH = `${dir}:${process.env.PATH || ''}`
      }
      found = true
      break
    }
  }
  if (!found) {
    log('opencode binary not found', {
      candidates,
      path: process.env.PATH || '',
    })
  }
}

function outputResult(payload) {
  const json = JSON.stringify(payload)
  process.stdout.write(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`)
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = ''
    process.stdin.setEncoding('utf-8')
    process.stdin.on('data', (chunk) => {
      data += chunk
    })
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', (err) => reject(err))
  })
}

function loadEnvFile(envFilePath) {
  if (!fs.existsSync(envFilePath)) return
  const content = fs.readFileSync(envFilePath, 'utf-8')
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eqIndex = line.indexOf('=')
    if (eqIndex <= 0) continue
    const key = line.slice(0, eqIndex).trim()
    const value = line.slice(eqIndex + 1).trim()
    if (!key) continue
    if (process.env[key] !== undefined) continue
    process.env[key] = value
  }
}

function resolveSystemPrompt() {
  const override = process.env.OPENCODE_SYSTEM_PROMPT
  if (override && override.trim()) return override.trim()

  const filePath = '/workspace/group/system.md'
  if (fs.existsSync(filePath)) {
    const content = fs.readFileSync(filePath, 'utf-8').trim()
    if (content) return content
  }

  return DEFAULT_SYSTEM_PROMPT
}

function extractText(parts) {
  if (!Array.isArray(parts)) return ''
  const textParts = parts
    .filter((part) => part && part.type === 'text')
    .map((part) => part.text)
    .filter((value) => typeof value === 'string' && value.trim().length > 0)
  return textParts.join('\n')
}

async function run() {
  try {
    const inputRaw = await readStdin()
    if (!inputRaw.trim()) {
      outputResult({ status: 'error', result: null, error: 'No input' })
      return
    }

    const input = JSON.parse(inputRaw)
    const prompt = typeof input.prompt === 'string' ? input.prompt : ''
    if (!prompt) {
      outputResult({ status: 'error', result: null, error: 'Prompt is empty' })
      return
    }

    loadEnvFile('/workspace/env-dir/env')
    ensureOpencodePath()

    const workDir = input.isMain ? '/workspace/project' : '/workspace/group'
    const serverConfig = {
      permission: {
        edit: 'allow',
        bash: 'allow',
        webfetch: 'allow',
      },
    }

    const serverUrlOverride = process.env.OPENCODE_SERVER_URL
    let server = null
    let baseUrl = serverUrlOverride

    if (!baseUrl) {
      server = await createOpencodeServer({
        config: serverConfig,
      })
      baseUrl = server.url
    }

    const headers = {}
    if (process.env.OPENCODE_API_KEY) {
      headers.Authorization = `Bearer ${process.env.OPENCODE_API_KEY}`
    } else if (process.env.OPENCODE_OAUTH_TOKEN) {
      headers.Authorization = `Bearer ${process.env.OPENCODE_OAUTH_TOKEN}`
    }

    const client = createOpencodeClient({
      baseUrl,
      headers,
      directory: workDir,
    })

    let sessionId = typeof input.sessionId === 'string' && input.sessionId
      ? input.sessionId
      : null

    if (sessionId) {
      const sessionCheck = await client.session.get({
        path: { id: sessionId },
        query: { directory: workDir },
      })
      if (!sessionCheck?.data?.id) {
        sessionId = null
      }
    }

    if (!sessionId) {
      const title = prompt.length > 80 ? `${prompt.slice(0, 77)}...` : prompt
      const created = await client.session.create({
        body: { title: title || 'Amiya' },
        query: { directory: workDir },
      })
      sessionId = created?.data?.id || null
    }

    if (!sessionId) {
      outputResult({
        status: 'error',
        result: null,
        error: 'Failed to create session',
      })
      if (server) server.close()
      return
    }

    const system = resolveSystemPrompt()
    const response = await client.session.prompt({
      path: { id: sessionId },
      query: { directory: workDir },
      body: {
        system,
        parts: [
          {
            type: 'text',
            text: prompt,
          },
        ],
      },
    })

    const resultText = extractText(response?.data?.parts)
    const result = resultText || '[no text response]'

    outputResult({
      status: 'success',
      result,
      newSessionId: sessionId,
    })

    if (server) server.close()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log('Agent error', { message })
    outputResult({ status: 'error', result: null, error: message })
  }
}

run()
