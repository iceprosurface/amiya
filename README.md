# Amiya - Feishu-controlled OpenCode Bot

English | [中文](README.zh.md)

🐰 Amiya is a Feishu bot that drives OpenCode for AI coding in chat. The current implementation follows kimaki's session/queue/abort design and supports multi-session routing.

## Features

- ✅ Feishu WebSocket long connection (no public callback needed)
- ✅ Thread -> Session binding and persistence
- ✅ Task queue and abort support
- ✅ Session-level model/agent preferences
- ✅ Command routing: /new-session /resume /abort /queue /list-sessions /model /agent /project /compact /help
- ✅ Lark (international Feishu) support via `useLark`
- ✅ Workspace binding with configurable base directory

> Slack is only a skeleton for now and is not usable.

## Install and Run

## Quick Start (single machine)

### 1) One-shot bootstrap (recommended)

The script installs/configures: nvm + Node 24, pnpm, pm2, opencode CLI, and guides you to generate `.amiya/feishu.json` and `.amiya/source.md`.

```bash
scripts/bootstrap.sh /path/to/your/project
```

### 2) Non-interactive (CI/automation)

```bash
AMIYA_NON_INTERACTIVE=1 \
AMIYA_TARGET_DIR=/path/to/your/project \
FEISHU_APP_ID=xxx \
FEISHU_APP_SECRET=xxx \
scripts/bootstrap.sh
```

Optional environment variables:
- `OPENCODE_INSTALL_CMD`: custom opencode CLI install command (e.g. for internal mirrors)

Notes:
- Only the `feishu` provider is supported (the script validates this).
- pnpm v10 disables dependency build scripts by default. On first run, you may need `pnpm approve-builds` (to allow `better-sqlite3`, etc.).

## Detailed Setup

### 1) Install dependencies

```bash
pnpm install
```

### 2) Prepare Feishu config

Create `.amiya/feishu.json` in your target project directory (searched in this order):  
1) `<project>/.amiya/feishu.json`  
2) `<project>/feishu.json`  
3) `<project>/../.amiya/feishu.json`  
4) `<project>/../feishu.json`  
5) `<cwd>/.amiya/feishu.json`  
6) `<cwd>/feishu.json`

```json
{
  "appId": "YOUR_FEISHU_APP_ID",
  "appSecret": "YOUR_FEISHU_APP_SECRET",
  "useLark": false,
  "adminUserIds": [],
  "adminChatId": "",
  "botUserId": "",
  "allowedChatIds": [],
  "requireUserWhitelist": false,
  "debug": true,
  "model": "provider/model",
  "streaming": {
    "enabled": false,
    "mode": "update",
    "throttleMs": 700,
    "maxMessageChars": 9500,
    "maxUpdateCount": 15
  }
}
```

Notes:
- Empty `adminUserIds` means no extra permissions are enforced; the current implementation is a simple allowlist filter.
- `adminChatId` is the admin group for approval cards (optional).
- `botUserId` identifies bot mentions (needed for thread `/mention-required`); it attempts auto-fetch if empty, otherwise set it manually.
- Empty `allowedChatIds` means no group restrictions.
- `requireUserWhitelist` set to true restricts requests to `adminUserIds`.
- `model` is the default OpenCode model (overridable by `/model`).
- `streaming` config is for incremental output (off by default).

### Streaming output

Feishu supports streaming output to show progress in real time.

Parameters:
- `enabled`: enable streaming output (default false)
- `mode`: `update` (in-place update) or `append` (append messages)
- `throttleMs`: update interval in milliseconds
- `maxMessageChars`: max characters per message
- `maxUpdateCount`: max updates per message; beyond this, switches to append

### 3) Start

```bash
pnpm start -- /path/to/your/project
```

On startup, the target project directory will contain `.amiya/`:
- `amiya.sqlite3`: session/preferences data
- `amiya.lock`: single instance lock
- `source.md`: agent prompt (maintained by the agent)

Runtime config (`.amiya/config.json`):

```json
{
  "workspaceDir": "~/.amiya-project",
  "workspaceJoinRequiresApproval": true
}
```

- `workspaceDir` sets the base directory for workspace folders.
- `workspaceJoinRequiresApproval` toggles join approval (false to auto-join).

> Requires an executable `opencode` command; you can set `OPENCODE_PATH` to override.

### 4) Production (single machine / PM2)

The bootstrap script includes pm2 startup for single-machine deployments. For more customization, see `scripts/bootstrap.sh`.

Status and logs:

```bash
pm2 status
pm2 logs amiya
```

## Usage

### Chatting

Send messages in Feishu. Normal text becomes prompts for OpenCode.

### Commands

- `/new-session` create a new session
- `/resume` resume the last session
- `/abort` cancel the current request
- `/queue` show the queue
- `/list-sessions` list sessions
- `/model <name>` set the session model
- `/agent <name>` set the session agent
- `/project <path>` set the project directory for the channel
- `/mention-required <true|false>` require bot @ mention in the thread
- `/compact` compact the session (placeholder)
- `/update` / `/deploy` update code (git pull + optional pnpm install + pm2 restart)
- `/help` show help

> Messages starting with `/` are treated as commands; everything else is plain chat.

## Feishu Developer Setup

1. Log in to [Feishu Open Platform](https://open.feishu.cn/)
2. Create a custom enterprise app
3. Get App ID and App Secret
4. Enable bot capability
5. Enable **long connection mode** in Event Subscriptions (no callback URL needed)
6. Subscribe to `im.message.receive_v1`

## Project Structure

```
amiya/
├── src/
│   ├── index.ts
│   ├── session/
│   ├── providers/
│   │   ├── feishu/
│   │   └── slack/
│   ├── opencode.ts
│   ├── database.ts
│   └── runtime/
├── scripts/
├── package.json
└── tsconfig.json
```

## Development

```bash
pnpm dev
pnpm typecheck
```

## License

MIT
