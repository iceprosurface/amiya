# Amiya - 飞书 + OpenCode（容器化）

极简单进程架构，流程完全对齐 NanoClaw：飞书收发、SQLite 记录、轮询处理、容器内 OpenCode SDK 执行。

## 功能

- 飞书消息收发（WebSocket 长连接）
- SQLite 持久化（消息 + 定时任务）
- 按群组隔离（容器挂载 + 独立会话目录）
- 主群管理所有群组与任务

## 快速开始

```bash
pnpm install
```

设置环境变量：

```bash
export FEISHU_APP_ID=xxx
export FEISHU_APP_SECRET=xxx
export FEISHU_MAIN_CHAT_ID=oc_xxx
export ASSISTANT_NAME=Andy
```

运行：

```bash
pnpm dev
```

## 依赖

- Node.js 20+
- Apple Container（或提供 `container` CLI 的运行时）

## 环境变量

- `FEISHU_APP_ID`（必填）
- `FEISHU_APP_SECRET`（必填）
- `FEISHU_MAIN_CHAT_ID`（必填，主控制群）
- `FEISHU_MAIN_CHAT_NAME`（可选，默认 `Main`）
- `FEISHU_ALLOWED_CHAT_IDS`（可选，逗号分隔白名单）
- `FEISHU_USE_LARK`（可选，`true` 时使用 Lark）
- `ASSISTANT_NAME`（可选，默认 `Andy`）
- `CONTAINER_IMAGE`（可选，默认 `opencode-agent:latest`）
- `CONTAINER_RUNTIME`（可选，默认 `container`，使用 `podman`）
- `CONTAINER_TIMEOUT`（可选，默认 `300000`）
- `CONTAINER_MAX_OUTPUT_SIZE`（可选，默认 `10485760`）

## 配置文件

可以把设置放到 `.amiya/config.json`（环境变量优先）。

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

## 架构

```
飞书 --> SQLite --> 轮询处理 --> 容器(OpenCode SDK) --> 回复
```

单进程运行，容器内只挂载显式目录，并为每个群组创建独立 IPC 目录。

## 容器协议

容器从 stdin 读取 JSON，输出 JSON 并用哨兵包裹：

```
---NANOCLAW_OUTPUT_START---
{"status":"success","result":"...","newSessionId":"..."}
---NANOCLAW_OUTPUT_END---
```

输入格式：

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

## Agent 容器

容器镜像使用本仓库的 `agent/index.js`。

构建示例（Apple Container / Docker）：

```bash
container build -t opencode-agent:latest -f agent/Containerfile .
```

## 挂载白名单

额外挂载需要通过：

```
~/.config/amiya/mount-allowlist.json
```

文件不存在时将阻止额外挂载。

## 脚本

- `pnpm dev` - 开发模式
- `pnpm build` - 构建 `dist/`
- `pnpm start` - 运行构建产物
- `pnpm typecheck` - 类型检查

## License

MIT
