import fs from 'fs'
import path from 'path'

import { MOUNT_ALLOWLIST_PATH } from './config.js'
import { AdditionalMount, AllowedRoot, MountAllowlist } from './types.js'
import { logger } from './logger.js'

let cachedAllowlist: MountAllowlist | null = null
let allowlistLoadError: string | null = null

const DEFAULT_BLOCKED_PATTERNS = [
  '.ssh',
  '.gnupg',
  '.gpg',
  '.aws',
  '.azure',
  '.gcloud',
  '.kube',
  '.docker',
  'credentials',
  '.env',
  '.netrc',
  '.npmrc',
  '.pypirc',
  'id_rsa',
  'id_ed25519',
  'private_key',
  '.secret',
]

export function loadMountAllowlist(): MountAllowlist | null {
  if (cachedAllowlist !== null) return cachedAllowlist
  if (allowlistLoadError !== null) return null

  try {
    if (!fs.existsSync(MOUNT_ALLOWLIST_PATH)) {
      allowlistLoadError = `Mount allowlist not found at ${MOUNT_ALLOWLIST_PATH}`
      logger.warn(
        { path: MOUNT_ALLOWLIST_PATH },
        'Mount allowlist not found - additional mounts will be blocked',
      )
      return null
    }

    const content = fs.readFileSync(MOUNT_ALLOWLIST_PATH, 'utf-8')
    const allowlist = JSON.parse(content) as MountAllowlist

    if (!Array.isArray(allowlist.allowedRoots)) {
      throw new Error('allowedRoots must be an array')
    }

    if (!Array.isArray(allowlist.blockedPatterns)) {
      throw new Error('blockedPatterns must be an array')
    }

    if (typeof allowlist.nonMainReadOnly !== 'boolean') {
      throw new Error('nonMainReadOnly must be a boolean')
    }

    allowlist.blockedPatterns = [
      ...new Set([...DEFAULT_BLOCKED_PATTERNS, ...allowlist.blockedPatterns]),
    ]

    cachedAllowlist = allowlist
    logger.info(
      {
        path: MOUNT_ALLOWLIST_PATH,
        allowedRoots: allowlist.allowedRoots.length,
        blockedPatterns: allowlist.blockedPatterns.length,
      },
      'Mount allowlist loaded',
    )
    return cachedAllowlist
  } catch (err) {
    allowlistLoadError = err instanceof Error ? err.message : String(err)
    logger.error(
      { path: MOUNT_ALLOWLIST_PATH, error: allowlistLoadError },
      'Failed to load mount allowlist - additional mounts blocked',
    )
    return null
  }
}

function expandPath(p: string): string {
  const homeDir = process.env.HOME || '/Users/user'
  if (p.startsWith('~/')) return path.join(homeDir, p.slice(2))
  if (p === '~') return homeDir
  return path.resolve(p)
}

function getRealPath(p: string): string | null {
  try {
    return fs.realpathSync(p)
  } catch {
    return null
  }
}

function matchesBlockedPattern(
  realPath: string,
  blockedPatterns: string[],
): string | null {
  const pathParts = realPath.split(path.sep)

  for (const pattern of blockedPatterns) {
    for (const part of pathParts) {
      if (part === pattern || part.includes(pattern)) return pattern
    }

    if (realPath.includes(pattern)) return pattern
  }

  return null
}

function findAllowedRoot(
  realPath: string,
  allowedRoots: AllowedRoot[],
): AllowedRoot | null {
  for (const root of allowedRoots) {
    const expandedRoot = expandPath(root.path)
    const realRoot = getRealPath(expandedRoot)
    if (!realRoot) continue

    const relative = path.relative(realRoot, realPath)
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
      return root
    }
  }

  return null
}

function isValidContainerPath(containerPath: string): boolean {
  if (containerPath.includes('..')) return false
  if (containerPath.startsWith('/')) return false
  if (!containerPath || containerPath.trim() === '') return false
  return true
}

export interface MountValidationResult {
  allowed: boolean
  reason: string
  realHostPath?: string
  effectiveReadonly?: boolean
}

export function validateMount(
  mount: AdditionalMount,
  isMain: boolean,
): MountValidationResult {
  const allowlist = loadMountAllowlist()
  if (allowlist === null) {
    return {
      allowed: false,
      reason: `No mount allowlist configured at ${MOUNT_ALLOWLIST_PATH}`,
    }
  }

  if (!isValidContainerPath(mount.containerPath)) {
    return {
      allowed: false,
      reason:
        `Invalid container path: "${mount.containerPath}" - must be relative, non-empty, and not contain ".."`,
    }
  }

  const expandedPath = expandPath(mount.hostPath)
  const realPath = getRealPath(expandedPath)

  if (realPath === null) {
    return {
      allowed: false,
      reason:
        `Host path does not exist: "${mount.hostPath}" (expanded: "${expandedPath}")`,
    }
  }

  const blockedMatch = matchesBlockedPattern(
    realPath,
    allowlist.blockedPatterns,
  )
  if (blockedMatch !== null) {
    return {
      allowed: false,
      reason: `Path matches blocked pattern "${blockedMatch}": "${realPath}"`,
    }
  }

  const allowedRoot = findAllowedRoot(realPath, allowlist.allowedRoots)
  if (allowedRoot === null) {
    return {
      allowed: false,
      reason:
        `Path "${realPath}" is not under any allowed root. Allowed roots: ${allowlist.allowedRoots
          .map((r) => expandPath(r.path))
          .join(', ')}`,
    }
  }

  const requestedReadWrite = mount.readonly === false
  let effectiveReadonly = true

  if (requestedReadWrite) {
    if (!isMain && allowlist.nonMainReadOnly) {
      effectiveReadonly = true
      logger.info(
        { mount: mount.hostPath },
        'Mount forced to read-only for non-main group',
      )
    } else if (!allowedRoot.allowReadWrite) {
      effectiveReadonly = true
      logger.info(
        { mount: mount.hostPath, root: allowedRoot.path },
        'Mount forced to read-only - root does not allow read-write',
      )
    } else {
      effectiveReadonly = false
    }
  }

  return {
    allowed: true,
    reason: `Allowed under root "${allowedRoot.path}"${allowedRoot.description ? ` (${allowedRoot.description})` : ''
      }`,
    realHostPath: realPath,
    effectiveReadonly,
  }
}

export function validateAdditionalMounts(
  mounts: AdditionalMount[],
  groupName: string,
  isMain: boolean,
): Array<{
  hostPath: string
  containerPath: string
  readonly: boolean
}> {
  const validatedMounts: Array<{
    hostPath: string
    containerPath: string
    readonly: boolean
  }> = []

  for (const mount of mounts) {
    const result = validateMount(mount, isMain)

    if (result.allowed) {
      validatedMounts.push({
        hostPath: result.realHostPath!,
        containerPath: `/workspace/extra/${mount.containerPath}`,
        readonly: result.effectiveReadonly!,
      })

      logger.debug(
        {
          group: groupName,
          hostPath: result.realHostPath,
          containerPath: mount.containerPath,
          readonly: result.effectiveReadonly,
          reason: result.reason,
        },
        'Mount validated',
      )
    } else {
      logger.warn(
        {
          group: groupName,
          requestedPath: mount.hostPath,
          containerPath: mount.containerPath,
          reason: result.reason,
        },
        'Additional mount rejected',
      )
    }
  }

  return validatedMounts
}
