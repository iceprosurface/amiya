# Amiya - Feishu + OpenCode (Containerized)

Minimal, single-process assistant that mirrors NanoClaw's flow with Feishu I/O and OpenCode SDK inside containers.

## What It Does

- Feishu message I/O (WebSocket long connection)
- SQLite persistence (messages + scheduled tasks)
- Per-group isolation via container mounts and session folders
- Main group controls other groups and tasks

## Quick Start

```bash
pnpm install
```

Set environment variables:

```bash
export FEISHU_APP_ID=xxx
export FEISHU_APP_SECRET=xxx
export FEISHU_MAIN_CHAT_ID=oc_xxx
export ASSISTANT_NAME=Andy
```

Run:

```bash
pnpm dev
```

## Requirements

- Node.js 20+
- Apple Container (or compatible runtime exposing `container` CLI)

## Environment

- `FEISHU_APP_ID` (required)
- `FEISHU_APP_SECRET` (required)
- `FEISHU_MAIN_CHAT_ID` (required): your main control chat
- `FEISHU_MAIN_CHAT_NAME` (optional, default `Main`)
- `FEISHU_ALLOWED_CHAT_IDS` (optional, comma-separated allowlist)
- `FEISHU_USE_LARK` (optional, `true` for Lark)
- `ASSISTANT_NAME` (optional, default `Andy`)
- `CONTAINER_IMAGE` (optional, default `opencode-agent:latest`)
- `CONTAINER_RUNTIME` (optional, default `container`, use `podman` to switch)
- `CONTAINER_TIMEOUT` (optional, default `300000`)
- `CONTAINER_MAX_OUTPUT_SIZE` (optional, default `10485760`)

## Config File

You can put settings in `.amiya/config.json` (env vars still override it).

```json
{
  "runtimeDir": ".amiya/workspace",
  "assistantName": "Andy",
  "feishuAppId": "xxx",
  "feishuAppSecret": "xxx",
  "feishuMainChatId": "oc_xxx",
  "containerRuntime": "podman",
  "containerImage": "opencode-agent:latest"
}
```

## Architecture

```
Feishu --> SQLite --> Polling loop --> Container (OpenCode SDK) --> Response
```

Single Node.js process. Agents run inside containers with explicit mounts and per-group IPC directories.

## Container Contract

The container reads JSON from stdin and returns JSON wrapped by sentinel markers:

```
---NANOCLAW_OUTPUT_START---
{"status":"success","result":"...","newSessionId":"..."}
---NANOCLAW_OUTPUT_END---
```

Input shape:

```json
{
  "prompt": "...",
  "sessionId": "optional",
  "groupFolder": "main",
  "chatJid": "oc_xxx",
  "isMain": true,
  "isScheduledTask": false
}
```

## Agent Container

The container runner expects an image that executes `agent/index.js` in this repo.

Build example (Apple Container / Docker):

```bash
container build -t opencode-agent:latest -f agent/Containerfile .
```

## Mount Allowlist

Additional mounts are validated against:

```
~/.config/amiya/mount-allowlist.json
```

If the file is missing, extra mounts are blocked.

## Scripts

- `pnpm dev` - run with live reload
- `pnpm build` - build `dist/`
- `pnpm start` - run built output
- `pnpm typecheck` - TypeScript check

## License

MIT
