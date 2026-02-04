import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'

import {
  ASSISTANT_NAME,
  FEISHU_APP_ID,
  FEISHU_APP_SECRET,
  FEISHU_MAIN_CHAT_ID,
  FEISHU_MAIN_CHAT_NAME,
  FEISHU_USE_LARK,
  DATA_DIR,
  GROUPS_DIR,
  IPC_POLL_INTERVAL,
  MAIN_GROUP_FOLDER,
  POLL_INTERVAL,
  TIMEZONE,
  TRIGGER_PATTERN,
  CONTAINER_RUNTIME,
} from './config.js'
import {
  AvailableGroup,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js'
import {
  createTask,
  deleteTask,
  getAllChats,
  getAllTasks,
  getLastGroupSync,
  getRegisteredGroupCount,
  getRegisteredGroups,
  getMessagesSince,
  getNewMessages,
  getTaskById,
  initDatabase,
  setLastGroupSync,
  storeChatMetadata,
  storeMessage,
  upsertRegisteredGroup,
  updateTask,
} from './db.js'
import { createFeishuClient } from './feishu.js'
import { logger } from './logger.js'
import { startSchedulerLoop } from './task-scheduler.js'
import { NewMessage, RegisteredGroup, Session } from './types.js'
import { loadJson, saveJson } from './utils.js'

const GROUP_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000

let lastTimestamp = ''
let sessions: Session = {}
let registeredGroups: Record<string, RegisteredGroup> = {}
let lastAgentTimestamp: Record<string, string> = {}

type CommandResult = {
  handled: boolean
  response?: string
}

function sanitizeGroupFolder(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || `group-${Date.now()}`
}

function normalizeCommandContent(content: string): string {
  return content
    .replace(/<at[^>]*>([^<]+)<\/at>/gi, '@$1')
    .replace(/\s+/g, ' ')
    .trim()
}

function parseMainCommand(content: string): { name: string; args: string[] } | null {
  const normalized = normalizeCommandContent(content)
  if (!normalized) return null

  const tokens = normalized.split(' ')
  const commandIndex = tokens.findIndex((token) => token.startsWith('/'))
  if (commandIndex === -1) return null

  const commandToken = tokens[commandIndex]
  const name = commandToken.slice(1).toLowerCase()
  if (!name) return null

  if (commandIndex !== 0) {
    const prevToken = tokens[commandIndex - 1]
    if (!prevToken || !prevToken.startsWith('@')) return null
  }

  const args = tokens.slice(commandIndex + 1)
  return { name, args }
}

async function handleMainCommand(
  content: string,
  chatId: string,
  isMainGroup: boolean,
): Promise<CommandResult> {
  const parsed = parseMainCommand(content)
  if (!parsed) return { handled: false }

  if (!isMainGroup) {
    return {
      handled: true,
      response: '仅主控群支持该命令。',
    }
  }

  if (parsed.name === 'help' || parsed.name === 'commands') {
    return {
      handled: true,
      response: [
        '可用命令：',
        `- @${ASSISTANT_NAME} /register <chat_id> [name]`,
        `- @${ASSISTANT_NAME} /list_groups`,
        `- @${ASSISTANT_NAME} /commands`,
      ].join('\n'),
    }
  }

  if (parsed.name === 'list_groups') {
    const groups = Object.entries(registeredGroups)
    if (groups.length === 0) {
      return {
        handled: true,
        response: '暂无已注册的群。',
      }
    }

    const lines = groups.map(([jid, group]) => {
      return `${group.name} | ${jid} | ${group.folder}`
    })

    return {
      handled: true,
      response: ['已注册群：', ...lines].join('\n'),
    }
  }

  if (parsed.name === 'register') {
    const [targetChatId, ...nameParts] = parsed.args
    if (!targetChatId) {
      return {
        handled: true,
        response: `用法：@${ASSISTANT_NAME} /register <chat_id> [name]`,
      }
    }

    if (nameParts.length === 0) {
      return {
        handled: true,
        response: `请提供群名称。用法：@${ASSISTANT_NAME} /register <chat_id> <name>`,
      }
    }

    if (registeredGroups[targetChatId]) {
      return {
        handled: true,
        response: `该 chat 已注册：${registeredGroups[targetChatId].name}`,
      }
    }

    const name = nameParts.join(' ').trim()
    if (!name) {
      return {
        handled: true,
        response: `请提供群名称。用法：@${ASSISTANT_NAME} /register <chat_id> <name>`,
      }
    }
    const folder = sanitizeGroupFolder(name)
    registerGroup(targetChatId, {
      name,
      folder,
      trigger: `@${ASSISTANT_NAME}`,
      added_at: new Date().toISOString(),
    })

    return {
      handled: true,
      response: [
        `已注册：${name}`,
        `chat_id: ${targetChatId}`,
        `folder: ${folder}`,
      ].join('\n'),
    }
  }

  return {
    handled: true,
    response: `未知命令：${parsed.name}（用 /commands 查看）`,
  }
}

function loadState(): void {
  const statePath = path.join(DATA_DIR, 'router_state.json')
  const state = loadJson<{
    last_timestamp?: string
    last_agent_timestamp?: Record<string, string>
  }>(statePath, {})
  lastTimestamp = state.last_timestamp || ''
  lastAgentTimestamp = state.last_agent_timestamp || {}
  sessions = loadJson(path.join(DATA_DIR, 'sessions.json'), {})
  registeredGroups = getRegisteredGroups()
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  )
}

function saveState(): void {
  saveJson(path.join(DATA_DIR, 'router_state.json'), {
    last_timestamp: lastTimestamp,
    last_agent_timestamp: lastAgentTimestamp,
  })
  saveJson(path.join(DATA_DIR, 'sessions.json'), sessions)
}

function registerGroup(chatId: string, group: RegisteredGroup): void {
  registeredGroups[chatId] = group
  upsertRegisteredGroup(chatId, group)

  const groupDir = path.join(GROUPS_DIR, group.folder)
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true })

  logger.info(
    { chatId, name: group.name, folder: group.folder },
    'Group registered',
  )
}

function ensureMainGroupRegistered(): void {
  if (!FEISHU_MAIN_CHAT_ID) {
    logger.error('FEISHU_MAIN_CHAT_ID is required to register the main group')
    process.exit(1)
  }

  if (!registeredGroups[FEISHU_MAIN_CHAT_ID]) {
    registerGroup(FEISHU_MAIN_CHAT_ID, {
      name: FEISHU_MAIN_CHAT_NAME,
      folder: MAIN_GROUP_FOLDER,
      trigger: `@${ASSISTANT_NAME}`,
      added_at: new Date().toISOString(),
    })
  }
}

async function syncGroupMetadata(force = false): Promise<void> {
  if (!force) {
    const lastSync = getLastGroupSync()
    if (lastSync) {
      const lastSyncTime = new Date(lastSync).getTime()
      if (Date.now() - lastSyncTime < GROUP_SYNC_INTERVAL_MS) return
    }
  }

  setLastGroupSync()
  logger.info('Group metadata sync skipped for Feishu')
}

function getAvailableGroups(): AvailableGroup[] {
  const chats = getAllChats()
  const registeredJids = new Set(Object.keys(registeredGroups))

  return chats
    .filter((c) => c.jid !== '__group_sync__')
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }))
}

async function processMessage(msg: NewMessage): Promise<void> {
  const group = registeredGroups[msg.chat_jid]
  if (!group) return

  const content = msg.content.trim()
  logger.info(
    { chatId: msg.chat_jid, content: msg.content },
    'Incoming message content',
  )
  const isMainGroup = group.folder === MAIN_GROUP_FOLDER

  const commandResult = await handleMainCommand(content, msg.chat_jid, isMainGroup)
  if (commandResult.handled) {
    if (commandResult.response) {
      await sendMessage(msg.chat_jid, commandResult.response)
    }
    return
  }

  if (!isMainGroup) {
    // Non-main groups are filtered at ingestion based on bot mentions.
  }

  const sinceTimestamp = lastAgentTimestamp[msg.chat_jid] || ''
  const missedMessages = getMessagesSince(
    msg.chat_jid,
    sinceTimestamp,
    ASSISTANT_NAME,
  )

  const lines = missedMessages.map((m) => {
    const escapeXml = (s: string) =>
      s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
    return `<message sender="${escapeXml(m.sender_name)}" time="${m.timestamp}">${escapeXml(m.content)}</message>`
  })
  const prompt = `<messages>\n${lines.join('\n')}\n</messages>`

  if (!prompt) return

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing message',
  )

  const response = await runAgent(group, prompt, msg.chat_jid)

  if (response.result) {
    lastAgentTimestamp[msg.chat_jid] = msg.timestamp
    await sendMessage(msg.chat_jid, response.result)
  } else if (response.error) {
    await sendMessage(msg.chat_jid, `请求失败：${response.error}`)
  }
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatId: string,
): Promise<{ result: string | null; error?: string }> {
  const isMain = group.folder === MAIN_GROUP_FOLDER
  const sessionId = sessions[group.folder]

  const tasks = getAllTasks()
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  )

  const availableGroups = getAvailableGroups()
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  )

  try {
    const output = await runContainerAgent(group, {
      prompt,
      sessionId,
      groupFolder: group.folder,
      chatJid: chatId,
      isMain,
    })

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId
      saveJson(path.join(DATA_DIR, 'sessions.json'), sessions)
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      )
      return { result: null, error: output.error || 'Container error' }
    }

    return { result: output.result }
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error')
    return {
      result: null,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

let feishuClient: ReturnType<typeof createFeishuClient> | null = null

async function sendMessage(chatId: string, text: string): Promise<void> {
  if (!feishuClient) return
  try {
    await feishuClient.sendMessage(chatId, text)
    logger.info({ chatId, length: text.length }, 'Message sent')
  } catch (err) {
    logger.error({ chatId, err }, 'Failed to send message')
  }
}

function startIpcWatcher(): void {
  const processIpcFiles = async () => {
    let groupFolders: string[]
    try {
      groupFolders = fs.readdirSync(GROUPS_DIR).filter((f) => {
        const stat = fs.statSync(path.join(GROUPS_DIR, f))
        return stat.isDirectory() && f !== 'global'
      })
    } catch (err) {
      logger.error({ err }, 'Error reading groups directory for IPC')
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL)
      return
    }

    for (const sourceGroup of groupFolders) {
      const isMain = sourceGroup === MAIN_GROUP_FOLDER
      const ipcDir = path.join(GROUPS_DIR, sourceGroup, 'ipc')
      const messagesDir = path.join(ipcDir, 'messages')
      const tasksDir = path.join(ipcDir, 'tasks')

      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'))
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file)
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
              if (data.type === 'message' && data.chatJid && data.text) {
                const targetGroup = registeredGroups[data.chatJid]
                if (
                  isMain
                  || (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  await sendMessage(data.chatJid, data.text)
                  logger.info(
                    { chatId: data.chatJid, sourceGroup },
                    'IPC message sent',
                  )
                } else {
                  logger.warn(
                    { chatId: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  )
                }
              }
              fs.unlinkSync(filePath)
              } catch (err) {
                logger.error(
                  { file, sourceGroup, err },
                  'Error processing IPC message',
                )
                const errorDir = path.join(ipcDir, 'errors')
                fs.mkdirSync(errorDir, { recursive: true })
                fs.renameSync(filePath, path.join(errorDir, `${sourceGroup}-${file}`))
              }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC messages')
      }

      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'))
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file)
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
              await processTaskIpc(data, sourceGroup, isMain)
              fs.unlinkSync(filePath)
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              )
              const errorDir = path.join(ipcDir, 'errors')
              fs.mkdirSync(errorDir, { recursive: true })
              fs.renameSync(filePath, path.join(errorDir, `${sourceGroup}-${file}`))
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks')
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL)
  }

  processIpcFiles()
  logger.info('IPC watcher started (per-group namespaces)')
}

async function processTaskIpc(
  data: {
    type: string
    taskId?: string
    prompt?: string
    schedule_type?: string
    schedule_value?: string
    context_mode?: string
    groupFolder?: string
    target_group?: string
    chatJid?: string
    jid?: string
    name?: string
    folder?: string
    trigger?: string
    containerConfig?: RegisteredGroup['containerConfig']
  },
  sourceGroup: string,
  isMain: boolean,
): Promise<void> {
  const cronParserModule = (await import('cron-parser')) as {
    parseExpression?: (expression: string, options?: { tz?: string }) => {
      next: () => { toISOString: () => string }
    }
    default?: {
      parseExpression: (expression: string, options?: { tz?: string }) => {
        next: () => { toISOString: () => string }
      }
    }
  }
  const cronParser =
    typeof cronParserModule.parseExpression === 'function'
      ? cronParserModule
      : cronParserModule.default

  if (!cronParser || typeof cronParser.parseExpression !== 'function') {
    throw new Error('cron-parser module does not expose parseExpression')
  }

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt
        && data.schedule_type
        && data.schedule_value
      ) {
        const targetGroup = data.groupFolder || data.target_group
        if (!targetGroup) {
          logger.warn({ sourceGroup }, 'Missing target group for schedule_task')
          break
        }
        if (!isMain && targetGroup !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetGroup },
            'Unauthorized schedule_task attempt blocked',
          )
          break
        }

        const targetJid = Object.entries(registeredGroups).find(
          ([, group]) => group.folder === targetGroup,
        )?.[0]

        if (!targetJid) {
          logger.warn(
            { targetGroup },
            'Cannot schedule task: target group not registered',
          )
          break
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once'
        let nextRun: string | null = null

        if (scheduleType === 'cron') {
          try {
            const interval = cronParser.parseExpression(data.schedule_value, {
              tz: TIMEZONE,
            })
            nextRun = interval.next().toISOString()
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            )
            break
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10)
          if (Number.isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            )
            break
          }
          nextRun = new Date(Date.now() + ms).toISOString()
        } else if (scheduleType === 'once') {
          const scheduled = new Date(data.schedule_value)
          if (Number.isNaN(scheduled.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            )
            break
          }
          nextRun = scheduled.toISOString()
        }

        const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated'

        createTask({
          id: taskId,
          group_folder: targetGroup,
          chat_jid: targetJid,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        })
        logger.info(
          { taskId, sourceGroup, targetGroup, contextMode },
          'Task created via IPC',
        )
      }
      break

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId)
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' })
          logger.info({ taskId: data.taskId, sourceGroup }, 'Task paused via IPC')
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          )
        }
      }
      break

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId)
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' })
          logger.info({ taskId: data.taskId, sourceGroup }, 'Task resumed via IPC')
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          )
        }
      }
      break

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId)
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId)
          logger.info({ taskId: data.taskId, sourceGroup }, 'Task cancelled via IPC')
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          )
        }
      }
      break

    case 'refresh_groups':
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        )
        await syncGroupMetadata(true)
        const availableGroups = getAvailableGroups()
        writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        )
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        )
      }
      break

    case 'register_group':
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        )
        break
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
        })
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        )
      }
      break

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type')
  }
}

async function startMessageLoop(): Promise<void> {
  logger.info(`Amiya running (trigger: @${ASSISTANT_NAME})`)

  while (true) {
    try {
      const jids = Object.keys(registeredGroups)
      const { messages } = getNewMessages(jids, lastTimestamp, ASSISTANT_NAME)

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages')
      }
      for (const msg of messages) {
        try {
          await processMessage(msg)
          lastTimestamp = msg.timestamp
          saveState()
        } catch (err) {
          logger.error(
            { err, msg: msg.id },
            'Error processing message, will retry',
          )
          break
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop')
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL))
  }
}

function ensureContainerSystemRunning(): void {
  if (CONTAINER_RUNTIME !== 'container') {
    logger.info(
      { runtime: CONTAINER_RUNTIME },
      'Skipping Apple Container system check',
    )
    return
  }
  try {
    execSync('container system status', { stdio: 'pipe' })
    logger.debug('Apple Container system already running')
  } catch {
    logger.info('Starting Apple Container system...')
    try {
      execSync('container system start', { stdio: 'pipe', timeout: 30000 })
      logger.info('Apple Container system started')
    } catch (err) {
      logger.error({ err }, 'Failed to start Apple Container system')
      throw new Error('Apple Container system is required but failed to start')
    }
  }
}

async function connectFeishu(): Promise<void> {
  if (!FEISHU_APP_ID || !FEISHU_APP_SECRET) {
    logger.error('FEISHU_APP_ID and FEISHU_APP_SECRET are required')
    process.exit(1)
  }

  feishuClient = createFeishuClient({
    appId: FEISHU_APP_ID,
    appSecret: FEISHU_APP_SECRET,
    useLark: FEISHU_USE_LARK,
  })

  let cachedBotUserId: string | null = null
  let botUserIdResolved = false
  const resolveBotUserId = async (): Promise<string | null> => {
    if (botUserIdResolved) return cachedBotUserId
    botUserIdResolved = true
    try {
      cachedBotUserId = feishuClient ? await feishuClient.getBotUserId() : null
    } catch {
      cachedBotUserId = null
    }
    if (cachedBotUserId) {
      logger.info({ botUserId: cachedBotUserId }, 'Resolved bot user id')
    }
    return cachedBotUserId
  }

  feishuClient.onMessage(async (message) => {
    const chatId = message.chatId
    storeChatMetadata(chatId, message.timestamp)

    if (registeredGroups[chatId]) {
      const group = registeredGroups[chatId]
      const isMain = group.folder === MAIN_GROUP_FOLDER
      if (!isMain) {
        const botUserId = await resolveBotUserId()
        const mentionedBot = botUserId
          ? message.mentions.includes(botUserId)
          : false
        if (!mentionedBot && !TRIGGER_PATTERN.test(message.text)) {
          logger.info(
            {
              chatId,
              text: message.text,
              mentions: message.mentions,
              botUserId,
            },
            'Ignoring message without bot mention',
          )
          return
        }
      }
      storeMessage({
        id: message.messageId,
        chatJid: chatId,
        sender: message.senderId,
        senderName: message.senderName || message.senderId,
        content: message.text || '',
        timestamp: message.timestamp,
      })
    }
  })

  feishuClient.start()
  logger.info('Connected to Feishu')

  syncGroupMetadata().catch((err) =>
    logger.error({ err }, 'Initial group sync failed'),
  )
  setInterval(() => {
    syncGroupMetadata().catch((err) =>
      logger.error({ err }, 'Periodic group sync failed'),
    )
  }, GROUP_SYNC_INTERVAL_MS)

  startSchedulerLoop({
    sendMessage,
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
  })
  startIpcWatcher()
  startMessageLoop()
}

async function main(): Promise<void> {
  ensureContainerSystemRunning()
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.mkdirSync(GROUPS_DIR, { recursive: true })
  initDatabase()
  logger.info('Database initialized')
  loadState()
  ensureMainGroupRegistered()
  await connectFeishu()
}

main().catch((err) => {
  logger.error({ err }, 'Failed to start Amiya')
  process.exit(1)
})
