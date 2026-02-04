import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'

import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT,
  CONTAINER_RUNTIME,
  DATA_DIR,
  GROUPS_DIR,
} from './config.js'
import { logger } from './logger.js'
import { validateAdditionalMounts } from './mount-security.js'
import { RegisteredGroup } from './types.js'

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---'
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---'

export interface ContainerInput {
  prompt: string
  sessionId?: string
  groupFolder: string
  chatJid: string
  isMain: boolean
  isScheduledTask?: boolean
}

export interface ContainerOutput {
  status: 'success' | 'error'
  result: string | null
  newSessionId?: string
  error?: string
}

interface VolumeMount {
  hostPath: string
  containerPath: string
  readonly?: boolean
}

function buildVolumeMounts(group: RegisteredGroup, isMain: boolean): VolumeMount[] {
  const mounts: VolumeMount[] = []
  const projectRoot = process.cwd()

  if (isMain) {
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: false,
    })
    mounts.push({
      hostPath: path.join(GROUPS_DIR, group.folder),
      containerPath: '/workspace/group',
      readonly: false,
    })
  } else {
    mounts.push({
      hostPath: path.join(GROUPS_DIR, group.folder),
      containerPath: '/workspace/group',
      readonly: false,
    })

    const globalDir = path.join(GROUPS_DIR, 'global')
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true,
      })
    }
  }

  const groupIpcDir = path.join(DATA_DIR, 'ipc', group.folder)
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true })
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true })
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  })

  const envDir = path.join(DATA_DIR, 'env')
  fs.mkdirSync(envDir, { recursive: true })
  const envFile = path.join(projectRoot, '.env')
  if (fs.existsSync(envFile)) {
    const envContent = fs.readFileSync(envFile, 'utf-8')
    const allowedVars = ['OPENCODE_API_KEY', 'OPENCODE_OAUTH_TOKEN']
    const filteredLines = envContent.split('\n').filter((line) => {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) return false
      return allowedVars.some((v) => trimmed.startsWith(`${v}=`))
    })

    if (filteredLines.length > 0) {
      fs.writeFileSync(path.join(envDir, 'env'), `${filteredLines.join('\n')}\n`)
      mounts.push({
        hostPath: envDir,
        containerPath: '/workspace/env-dir',
        readonly: true,
      })
    }
  }

  if (group.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      group.containerConfig.additionalMounts,
      group.name,
      isMain,
    )
    mounts.push(...validatedMounts)
  }

  const sharedAgentDir = path.join(projectRoot, '.amiya', 'agent-share')
  const legacySystemPrompt = path.join(projectRoot, '.amiya', 'system.md')
  const sharedSystemPrompt = path.join(sharedAgentDir, 'system.md')
  if (fs.existsSync(legacySystemPrompt)) {
    fs.mkdirSync(sharedAgentDir, { recursive: true })
    if (!fs.existsSync(sharedSystemPrompt)) {
      fs.copyFileSync(legacySystemPrompt, sharedSystemPrompt)
    }
  }
  if (fs.existsSync(sharedAgentDir) && fs.statSync(sharedAgentDir).isDirectory()) {
    mounts.push({
      hostPath: sharedAgentDir,
      containerPath: '/workspace/shared',
      readonly: true,
    })
  }

  const opencodeConfigDir = path.join(projectRoot, '.amiya', 'opencode-global')
  if (fs.existsSync(opencodeConfigDir) && fs.statSync(opencodeConfigDir).isDirectory()) {
    mounts.push({
      hostPath: opencodeConfigDir,
      containerPath: '/workspace/opencode-global',
      readonly: true,
    })
  }

  const opencodeShareDir = path.join(projectRoot, '.amiya', 'opencode-share')
  if (fs.existsSync(opencodeShareDir) && fs.statSync(opencodeShareDir).isDirectory()) {
    mounts.push({
      hostPath: opencodeShareDir,
      containerPath: '/workspace/opencode-share',
      readonly: true,
    })
  }

  const opencodeLogDir = path.join(
    DATA_DIR,
    'opencode-log',
    group.folder,
  )
  fs.mkdirSync(opencodeLogDir, { recursive: true })
  mounts.push({
    hostPath: opencodeLogDir,
    containerPath: '/root/.local/share/opencode/log',
    readonly: false,
  })

  const opencodeStorageDir = path.join(
    DATA_DIR,
    'opencode-storage',
    group.folder,
  )
  fs.mkdirSync(opencodeStorageDir, { recursive: true })
  mounts.push({
    hostPath: opencodeStorageDir,
    containerPath: '/root/.local/share/opencode/storage',
    readonly: false,
  })

  return mounts
}

function buildContainerArgs(mounts: VolumeMount[], containerName?: string): string[] {
  const args: string[] = ['run', '-i', '--rm']

  if (containerName) {
    args.push('--name', containerName)
  }

  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(
        '--mount',
        `type=bind,source=${mount.hostPath},target=${mount.containerPath},readonly`,
      )
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`)
    }
  }

  args.push(CONTAINER_IMAGE)
  return args
}

export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
): Promise<ContainerOutput> {
  const startTime = Date.now()
  const groupDir = path.join(GROUPS_DIR, group.folder)
  fs.mkdirSync(groupDir, { recursive: true })

  const mounts = buildVolumeMounts(group, input.isMain)
  const safeFolder = group.folder.replace(/[^a-zA-Z0-9_.-]/g, '-')
  const randomSuffix = Math.random().toString(36).slice(2, 8)
  const containerName = `amiya-${safeFolder}-${Date.now()}-${randomSuffix}`
  const containerArgs = buildContainerArgs(mounts, containerName)

  logger.info(
    {
      group: group.name,
      mountCount: mounts.length,
      isMain: input.isMain,
      mounts: mounts.map(
        (m) =>
          `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      ),
    },
    'Spawning container agent',
  )

  const logsDir = path.join(GROUPS_DIR, group.folder, 'logs')
  fs.mkdirSync(logsDir, { recursive: true })

  return await new Promise((resolve) => {
    const container = spawn(CONTAINER_RUNTIME, containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let settled = false
    let didTimeout = false

    const cleanupContainer = (reason: string) => {
      const cleanup = spawn(CONTAINER_RUNTIME, ['rm', '-f', containerName], {
        stdio: 'ignore',
      })
      cleanup.on('error', (err) => {
        logger.debug(
          { container: containerName, error: err, reason },
          'Failed to cleanup container',
        )
      })
    }

    const safeResolve = (output: ContainerOutput) => {
      if (settled) return
      settled = true
      resolve(output)
    }

    let stdout = ''
    let stderr = ''
    let stdoutTruncated = false
    let stderrTruncated = false

    container.stdin.write(JSON.stringify(input))
    container.stdin.end()

    container.stdout.on('data', (data) => {
      if (stdoutTruncated) return
      const chunk = data.toString()
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length
      if (chunk.length > remaining) {
        stdout += chunk.slice(0, remaining)
        stdoutTruncated = true
        logger.warn({ group: group.name }, 'Container stdout truncated')
      } else {
        stdout += chunk
      }
    })

    container.stderr.on('data', (data) => {
      const chunk = data.toString()
      const lines = chunk.trim().split('\n')
      for (const line of lines) {
        if (line) logger.debug({ container: group.folder }, line)
      }
      if (stderrTruncated) return
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining)
        stderrTruncated = true
        logger.warn({ group: group.name }, 'Container stderr truncated')
      } else {
        stderr += chunk
      }
    })

    const timeout = setTimeout(() => {
      logger.error({ group: group.name }, 'Container timeout, killing')
      didTimeout = true
      container.kill('SIGKILL')
      cleanupContainer('timeout')
      safeResolve({
        status: 'error',
        result: null,
        error: `Container timed out after ${CONTAINER_TIMEOUT}ms`,
      })
    }, group.containerConfig?.timeout || CONTAINER_TIMEOUT)

    container.on('close', (code) => {
      clearTimeout(timeout)
      const duration = Date.now() - startTime

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      const logFile = path.join(logsDir, `container-${timestamp}.log`)
      const isVerbose =
        process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace'

      const logLines = [
        '=== Container Run Log ===',
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${group.name}`,
        `IsMain: ${input.isMain}`,
        `Container Name: ${containerName}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stdout Truncated: ${stdoutTruncated}`,
        `Stderr Truncated: ${stderrTruncated}`,
        '',
      ]

      if (isVerbose) {
        logLines.push(
          '=== Input ===',
          JSON.stringify(input, null, 2),
          '',
          '=== Container Args ===',
          containerArgs.join(' '),
          '',
          '=== Mounts ===',
          mounts
            .map(
              (m) =>
                `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
            )
            .join('\n'),
          '',
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
          '',
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
        )
      } else {
        logLines.push(
          '=== Input Summary ===',
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          '',
          '=== Mounts ===',
          mounts
            .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
            .join('\n'),
          '',
        )

        if (code !== 0) {
          logLines.push(
            '=== Stderr (last 500 chars) ===',
            stderr.slice(-500),
            '',
          )
        }
      }

      fs.writeFileSync(logFile, logLines.join('\n'))
      logger.debug({ logFile, verbose: isVerbose }, 'Container log written')

      cleanupContainer('close')

      if (didTimeout) {
        return
      }

      if (code !== 0) {
        logger.error(
          {
            group: group.name,
            code,
            duration,
            stderr: stderr.slice(-500),
            logFile,
          },
          'Container exited with error',
        )

        safeResolve({
          status: 'error',
          result: null,
          error: `Container exited with code ${code}: ${stderr.slice(-200)}`,
        })
        return
      }

      try {
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER)
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER)

        let jsonLine: string
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim()
        } else {
          const lines = stdout.trim().split('\n')
          jsonLine = lines[lines.length - 1]
        }

        const output = JSON.parse(jsonLine) as ContainerOutput

        logger.info(
          {
            group: group.name,
            duration,
            status: output.status,
            hasResult: !!output.result,
          },
          'Container completed',
        )

        safeResolve(output)
      } catch (err) {
        logger.error(
          {
            group: group.name,
            stdout: stdout.slice(-500),
            error: err,
          },
          'Failed to parse container output',
        )

        safeResolve({
          status: 'error',
          result: null,
          error:
            `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`,
        })
      }
    })

    container.on('error', (err) => {
      clearTimeout(timeout)
      logger.error({ group: group.name, error: err }, 'Container spawn error')
      cleanupContainer('spawn-error')
      safeResolve({
        status: 'error',
        result: null,
        error: `Container spawn error: ${err.message}`,
      })
    })
  })
}

export function writeTasksSnapshot(
  groupFolder: string,
  isMain: boolean,
  tasks: Array<{
    id: string
    groupFolder: string
    prompt: string
    schedule_type: string
    schedule_value: string
    status: string
    next_run: string | null
  }>,
): void {
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder)
  fs.mkdirSync(groupIpcDir, { recursive: true })

  const filteredTasks = isMain
    ? tasks
    : tasks.filter((t) => t.groupFolder === groupFolder)

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json')
  fs.writeFileSync(tasksFile, JSON.stringify(filteredTasks, null, 2))
}

export interface AvailableGroup {
  jid: string
  name: string
  lastActivity: string
  isRegistered: boolean
}

export function writeGroupsSnapshot(
  groupFolder: string,
  isMain: boolean,
  groups: AvailableGroup[],
  registeredJids: Set<string>,
): void {
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder)
  fs.mkdirSync(groupIpcDir, { recursive: true })

  const visibleGroups = isMain ? groups : []

  const groupsFile = path.join(groupIpcDir, 'available_groups.json')
  fs.writeFileSync(
    groupsFile,
    JSON.stringify(
      {
        groups: visibleGroups,
        lastSync: new Date().toISOString(),
      },
      null,
      2,
    ),
  )
}
