import path from 'path'

import { loadJson } from './utils.js'

interface AmiyaConfig {
  runtimeDir?: string
  assistantName?: string
  pollInterval?: number
  schedulerPollInterval?: number
  ipcPollInterval?: number
  containerRuntime?: string
  containerImage?: string
  containerTimeout?: number
  containerMaxOutputSize?: number
  feishuAppId?: string
  feishuAppSecret?: string
  feishuUseLark?: boolean
  feishuAllowedChatIds?: string[]
  feishuMainChatId?: string
  feishuMainChatName?: string
  timezone?: string
}

const CONFIG_PATH = path.join(process.cwd(), '.amiya', 'config.json')
const fileConfig = loadJson<AmiyaConfig>(CONFIG_PATH, {})

function toInt(value: string | number | undefined, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

function toBool(value: string | boolean | undefined, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    return value === '1' || value.toLowerCase() === 'true'
  }
  return fallback
}

function toStringList(
  value: string | string[] | undefined,
): string[] {
  if (Array.isArray(value)) return value
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
  }
  return []
}

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || fileConfig.assistantName || 'Andy'
export const POLL_INTERVAL = toInt(
  process.env.POLL_INTERVAL || fileConfig.pollInterval,
  2000,
)
export const SCHEDULER_POLL_INTERVAL = toInt(
  process.env.SCHEDULER_POLL_INTERVAL || fileConfig.schedulerPollInterval,
  60000,
)
export const IPC_POLL_INTERVAL = toInt(
  process.env.IPC_POLL_INTERVAL || fileConfig.ipcPollInterval,
  1000,
)

const PROJECT_ROOT = process.cwd()
const HOME_DIR = process.env.HOME || '/Users/user'
const RUNTIME_DIR =
  process.env.RUNTIME_DIR
  || fileConfig.runtimeDir
  || path.join(PROJECT_ROOT, '.amiya', 'runtime')

export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'amiya',
  'mount-allowlist.json',
)
export const STORE_DIR = path.resolve(RUNTIME_DIR, 'store')
export const GROUPS_DIR = path.resolve(RUNTIME_DIR, 'groups')
export const DATA_DIR = path.resolve(RUNTIME_DIR, 'data')
export const MAIN_GROUP_FOLDER = 'main'

export const CONTAINER_RUNTIME =
  process.env.CONTAINER_RUNTIME || fileConfig.containerRuntime || 'container'
export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE
  || fileConfig.containerImage
  || 'opencode-agent:latest'
export const CONTAINER_TIMEOUT = toInt(
  process.env.CONTAINER_TIMEOUT || fileConfig.containerTimeout,
  30000,
)
export const CONTAINER_MAX_OUTPUT_SIZE = toInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || fileConfig.containerMaxOutputSize,
  10485760,
)

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
)

export const TIMEZONE =
  process.env.TZ
  || fileConfig.timezone
  || Intl.DateTimeFormat().resolvedOptions().timeZone

export const FEISHU_APP_ID =
  process.env.FEISHU_APP_ID || fileConfig.feishuAppId || ''
export const FEISHU_APP_SECRET =
  process.env.FEISHU_APP_SECRET || fileConfig.feishuAppSecret || ''
export const FEISHU_USE_LARK = toBool(
  process.env.FEISHU_USE_LARK || fileConfig.feishuUseLark,
  false,
)

export const FEISHU_MAIN_CHAT_ID =
  process.env.FEISHU_MAIN_CHAT_ID || fileConfig.feishuMainChatId || ''
export const FEISHU_MAIN_CHAT_NAME =
  process.env.FEISHU_MAIN_CHAT_NAME || fileConfig.feishuMainChatName || 'Main'
