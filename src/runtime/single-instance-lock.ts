import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'

export type LockLogger = (msg: string, level?: 'debug' | 'info' | 'warn' | 'error') => void

interface LockFileJson {
  pid: number
  startedAt: string
  marker?: string
  cwd?: string
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function ensureDirForFile(filePath: string) {
  const dir = dirname(filePath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

function tryReadLock(lockPath: string): LockFileJson | null {
  if (!existsSync(lockPath)) return null
  try {
    const raw = readFileSync(lockPath, 'utf-8')
    const parsed = JSON.parse(raw) as LockFileJson
    if (!parsed || typeof parsed !== 'object') return null
    if (typeof parsed.pid !== 'number') return null
    if (typeof parsed.startedAt !== 'string') return null
    return {
      pid: parsed.pid,
      startedAt: parsed.startedAt,
      marker: typeof parsed.marker === 'string' && parsed.marker ? parsed.marker : undefined,
      cwd: typeof parsed.cwd === 'string' && parsed.cwd ? parsed.cwd : undefined,
    }
  } catch {
    return null
  }
}

function getProcessArgs(pid: number): string | null {
  try {
    if (process.platform !== 'darwin' && process.platform !== 'linux') return null
    const { execSync } = require('node:child_process') as typeof import('node:child_process')
    return execSync(`ps -p ${pid} -o args=`).toString().trim()
  } catch {
    return null
  }
}

function isSameAmiyaProcess(existing: LockFileJson): boolean {
  if (!isPidAlive(existing.pid)) return false
  const currentMarker = typeof process.argv[1] === 'string' ? process.argv[1] : undefined
  if (existing.marker && currentMarker && existing.marker === currentMarker) return true
  const existingArgs = getProcessArgs(existing.pid)
  if (!existingArgs) return false
  return currentMarker ? existingArgs.includes(currentMarker) : false
}

export function acquireSingleInstanceLock(lockPath: string, logger?: LockLogger): { release: () => void } {
  const log = (msg: string, level: 'debug' | 'info' | 'warn' | 'error' = 'info') => {
    if (logger) logger(msg, level)
  }

  ensureDirForFile(lockPath)

  const existing = tryReadLock(lockPath)
  if (existing && isSameAmiyaProcess(existing)) {
    throw new Error(`Lock already held by pid ${existing.pid}`)
  }

  const marker = typeof process.argv[1] === 'string' ? process.argv[1] : undefined
  const payload: LockFileJson = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    marker,
    cwd: process.cwd(),
  }

  writeFileSync(lockPath, JSON.stringify(payload))
  log(`Acquired lock: ${lockPath}`, 'info')

  return {
    release: () => {
      try {
        unlinkSync(lockPath)
        log(`Released lock: ${lockPath}`, 'info')
      } catch {
        // ignore
      }
    },
  }
}
