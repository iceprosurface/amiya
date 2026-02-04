import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'

import { STORE_DIR } from './config.js'
import { NewMessage, RegisteredGroup, ScheduledTask, TaskRunLog } from './types.js'

let db: Database.Database

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db')
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })

  db = new Database(dbPath)
  db.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL,
      context_mode TEXT DEFAULT 'isolated'
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS registered_groups (
      chat_jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL,
      trigger TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT
    );
  `)
}

export function getRegisteredGroupCount(): number {
  const row = db
    .prepare('SELECT COUNT(*) as count FROM registered_groups')
    .get() as { count: number } | undefined
  return row?.count ?? 0
}

export function upsertRegisteredGroup(
  chatJid: string,
  group: RegisteredGroup,
): void {
  const containerConfig = group.containerConfig
    ? JSON.stringify(group.containerConfig)
    : null
  db.prepare(
    `
    INSERT INTO registered_groups (chat_jid, name, folder, trigger, added_at, container_config)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(chat_jid) DO UPDATE SET
      name = excluded.name,
      folder = excluded.folder,
      trigger = excluded.trigger,
      added_at = excluded.added_at,
      container_config = excluded.container_config
  `,
  ).run(
    chatJid,
    group.name,
    group.folder,
    group.trigger,
    group.added_at,
    containerConfig,
  )
}

export function getRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = db
    .prepare(
      `
    SELECT chat_jid, name, folder, trigger, added_at, container_config
    FROM registered_groups
  `,
    )
    .all() as Array<{
      chat_jid: string
      name: string
      folder: string
      trigger: string
      added_at: string
      container_config: string | null
    }>

  const groups: Record<string, RegisteredGroup> = {}
  for (const row of rows) {
    let containerConfig: RegisteredGroup['containerConfig'] | undefined
    if (row.container_config) {
      try {
        containerConfig = JSON.parse(row.container_config)
      } catch {
        containerConfig = undefined
      }
    }
    groups[row.chat_jid] = {
      name: row.name,
      folder: row.folder,
      trigger: row.trigger,
      added_at: row.added_at,
      containerConfig,
    }
  }
  return groups
}

export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
): void {
  if (name) {
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time)
    `,
    ).run(chatJid, name, timestamp)
  } else {
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time)
    `,
    ).run(chatJid, chatJid, timestamp)
  }
}

export function updateChatName(chatJid: string, name: string): void {
  db.prepare(
    `
    INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name
  `,
  ).run(chatJid, name, new Date().toISOString())
}

export interface ChatInfo {
  jid: string
  name: string
  last_message_time: string
}

export function getAllChats(): ChatInfo[] {
  return db
    .prepare(
      `
    SELECT jid, name, last_message_time
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[]
}

export function getLastGroupSync(): string | null {
  const row = db
    .prepare('SELECT last_message_time FROM chats WHERE jid = ?')
    .get('__group_sync__') as { last_message_time: string } | undefined
  return row?.last_message_time || null
}

export function setLastGroupSync(): void {
  const now = new Date().toISOString()
  db.prepare(
    'INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)',
  ).run('__group_sync__', '__group_sync__', now)
}

export function storeMessage(message: {
  id: string
  chatJid: string
  sender: string
  senderName: string
  content: string
  timestamp: string
  isFromMe?: boolean
}): void {
  db.prepare(
    'INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    message.id,
    message.chatJid,
    message.sender,
    message.senderName,
    message.content,
    message.timestamp,
    message.isFromMe ? 1 : 0,
  )
}

export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp }

  const placeholders = jids.map(() => '?').join(',')
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp
    FROM messages
    WHERE timestamp > ? AND chat_jid IN (${placeholders}) AND content NOT LIKE ?
    ORDER BY timestamp
  `

  const rows = db
    .prepare(sql)
    .all(lastTimestamp, ...jids, `${botPrefix}:%`) as NewMessage[]

  let newTimestamp = lastTimestamp
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp
  }

  return { messages: rows, newTimestamp }
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
): NewMessage[] {
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp
    FROM messages
    WHERE chat_jid = ? AND timestamp > ? AND content NOT LIKE ?
    ORDER BY timestamp
  `
  return db
    .prepare(sql)
    .all(chatJid, sinceTimestamp, `${botPrefix}:%`) as NewMessage[]
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  db.prepare(
    `
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    task.next_run,
    task.status,
    task.created_at,
  )
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
    | ScheduledTask
    | undefined
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return db
    .prepare(
      'SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(groupFolder) as ScheduledTask[]
}

export function getAllTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[]
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      'prompt' | 'schedule_type' | 'schedule_value' | 'next_run' | 'status'
    >
  >,
): void {
  const fields: string[] = []
  const values: unknown[] = []

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?')
    values.push(updates.prompt)
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?')
    values.push(updates.schedule_type)
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?')
    values.push(updates.schedule_value)
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?')
    values.push(updates.next_run)
  }
  if (updates.status !== undefined) {
    fields.push('status = ?')
    values.push(updates.status)
  }

  if (fields.length === 0) return

  values.push(id)
  db.prepare(`UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`).run(
    ...values,
  )
}

export function deleteTask(id: string): void {
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id)
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id)
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString()
  return db
    .prepare(
      `
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `,
    )
    .all(now) as ScheduledTask[]
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString()
  db.prepare(
    `
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
  ).run(nextRun, now, lastResult, nextRun, id)
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(
    `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    log.task_id,
    log.run_at,
    log.duration_ms,
    log.status,
    log.result,
    log.error,
  )
}

export function getTaskRunLogs(taskId: string, limit = 10): TaskRunLog[] {
  return db
    .prepare(
      `
    SELECT task_id, run_at, duration_ms, status, result, error
    FROM task_run_logs
    WHERE task_id = ?
    ORDER BY run_at DESC
    LIMIT ?
  `,
    )
    .all(taskId, limit) as TaskRunLog[]
}
