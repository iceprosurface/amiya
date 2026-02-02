import { sendReply } from "../messaging.js";
import type { CommandHandler } from "./shared.js";

export const handleHelp: CommandHandler = async (message, _command, options) => {
  const { provider } = options;
  const lines = [
    "**命令帮助**",
    "",
    "**会话**",
    "- `/new-session` 新建会话",
    "- `/resume <会话ID>` 绑定会话",
    "- `/abort` 中止当前请求",
    "- `/queue` 查看队列",
    "- `/context [会话ID]` 查看上下文占用",
    "- `/list-sessions` 列出会话",
    "",
    "**模型与代理**",
    "- `/model <提供商/模型|clear>` 设置/清除模型",
    "- `/channel-model <提供商/模型>` 设置频道默认模型",
    "- `/agent <名称>` 设置 agent",
    "",
    "**项目目录**",
    "- `/project` 查看当前目录",
    "- `/project <path>` 设置当前频道目录",
    "- `/dir` 等同 `/project`",
    "",
    "**运行**",
    "- `/mention-required <true|false>` 线程是否必须@机器人",
    "- `/update` 或 `/deploy` 更新代码并重启",
    "- `/compact [会话ID]` 压缩会话",
    "- `/help` 查看帮助",
  ];
  await sendReply(provider, message, lines.join("\n"));
  return true;
};
