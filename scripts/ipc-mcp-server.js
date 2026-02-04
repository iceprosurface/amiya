#!/usr/bin/env node

'use strict'

const fs = require('fs')
const path = require('path')

const IPC_DIR = process.env.AMIYA_IPC_DIR || '/workspace/ipc'
const MESSAGES_DIR = path.join(IPC_DIR, 'messages')
const TASKS_DIR = path.join(IPC_DIR, 'tasks')
const CONTEXT_PATH = path.join(IPC_DIR, 'context.json')

const SERVER_NAME = 'amiya-ipc'
const SERVER_VERSION = '1.0.0'

function readContext() {
  try {
    const raw = fs.readFileSync(CONTEXT_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    return {
      chatJid: parsed.chatJid || '',
      groupFolder: parsed.groupFolder || '',
      isMain: Boolean(parsed.isMain),
    }
  } catch {
    return { chatJid: '', groupFolder: '', isMain: false }
  }
}

function writeIpcFile(dir, data) {
  fs.mkdirSync(dir, { recursive: true })
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`
  const filepath = path.join(dir, filename)
  const tempPath = `${filepath}.tmp`
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2))
  fs.renameSync(tempPath, filepath)
  return filename
}

function sendMessage(message) {
  const payload = JSON.stringify(message)
  const header = `Content-Length: ${Buffer.byteLength(payload, 'utf8')}\r\n\r\n`
  process.stdout.write(header + payload)
}

function sendResponse(id, result) {
  sendMessage({ jsonrpc: '2.0', id, result })
}

function sendError(id, code, message) {
  sendMessage({ jsonrpc: '2.0', id, error: { code, message } })
}

function toolsList() {
  return {
    tools: [
      {
        name: 'send_message',
        description: 'Send a message to the current chat.',
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'Message text.' },
          },
          required: ['text'],
          additionalProperties: false,
        },
      },
      {
        name: 'schedule_task',
        description: 'Schedule a recurring or one-time task.',
        inputSchema: {
          type: 'object',
          properties: {
            prompt: { type: 'string' },
            schedule_type: { type: 'string', enum: ['cron', 'interval', 'once'] },
            schedule_value: { type: 'string' },
            context_mode: { type: 'string', enum: ['group', 'isolated'] },
            target_group: { type: 'string' },
          },
          required: ['prompt', 'schedule_type', 'schedule_value'],
          additionalProperties: false,
        },
      },
      {
        name: 'list_tasks',
        description: 'List scheduled tasks visible to this group.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
      {
        name: 'pause_task',
        description: 'Pause a scheduled task.',
        inputSchema: {
          type: 'object',
          properties: { task_id: { type: 'string' } },
          required: ['task_id'],
          additionalProperties: false,
        },
      },
      {
        name: 'resume_task',
        description: 'Resume a paused task.',
        inputSchema: {
          type: 'object',
          properties: { task_id: { type: 'string' } },
          required: ['task_id'],
          additionalProperties: false,
        },
      },
      {
        name: 'cancel_task',
        description: 'Cancel and delete a scheduled task.',
        inputSchema: {
          type: 'object',
          properties: { task_id: { type: 'string' } },
          required: ['task_id'],
          additionalProperties: false,
        },
      },
      {
        name: 'refresh_groups',
        description: 'Refresh group metadata (main group only).',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
      {
        name: 'register_group',
        description: 'Register a new group (main group only).',
        inputSchema: {
          type: 'object',
          properties: {
            jid: { type: 'string' },
            name: { type: 'string' },
            folder: { type: 'string' },
            trigger: { type: 'string' },
          },
          required: ['jid', 'name', 'folder', 'trigger'],
          additionalProperties: false,
        },
      },
    ],
  }
}

function readTasksSnapshot(context) {
  const tasksFile = path.join(IPC_DIR, 'current_tasks.json')
  if (!fs.existsSync(tasksFile)) return []
  const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf8'))
  if (context.isMain) return allTasks
  return allTasks.filter((task) => task.groupFolder === context.groupFolder)
}

function handleToolCall(name, args) {
  const context = readContext()
  const now = new Date().toISOString()

  if (name === 'send_message') {
    if (!context.chatJid) {
      return { isError: true, content: [{ type: 'text', text: 'Missing chat context.' }] }
    }
    const data = {
      type: 'message',
      chatJid: context.chatJid,
      text: String(args.text || ''),
      groupFolder: context.groupFolder,
      timestamp: now,
    }
    const filename = writeIpcFile(MESSAGES_DIR, data)
    return { content: [{ type: 'text', text: `Message queued (${filename})` }] }
  }

  if (name === 'schedule_task') {
    const targetGroup = args.target_group || context.groupFolder
    const data = {
      type: 'schedule_task',
      prompt: String(args.prompt || ''),
      schedule_type: String(args.schedule_type || ''),
      schedule_value: String(args.schedule_value || ''),
      context_mode: args.context_mode || 'group',
      groupFolder: targetGroup,
      chatJid: context.chatJid,
      createdBy: context.groupFolder,
      timestamp: now,
    }
    const filename = writeIpcFile(TASKS_DIR, data)
    return {
      content: [
        {
          type: 'text',
          text: `Task scheduled (${filename}): ${data.schedule_type} - ${data.schedule_value}`,
        },
      ],
    }
  }

  if (name === 'list_tasks') {
    const tasks = readTasksSnapshot(context)
    if (!tasks.length) {
      return { content: [{ type: 'text', text: 'No scheduled tasks found.' }] }
    }
    const formatted = tasks
      .map(
        (task) =>
          `- [${task.id}] ${String(task.prompt).slice(0, 50)}... (${task.schedule_type}: ${task.schedule_value}) - ${task.status}, next: ${task.next_run || 'N/A'}`,
      )
      .join('\n')
    return { content: [{ type: 'text', text: `Scheduled tasks:\n${formatted}` }] }
  }

  if (name === 'pause_task' || name === 'resume_task' || name === 'cancel_task') {
    const data = {
      type: name,
      taskId: String(args.task_id || ''),
      groupFolder: context.groupFolder,
      isMain: context.isMain,
      timestamp: now,
    }
    writeIpcFile(TASKS_DIR, data)
    const action = name.replace('_', ' ')
    return { content: [{ type: 'text', text: `Task ${data.taskId} ${action} requested.` }] }
  }

  if (name === 'refresh_groups') {
    if (!context.isMain) {
      return { isError: true, content: [{ type: 'text', text: 'Only the main group can refresh groups.' }] }
    }
    const data = { type: 'refresh_groups', groupFolder: context.groupFolder, timestamp: now }
    writeIpcFile(TASKS_DIR, data)
    return { content: [{ type: 'text', text: 'Group refresh requested.' }] }
  }

  if (name === 'register_group') {
    if (!context.isMain) {
      return { isError: true, content: [{ type: 'text', text: 'Only the main group can register groups.' }] }
    }
    const data = {
      type: 'register_group',
      jid: String(args.jid || ''),
      name: String(args.name || ''),
      folder: String(args.folder || ''),
      trigger: String(args.trigger || ''),
      timestamp: now,
    }
    writeIpcFile(TASKS_DIR, data)
    return { content: [{ type: 'text', text: `Group "${data.name}" registration requested.` }] }
  }

  return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] }
}

let buffer = ''

function processBuffer() {
  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n')
    if (headerEnd === -1) return

    const header = buffer.slice(0, headerEnd)
    const lengthMatch = header.match(/Content-Length: (\d+)/i)
    if (!lengthMatch) {
      buffer = buffer.slice(headerEnd + 4)
      continue
    }

    const contentLength = Number.parseInt(lengthMatch[1], 10)
    const bodyStart = headerEnd + 4
    if (buffer.length < bodyStart + contentLength) return

    const body = buffer.slice(bodyStart, bodyStart + contentLength)
    buffer = buffer.slice(bodyStart + contentLength)

    let message
    try {
      message = JSON.parse(body)
    } catch {
      continue
    }

    handleMessage(message)
  }
}

function handleMessage(message) {
  const { id, method, params } = message

  if (method === 'initialize') {
    const protocolVersion = params && params.protocolVersion ? params.protocolVersion : '2024-11-05'
    sendResponse(id, {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    })
    return
  }

  if (method === 'tools/list') {
    sendResponse(id, toolsList())
    return
  }

  if (method === 'tools/call') {
    if (!params || !params.name) {
      sendError(id, -32602, 'Missing tool name')
      return
    }
    const result = handleToolCall(params.name, params.arguments || {})
    sendResponse(id, result)
    return
  }

  if (typeof id !== 'undefined') {
    sendError(id, -32601, `Method not found: ${method}`)
  }
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  processBuffer()
})

process.stdin.on('error', () => {
  process.exit(1)
})
