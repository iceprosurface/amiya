import fs from 'fs'
import path from 'path'

import { createOpencode } from '@opencode-ai/sdk'

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---'
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---'
const COMPACTION_PLUGIN_PATH = '.opencode/plugins/compaction-archive.js'
const COMPACTION_PLUGIN_SOURCE = '/app/plugins/compaction-archive.js'

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
  if (override && override.trim()) {
    log('Using system prompt from env')
    return override.trim()
  }

  const filePath = '/workspace/group/system.md'
  if (fs.existsSync(filePath)) {
    const content = fs.readFileSync(filePath, 'utf-8').trim()
    if (content) {
      log('Using system prompt from group system.md')
      return content
    }
  }

  const sharedPath = '/workspace/shared/system.md'
  if (fs.existsSync(sharedPath)) {
    const content = fs.readFileSync(sharedPath, 'utf-8').trim()
    if (content) {
      log('Using system prompt from shared system.md')
      return content
    }
  }

  log('Using default system prompt')
  return DEFAULT_SYSTEM_PROMPT
}

function ensureOpencodeAuth() {
  const sourceDir = '/workspace/opencode-share'
  const sourceFile = path.join(sourceDir, 'auth.json')
  if (!fs.existsSync(sourceFile)) return

  const targetDir = '/root/.local/share/opencode'
  const targetFile = path.join(targetDir, 'auth.json')
  fs.mkdirSync(targetDir, { recursive: true })
  if (!fs.existsSync(targetFile)) {
    fs.copyFileSync(sourceFile, targetFile)
  }
}

function copyDirContents(sourceDir, targetDir) {
  if (!fs.existsSync(sourceDir)) return
  fs.mkdirSync(targetDir, { recursive: true })
  const entries = fs.readdirSync(sourceDir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isDirectory()) continue
    const sourcePath = path.join(sourceDir, entry.name)
    const targetPath = path.join(targetDir, entry.name)
    if (!fs.existsSync(targetPath)) {
      fs.copyFileSync(sourcePath, targetPath)
    }
  }
}

function ensureOpencodeConfig() {
  const sourceDir = '/workspace/opencode-global'
  const targetDir = '/root/.config/opencode'
  copyDirContents(sourceDir, targetDir)
}

function ensureCompactionPlugin(workDir) {
  if (!workDir) return
  if (!fs.existsSync(COMPACTION_PLUGIN_SOURCE)) return
  const pluginPath = path.join(workDir, COMPACTION_PLUGIN_PATH)
  const pluginDir = path.dirname(pluginPath)
  fs.mkdirSync(pluginDir, { recursive: true })
  fs.copyFileSync(COMPACTION_PLUGIN_SOURCE, pluginPath)
}

function extractText(parts) {
  if (!Array.isArray(parts)) return ''
  const textParts = parts
    .filter((part) => part && part.type === 'text')
    .map((part) => part.text)
    .filter((value) => typeof value === 'string' && value.trim().length > 0)
  return textParts.join('\n')
}

function normalizeProvidersResponse(response) {
  return response?.data?.providers || response?.providers || response?.data || []
}

function pickModelContext(model) {
  if (!model || typeof model !== 'object') return null
  const candidates = [
    'contextWindow',
    'context_window',
    'context',
    'context_length',
    'maxTokens',
    'max_tokens',
    'max_input_tokens',
  ]
  for (const key of candidates) {
    const value = model[key]
    if (typeof value === 'number' && value > 0) return value
  }
  return null
}

async function getModelContextLimit(client, modelID, providerID, directory) {
  if (!modelID) return null
  try {
    const response = await client.config.providers()
    const providers = normalizeProvidersResponse(response)
    if (!Array.isArray(providers)) return null

    for (const provider of providers) {
      const providerKey =
        provider?.id || provider?.providerID || provider?.name || provider?.key
      if (providerID && providerKey && providerKey !== providerID) continue
      const models = provider?.models || provider?.model || []
      if (!Array.isArray(models)) continue
      const match = models.find((m) =>
        (m?.id || m?.modelID || m?.name) === modelID,
      )
      if (match) return pickModelContext(match)
    }
  } catch {
  }
  return null
}

async function getLatestAssistantUsage(client, sessionId, directory) {
  if (!sessionId) return null
  try {
    const response = await client.session.messages({
      path: { id: sessionId },
      query: directory ? { directory } : undefined,
    })
    const messages = response?.data || response
    if (!Array.isArray(messages)) return null

    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const entry = messages[i]
      const info = entry?.info || entry?.message || entry?.meta || entry
      const role = info?.role || info?.type
      if (role !== 'assistant') continue

      const modelID =
        info?.modelID || info?.model?.id || info?.model?.modelID || null
      const providerID =
        info?.providerID || info?.provider?.id || info?.model?.providerID || null
      const tokens = info?.tokens || info?.usage?.tokens || null
      const cost = info?.cost ?? info?.usage?.cost ?? null
      const contextLimit =
        info?.contextWindow ||
        info?.context_window ||
        info?.model?.contextWindow ||
        info?.model?.context_window ||
        info?.model?.maxTokens ||
        info?.model?.max_tokens ||
        null

      return { modelID, providerID, tokens, cost, contextLimit }
    }
  } catch {
  }
  return null
}

function formatUsageTail({ modelID, contextPercent, cost }) {
  if (!modelID && contextPercent === null && cost === null) return null
  const parts = []
  if (modelID) parts.push(`model=${modelID}`)
  if (contextPercent !== null) parts.push(`context=${contextPercent}%`)
  if (typeof cost === 'number') parts.push(`cost=${cost}`)
  return parts.length > 0 ? `[usage] ${parts.join(' ')}` : null
}

function withTimeout(promise, timeoutMs) {
  let timeoutId
  const timeout = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve(null), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId)
  })
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
    ensureOpencodeAuth()
    ensureOpencodeConfig()

    const workDir = input.isMain ? '/workspace/project' : '/workspace/group'
    ensureCompactionPlugin(workDir)
    const { client, server } = await createOpencode({
      config: {
        permission: {
          edit: 'allow',
          bash: 'allow',
          webfetch: 'allow',
        },
      },
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
      try {
        const created = await client.session.create({
          body: { title: title || 'Amiya' },
          query: { directory: workDir },
        })
        sessionId = created?.data?.id || null
        if (!sessionId) {
          log('Session create returned no id', { response: created })
        }
      } catch (err) {
        log('Session create failed', {
          error: err instanceof Error ? err.message : String(err),
        })
        sessionId = null
      }
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
    let result = resultText || '[no text response]'

    const usage = await withTimeout(
      getLatestAssistantUsage(client, sessionId, workDir),
      1500,
    )
    if (usage) {
      let contextPercent = null
      if (usage.tokens && typeof usage.tokens.input === 'number') {
        let contextLimit = usage.contextLimit
        if (!contextLimit) {
          contextLimit = await withTimeout(
            getModelContextLimit(
              client,
              usage.modelID,
              usage.providerID,
              workDir,
            ),
            1500,
          )
        }
        if (contextLimit && contextLimit > 0) {
          contextPercent = Math.min(
            100,
            Math.round((usage.tokens.input / contextLimit) * 100),
          )
        }
      }

      const usageTail = formatUsageTail({
        modelID: usage.modelID,
        contextPercent,
        cost: typeof usage.cost === 'number' ? usage.cost : null,
      })
      if (usageTail) {
        result = `${result}\n\n${usageTail}`
      }
    }

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
