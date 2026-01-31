/**
 * 飞书富文本元素类型定义
 */

export type FeishuTextElement = {
  tag: 'text'
  text: string
  // See Feishu message "post" content schema
  // https://open.feishu.cn/document/server-docs/im-v1/message-content-description/create_json
  un_escape?: boolean
  style?: Array<'bold' | 'italic' | 'underline' | 'lineThrough'>
}

export type FeishuLinkElement = {
  tag: 'a'
  text: string
  href: string
}

export type FeishuAtElement = {
  tag: 'at'
  user_id: string
  user_name: string
}

export type FeishuImageElement = {
  tag: 'img'
  image_key: string
}

export type FeishuEmojiElement = {
  tag: 'emoji'
  emoji: string
}

export type FeishuMdElement = {
  tag: 'md'
  text: string
}

export type FeishuHrElement = {
  tag: 'hr'
}

export type FeishuElement =
  | FeishuTextElement
  | FeishuLinkElement
  | FeishuAtElement
  | FeishuImageElement
  | FeishuEmojiElement
  | FeishuMdElement
  | FeishuHrElement

export type FeishuLine = FeishuElement[]

export type FeishuPostContent = {
  title?: string
  content: FeishuLine[]
}
