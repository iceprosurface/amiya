import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { getDataDir } from './config.js'

let db: Database.Database | null = null

export function getDatabase(): Database.Database {
  if (!db) {
    const dataDir = getDataDir()
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true })
    }

    const dbPath = path.join(dataDir, 'amiya.sqlite3')
    db = new Database(dbPath)

    db.exec(`
      CREATE TABLE IF NOT EXISTS thread_sessions (
        thread_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    db.exec(`
      CREATE TABLE IF NOT EXISTS channel_directories (
        channel_id TEXT PRIMARY KEY,
        directory TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    db.exec(`
      CREATE TABLE IF NOT EXISTS channel_models (
        channel_id TEXT PRIMARY KEY,
        model_id TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    db.exec(`
      CREATE TABLE IF NOT EXISTS session_models (
        session_id TEXT PRIMARY KEY,
        model_id TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    db.exec(`
      CREATE TABLE IF NOT EXISTS channel_agents (
        channel_id TEXT PRIMARY KEY,
        agent_name TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    db.exec(`
      CREATE TABLE IF NOT EXISTS session_agents (
        session_id TEXT PRIMARY KEY,
        agent_name TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    db.exec(`
      CREATE TABLE IF NOT EXISTS channel_users (
        channel_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (channel_id, user_id)
      )
    `)

    db.exec(`
      CREATE TABLE IF NOT EXISTS approval_requests (
        request_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        user_name TEXT,
        card_message_id TEXT,
        admin_chat_id TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    db.exec(`
      CREATE TABLE IF NOT EXISTS thread_settings (
        thread_id TEXT PRIMARY KEY,
        mention_required INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    db.exec(`
      CREATE TABLE IF NOT EXISTS question_requests (
        request_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        directory TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        questions_json TEXT NOT NULL,
        card_message_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    db.exec(`
      CREATE TABLE IF NOT EXISTS processed_commands (
        message_id TEXT PRIMARY KEY,
        command_name TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)
  }

  return db
}

export function getThreadSession(threadId: string): string | undefined {
  const row = getDatabase()
    .prepare('SELECT session_id FROM thread_sessions WHERE thread_id = ?')
    .get(threadId) as { session_id: string } | undefined
  return row?.session_id
}

export function setThreadSession(threadId: string, sessionId: string): void {
  getDatabase()
    .prepare('INSERT OR REPLACE INTO thread_sessions (thread_id, session_id) VALUES (?, ?)')
    .run(threadId, sessionId)
}

export function clearThreadSession(threadId: string): void {
  getDatabase().prepare('DELETE FROM thread_sessions WHERE thread_id = ?').run(threadId)
}

export function listThreadSessions(): Array<{ threadId: string; sessionId: string }> {
  const rows = getDatabase()
    .prepare('SELECT thread_id, session_id FROM thread_sessions ORDER BY created_at DESC')
    .all() as Array<{ thread_id: string; session_id: string }>
  return rows.map((row) => ({ threadId: row.thread_id, sessionId: row.session_id }))
}

export function getThreadMentionRequired(threadId: string): boolean | undefined {
  const row = getDatabase()
    .prepare('SELECT mention_required FROM thread_settings WHERE thread_id = ?')
    .get(threadId) as { mention_required: number } | undefined
  if (!row) return undefined
  return Boolean(row.mention_required)
}

export function setThreadMentionRequired(threadId: string, required: boolean): void {
  getDatabase()
    .prepare(
      `INSERT INTO thread_settings (thread_id, mention_required, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(thread_id) DO UPDATE SET mention_required = excluded.mention_required, updated_at = CURRENT_TIMESTAMP`,
    )
    .run(threadId, required ? 1 : 0)
}

export function getChannelDirectory(channelId: string): string | undefined {
  const row = getDatabase()
    .prepare('SELECT directory FROM channel_directories WHERE channel_id = ?')
    .get(channelId) as { directory: string } | undefined
  return row?.directory
}

export function setChannelDirectory(channelId: string, directory: string): void {
  getDatabase()
    .prepare('INSERT OR REPLACE INTO channel_directories (channel_id, directory) VALUES (?, ?)')
    .run(channelId, directory)
}

export function getChannelModel(channelId: string): string | undefined {
  const row = getDatabase()
    .prepare('SELECT model_id FROM channel_models WHERE channel_id = ?')
    .get(channelId) as { model_id: string } | undefined
  return row?.model_id
}

export function setChannelModel(channelId: string, modelId: string): void {
  getDatabase()
    .prepare(
      `INSERT INTO channel_models (channel_id, model_id, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(channel_id) DO UPDATE SET model_id = ?, updated_at = CURRENT_TIMESTAMP`,
    )
    .run(channelId, modelId, modelId)
}

export function getSessionModel(sessionId: string): string | undefined {
  const row = getDatabase()
    .prepare('SELECT model_id FROM session_models WHERE session_id = ?')
    .get(sessionId) as { model_id: string } | undefined
  return row?.model_id
}

export function setSessionModel(sessionId: string, modelId: string): void {
  getDatabase()
    .prepare('INSERT OR REPLACE INTO session_models (session_id, model_id) VALUES (?, ?)')
    .run(sessionId, modelId)
}

export function clearSessionModel(sessionId: string): void {
  getDatabase().prepare('DELETE FROM session_models WHERE session_id = ?').run(sessionId)
}

export function getChannelAgent(channelId: string): string | undefined {
  const row = getDatabase()
    .prepare('SELECT agent_name FROM channel_agents WHERE channel_id = ?')
    .get(channelId) as { agent_name: string } | undefined
  return row?.agent_name
}

export function setChannelAgent(channelId: string, agentName: string): void {
  getDatabase()
    .prepare(
      `INSERT INTO channel_agents (channel_id, agent_name, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(channel_id) DO UPDATE SET agent_name = ?, updated_at = CURRENT_TIMESTAMP`,
    )
    .run(channelId, agentName, agentName)
}

export function getSessionAgent(sessionId: string): string | undefined {
  const row = getDatabase()
    .prepare('SELECT agent_name FROM session_agents WHERE session_id = ?')
    .get(sessionId) as { agent_name: string } | undefined
  return row?.agent_name
}

export function setSessionAgent(sessionId: string, agentName: string): void {
  getDatabase()
    .prepare('INSERT OR REPLACE INTO session_agents (session_id, agent_name) VALUES (?, ?)')
    .run(sessionId, agentName)
}

export function clearSessionAgent(sessionId: string): void {
  getDatabase().prepare('DELETE FROM session_agents WHERE session_id = ?').run(sessionId)
}

export function isUserInWhitelist(channelId: string, userId: string): boolean {
  const row = getDatabase()
    .prepare('SELECT 1 FROM channel_users WHERE channel_id = ? AND user_id = ?')
    .get(channelId, userId) as { '1': number } | undefined
  return !!row
}

export function addUserToWhitelist(channelId: string, userId: string): void {
  getDatabase()
    .prepare('INSERT OR REPLACE INTO channel_users (channel_id, user_id) VALUES (?, ?)')
    .run(channelId, userId)
}

export function removeUserFromWhitelist(channelId: string, userId: string): void {
  getDatabase()
    .prepare('DELETE FROM channel_users WHERE channel_id = ? AND user_id = ?')
    .run(channelId, userId)
}

export function listChannelUsers(channelId: string): string[] {
  const rows = getDatabase()
    .prepare('SELECT user_id FROM channel_users WHERE channel_id = ?')
    .all(channelId) as Array<{ user_id: string }>
  return rows.map((row) => row.user_id)
}

export type StoredQuestion = {
  question: string
  header: string
  options: Array<{ label: string; description?: string }>
  multiple?: boolean
}

export function upsertQuestionRequest(params: {
  requestId: string
  sessionId: string
  directory: string
  threadId: string
  questions: StoredQuestion[]
  cardMessageId?: string
}): void {
  const questionsJson = JSON.stringify(params.questions)
  getDatabase()
    .prepare(
      `INSERT INTO question_requests (request_id, session_id, directory, thread_id, questions_json, card_message_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(request_id) DO UPDATE SET
         session_id = excluded.session_id,
         directory = excluded.directory,
         thread_id = excluded.thread_id,
         questions_json = excluded.questions_json,
         card_message_id = COALESCE(excluded.card_message_id, question_requests.card_message_id),
         updated_at = CURRENT_TIMESTAMP`,
    )
    .run(
      params.requestId,
      params.sessionId,
      params.directory,
      params.threadId,
      questionsJson,
      params.cardMessageId || null,
    )
}

export function updateQuestionRequestCard(requestId: string, cardMessageId: string): void {
  getDatabase()
    .prepare(
      `UPDATE question_requests SET card_message_id = ?, updated_at = CURRENT_TIMESTAMP WHERE request_id = ?`,
    )
    .run(cardMessageId, requestId)
}

export function isCommandProcessed(messageId: string, commandName?: string): boolean {
  const row = getDatabase()
    .prepare('SELECT command_name FROM processed_commands WHERE message_id = ?')
    .get(messageId) as { command_name: string } | undefined
  if (!row) return false
  if (!commandName) return true
  return row.command_name === commandName
}

export function markCommandProcessed(messageId: string, commandName: string): void {
  getDatabase()
    .prepare(
      'INSERT OR IGNORE INTO processed_commands (message_id, command_name) VALUES (?, ?)',
    )
    .run(messageId, commandName)
}

export function getQuestionRequest(requestId: string): {
  requestId: string
  sessionId: string
  directory: string
  threadId: string
  questions: StoredQuestion[]
  cardMessageId?: string
} | undefined {
  const row = getDatabase()
    .prepare('SELECT * FROM question_requests WHERE request_id = ?')
    .get(requestId) as {
    request_id: string
    session_id: string
    directory: string
    thread_id: string
    questions_json: string
    card_message_id?: string | null
  } | undefined
  if (!row) return undefined
  try {
    const questions = JSON.parse(row.questions_json) as StoredQuestion[]
    if (!Array.isArray(questions)) return undefined
    return {
      requestId: row.request_id,
      sessionId: row.session_id,
      directory: row.directory,
      threadId: row.thread_id,
      questions,
      cardMessageId: row.card_message_id || undefined,
    }
  } catch {
    return undefined
  }
}

export function deleteQuestionRequest(requestId: string): void {
  getDatabase().prepare('DELETE FROM question_requests WHERE request_id = ?').run(requestId)
}

export function createApprovalRequest(params: {
  requestId: string
  channelId: string
  userId: string
  userName?: string
  cardMessageId: string
  adminChatId: string
}): void {
  getDatabase()
    .prepare(
      `INSERT INTO approval_requests (request_id, channel_id, user_id, user_name, card_message_id, admin_chat_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(params.requestId, params.channelId, params.userId, params.userName || '', params.cardMessageId, params.adminChatId)
}

export function getApprovalRequest(requestId: string): {
  request_id: string
  channel_id: string
  user_id: string
  user_name: string
  card_message_id: string
  admin_chat_id: string
  status: string
  created_at: string
} | undefined {
  const row = getDatabase()
    .prepare('SELECT * FROM approval_requests WHERE request_id = ?')
    .get(requestId) as {
      request_id: string
      channel_id: string
      user_id: string
      user_name: string
      card_message_id: string
      admin_chat_id: string
      status: string
      created_at: string
    } | undefined
  return row
}

export function approveRequest(requestId: string, approvedBy: string): void {
  const request = getApprovalRequest(requestId)
  if (!request) return

  getDatabase()
    .prepare('UPDATE approval_requests SET status = ? WHERE request_id = ?')
    .run(`approved_by_${approvedBy}`, requestId)

  addUserToWhitelist(request.channel_id, request.user_id)
}

export function rejectRequest(requestId: string, rejectedBy: string): void {
  getDatabase()
    .prepare('UPDATE approval_requests SET status = ? WHERE request_id = ?')
    .run(`rejected_by_${rejectedBy}`, requestId)
}

export function listPendingApprovals(): Array<{
  request_id: string
  channel_id: string
  user_id: string
  user_name: string
  created_at: string
}> {
  const rows = getDatabase()
    .prepare('SELECT request_id, channel_id, user_id, user_name, created_at FROM approval_requests WHERE status = ?')
    .all('pending') as Array<{
      request_id: string
      channel_id: string
      user_id: string
      user_name: string
      created_at: string
    }>
  return rows
}
