import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import { createOpencodeClient, type OpencodeClient, type Config } from '@opencode-ai/sdk'
import {
  createOpencodeClient as createOpencodeClientV2,
  type OpencodeClient as OpencodeClientV2,
} from '@opencode-ai/sdk/v2'
import {
  DirectoryNotAccessibleError,
  ServerNotReadyError,
  ServerStartError,
} from './errors.js'

const opencodeServers = new Map<
  string,
  {
    process: ChildProcess
    client: OpencodeClient
    clientV2: OpencodeClientV2
    port: number
  }
>()

const serverRetryCount = new Map<string, number>()

async function getOpenPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, () => {
      const address = server.address()
      if (address && typeof address === 'object') {
        const { port } = address
        server.close(() => {
          resolve(port)
        })
      } else {
        reject(new Error('获取端口失败'))
      }
    })
    server.on('error', reject)
  })
}

async function waitForServer(port: number, maxAttempts = 30): Promise<ServerStartError | true> {
  const endpoint = `http://127.0.0.1:${port}/api/health`
  let lastError: unknown
  let lastStatus: number | undefined
  let lastBodySnippet: string | undefined

  for (let i = 0; i < maxAttempts; i++) {
    try {
      const response = await fetch(endpoint)
      lastStatus = response.status

      // Any non-5xx response means the HTTP server is up.
      if (response.status < 500) {
        return true
      }

      const body = await response.text()
      lastBodySnippet = body.slice(0, 400)

      if (body.includes('BunInstallFailedError')) {
        return new ServerStartError(port, body.slice(0, 200))
      }
    } catch (error) {
      // Connection refused or other transient errors.
      lastError = error
    }

    await new Promise((resolve) => setTimeout(resolve, 1000))
  }

  let reason = `Server did not start after ${maxAttempts} seconds`
  if (typeof lastStatus === 'number') {
    reason += `; lastStatus=${lastStatus}`
  }
  if (typeof lastBodySnippet === 'string' && lastBodySnippet.length > 0) {
    reason += `; lastBody=${lastBodySnippet}`
  }
  if (lastError instanceof Error) {
    reason += `; lastError=${lastError.name}: ${lastError.message}`
    const errorWithCause = lastError as { cause?: unknown }
    if (errorWithCause.cause) {
      const cause = errorWithCause.cause
      if (cause instanceof Error) {
        reason += `; cause=${cause.name}: ${cause.message}`
      } else if (typeof cause === 'object') {
        const c = cause as Record<string, unknown>
        const code = typeof c.code === 'string' ? c.code : undefined
        const syscall = typeof c.syscall === 'string' ? c.syscall : undefined
        const address = typeof c.address === 'string' ? c.address : undefined
        const portVal = typeof c.port === 'number' ? String(c.port) : undefined
        const bits = [code, syscall, address, portVal].filter(Boolean)
        if (bits.length > 0) {
          reason += `; causeDetail=${bits.join(' ')}`
        }
      }
    }
  } else if (typeof lastError !== 'undefined') {
    reason += `; lastError=${String(lastError)}`
  }

  return new ServerStartError(port, reason)
}

export async function initializeOpencodeForDirectory(
  directory: string,
  config?: Config,
): Promise<Error | (() => OpencodeClient)> {
  const existing = opencodeServers.get(directory)
  if (existing && !existing.process.killed) {
    return () => {
      const entry = opencodeServers.get(directory)
      if (!entry?.client) {
        throw new ServerNotReadyError(directory)
      }
      return entry.client
    }
  }

  try {
    fs.accessSync(directory, fs.constants.R_OK | fs.constants.X_OK)
  } catch {
    return new DirectoryNotAccessibleError(directory)
  }

  const port = await getOpenPort()

  const opencodeCommand = process.env.OPENCODE_PATH || 'opencode'
  const opencodeConfig: Config = {
    $schema: 'https://opencode.ai/config.json',
    lsp: false,
    formatter: false,
    permission: {
      edit: 'allow',
      bash: 'allow',
      webfetch: 'allow',
    },
    ...(config || {}),
  }

  const serverProcess = spawn(opencodeCommand, ['serve', '--port', port.toString()], {
    stdio: 'pipe',
    detached: false,
    cwd: directory,
    env: {
      ...process.env,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeConfig),
      OPENCODE_PORT: port.toString(),
    },
  })

  const logBuffer: string[] = []
  logBuffer.push(`Spawned opencode serve --port ${port} in ${directory} (pid: ${serverProcess.pid})`)

  serverProcess.stdout?.on('data', (data) => {
    logBuffer.push(`[stdout] ${data.toString().trim()}`)
  })

  serverProcess.stderr?.on('data', (data) => {
    logBuffer.push(`[stderr] ${data.toString().trim()}`)
  })

  serverProcess.on('exit', (code) => {
    opencodeServers.delete(directory)
    if (code !== 0) {
      const retryCount = serverRetryCount.get(directory) || 0
      if (retryCount < 5) {
        serverRetryCount.set(directory, retryCount + 1)
        initializeOpencodeForDirectory(directory, config).catch(() => {})
      } else {
        serverRetryCount.delete(directory)
      }
    } else {
      serverRetryCount.delete(directory)
    }
  })

  const waitResult = await waitForServer(port)
  if (waitResult instanceof Error) {
    for (const line of logBuffer) {
      console.error(line)
    }
    return waitResult
  }

  const baseUrl = `http://127.0.0.1:${port}`
  const fetchWithTimeout = (request: Request) =>
    fetch(request, {
      // @ts-ignore
      timeout: false,
    })

  const client = createOpencodeClient({
    baseUrl,
    fetch: fetchWithTimeout,
  })

  const clientV2 = createOpencodeClientV2({
    baseUrl,
    fetch: fetchWithTimeout as typeof fetch,
  })

  opencodeServers.set(directory, {
    process: serverProcess,
    client,
    clientV2,
    port,
  })

  return () => {
    const entry = opencodeServers.get(directory)
    if (!entry?.client) {
      throw new ServerNotReadyError(directory)
    }
    return entry.client
  }
}

export function getOpencodeServers() {
  return opencodeServers
}

export function getOpencodeServerPort(directory: string): number | null {
  const entry = opencodeServers.get(directory)
  return entry?.port ?? null
}

export function getOpencodeClientV2(directory: string): OpencodeClientV2 | null {
  const entry = opencodeServers.get(directory)
  return entry?.clientV2 ?? null
}

export async function restartOpencodeServer(directory: string, config?: Config): Promise<Error | true> {
  const existing = opencodeServers.get(directory)
  if (existing) {
    serverRetryCount.set(directory, 999)
    existing.process.kill('SIGTERM')
    opencodeServers.delete(directory)
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  serverRetryCount.delete(directory)
  const result = await initializeOpencodeForDirectory(directory, config)
  if (result instanceof Error) {
    return result
  }
  return true
}
