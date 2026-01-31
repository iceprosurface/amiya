# Amiya - 飞书控制 OpenCode Bot

🐰 Amiya 是一个飞书机器人，用来在聊天里驱动 OpenCode 进行 AI 编程。当前实现对齐 kimaki 的 session/queue/abort 设计，支持多会话与命令路由。

## 功能

- ✅ 飞书 WebSocket 长连接收消息（无需公网回调）
- ✅ Thread -> Session 绑定与持久化
- ✅ 任务队列与中断（abort）
- ✅ 会话级 model/agent 偏好
- ✅ 命令路由：/new-session /resume /abort /queue /list-sessions /model /agent /compact /help
- ✅ Lark 国际版支持（useLark）

> Slack 目前只有骨架，暂不可用。

## 安装与运行

## Quick Start（单机）

### 1) 一键启动（推荐）

脚本会自动安装/配置：nvm + Node 24、pnpm、pm2、opencode CLI，并引导生成 `.amiya/feishu.json` 与 `.amiya/source.md`。

```bash
scripts/bootstrap.sh /path/to/your/project
```

### 2) 无交互模式（CI/自动化）

```bash
AMIYA_NON_INTERACTIVE=1 \
AMIYA_TARGET_DIR=/path/to/your/project \
FEISHU_APP_ID=xxx \
FEISHU_APP_SECRET=xxx \
scripts/bootstrap.sh
```

可选环境变量：
- `OPENCODE_INSTALL_CMD`：自定义 opencode CLI 安装命令（例如内网环境）

注意事项：
- 当前仅支持 provider `feishu`（脚本会校验）。
- pnpm v10 默认禁止依赖的 build scripts，首次运行可能需要执行：`pnpm approve-builds`（允许 `better-sqlite3` 等编译）。

## 详细安装与运行

### 1) 安装依赖

```bash
pnpm install
```

### 2) 准备飞书配置

在目标项目目录下创建 `.amiya/feishu.json`（会按以下顺序搜索）：  
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

说明：
- `adminUserIds` 为空不会触发额外权限，当前实现仅做简单允许列表过滤。
- `adminChatId` 用于审批卡片投递的管理员群（可不填）。
- `botUserId` 用于识别是否 @ 机器人（thread 的 /mention-required 需要）。
- `allowedChatIds` 为空表示不限制群聊。
- `requireUserWhitelist` 为 true 时，仅允许 `adminUserIds` 白名单用户触发消息处理。
- `model` 会作为 OpenCode 默认模型（可被 /model 覆盖）。
- `streaming` 为流式输出配置（默认关闭）。

### 流式输出

飞书支持流式输出，用于实时展示生成过程。

参数说明：
- `enabled`: 是否启用流式输出（默认 false）
- `mode`: `update`（原地更新）或 `append`（追加消息）
- `throttleMs`: 更新间隔毫秒数
- `maxMessageChars`: 单条消息最大字符数
- `maxUpdateCount`: 单条消息最大更新次数，超出后自动切换为 append

### 3) 启动

```bash
pnpm start -- /path/to/your/project
```

启动后会在目标项目目录下创建 `.amiya/`：
- `amiya.sqlite3`：会话/偏好数据
- `amiya.lock`：单实例锁
- `source.md`：agent 核心提示词（可由 agent 自行维护）

> 依赖：本地需要可执行 `opencode` 命令；可通过 `OPENCODE_PATH` 指定路径。

### 4) 生产部署（单机 / PM2）

一键脚本已包含 pm2 启动逻辑，适合单机环境。更多定制请参考 `scripts/bootstrap.sh`。

查看状态与日志：

```bash
pm2 status
pm2 logs amiya
```

## 使用方法

### 日常对话

在飞书里直接发消息即可，普通文本会作为提示词发给 OpenCode。

### 命令

- `/new-session` 新建会话
- `/resume` 恢复上次会话
- `/abort` 取消当前请求
- `/queue` 查看队列
- `/list-sessions` 列出会话
- `/model <name>` 设置当前 session 模型
- `/agent <name>` 设置当前 session agent
- `/mention-required <true|false>` 设置当前 thread 是否必须 @ 机器人
- `/compact` 压缩当前会话（占位）
- `/update` / `/deploy` 更新代码（git pull + 可选 pnpm install + pm2 重启）
- `/help` 查看帮助

> 以 `/` 开头会被识别为命令，其余文本视为普通对话。

## 飞书开发者配置

1. 登录 [飞书开放平台](https://open.feishu.cn/)
2. 创建企业自建应用
3. 获取 App ID 和 App Secret
4. 开启机器人能力
5. 在「事件订阅」中启用 **长连接模式**（无需回调地址）
6. 订阅 `im.message.receive_v1` 事件

## 项目结构

```
99-apps/apps/amiya/
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

## 开发与调试

```bash
pnpm dev
pnpm typecheck
```

## License

MIT
