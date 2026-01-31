import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

import type {
  FeishuElement,
  FeishuLine,
  FeishuLinkElement,
  FeishuPostContent,
} from './types.js'

type UnistNode = {
  type: string
}

type UnistParent = UnistNode & {
  children?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isNode(value: unknown): value is UnistNode {
  return isRecord(value) && typeof value.type === 'string'
}

function isParentNode(value: unknown): value is UnistParent {
  return isNode(value)
}

function getChildren(node: unknown): unknown[] {
  if (!isParentNode(node)) return []
  const children = (node as Record<string, unknown>).children
  return Array.isArray(children) ? children : []
}

function getString(node: unknown, key: string): string | null {
  if (!isRecord(node)) return null
  const value = node[key]
  return typeof value === 'string' ? value : null
}

function getNumber(node: unknown, key: string): number | null {
  if (!isRecord(node)) return null
  const value = node[key]
  return typeof value === 'number' ? value : null
}

function hasType(node: unknown, type: string): boolean {
  return isNode(node) && node.type === type
}

function textElement(text: string): FeishuElement {
  return { tag: 'text', text }
}

function nodeToPlainText(node: unknown): string {
  if (!isNode(node)) return ''

  if (node.type === 'text') {
    return getString(node, 'value') ?? ''
  }

  if (node.type === 'inlineCode' || node.type === 'code') {
    return getString(node, 'value') ?? ''
  }

  if (node.type === 'image') {
    return getString(node, 'alt') ?? ''
  }

  const children = getChildren(node)
  if (children.length === 0) return ''
  return children.map(nodeToPlainText).join('')
}

function elementsCharSize(line: FeishuLine): number {
  let size = 0
  for (const el of line) {
    if (!el) continue
    if (el.tag === 'text') {
      size += el.text.length
    } else if (el.tag === 'a') {
      size += el.text.length + el.href.length + 4
    } else if (el.tag === 'at') {
      size += el.user_name.length + el.user_id.length + 6
    } else if (el.tag === 'img') {
      size += el.image_key.length + 6
    } else if (el.tag === 'emoji') {
      size += el.emoji.length + 2
    } else if (el.tag === 'md') {
      size += el.text.length
    } else if (el.tag === 'hr') {
      size += 2
    }
  }
  return size
}

function clampPostLines(content: FeishuLine[], options?: { maxLines: number; maxChars: number }): FeishuLine[] {
  const maxLines = options?.maxLines ?? 400
  const maxChars = options?.maxChars ?? 12000

  const out: FeishuLine[] = []
  let totalChars = 0

  for (const line of content) {
    if (out.length >= maxLines) break
    const lineSize = elementsCharSize(line)
    if (out.length > 0 && totalChars + lineSize > maxChars) break
    out.push(line)
    totalChars += lineSize
  }

  const truncated = out.length < content.length
  if (truncated) {
    if (out.length === 0) {
      return [[textElement('...(truncated)')]]
    }
    if (out.length >= maxLines) {
      out[out.length - 1] = [textElement('...(truncated)')]
    } else {
      out.push([textElement('...(truncated)')])
    }
  }

  return out
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

function splitLines(text: string): string[] {
  return normalizeNewlines(text).split('\n')
}

type InlineRenderResult = {
  lines: FeishuLine[]
}

function renderInlineChildren(children: unknown[]): InlineRenderResult {
  const lines: FeishuLine[] = [[]]

  const pushText = (text: string) => {
    const current = lines[lines.length - 1]
    current.push(textElement(text))
  }

  const pushElements = (elements: FeishuElement[]) => {
    const current = lines[lines.length - 1]
    current.push(...elements)
  }

  const newLine = () => {
    lines.push([])
  }

  const renderInlineNode = (node: unknown) => {
    if (!isNode(node)) return

    if (node.type === 'text') {
      const value = getString(node, 'value')
      if (value) pushText(value)
      return
    }

    if (node.type === 'inlineCode') {
      const value = getString(node, 'value')
      if (value !== null) pushText(`\`${value}\``)
      return
    }

    if (node.type === 'break') {
      newLine()
      return
    }

    if (node.type === 'strong') {
      pushText('**')
      pushElements(renderInlineChildren(getChildren(node)).lines.flatMap((l, idx) => {
        if (idx === 0) return l
        return [textElement('\n'), ...l]
      }))
      pushText('**')
      return
    }

    if (node.type === 'emphasis') {
      pushText('*')
      pushElements(renderInlineChildren(getChildren(node)).lines.flatMap((l, idx) => {
        if (idx === 0) return l
        return [textElement('\n'), ...l]
      }))
      pushText('*')
      return
    }

    if (node.type === 'delete') {
      pushText('~~')
      pushElements(renderInlineChildren(getChildren(node)).lines.flatMap((l, idx) => {
        if (idx === 0) return l
        return [textElement('\n'), ...l]
      }))
      pushText('~~')
      return
    }

    if (node.type === 'link') {
      const url = getString(node, 'url')
      const text = nodeToPlainText(node).trim()
      if (url && text) {
        pushElements([{ tag: 'a', text, href: url } as FeishuLinkElement])
        return
      }
      // fallback
      pushElements(renderInlineChildren(getChildren(node)).lines.flatMap((l, idx) => {
        if (idx === 0) return l
        return [textElement('\n'), ...l]
      }))
      return
    }

    if (node.type === 'image') {
      const url = getString(node, 'url')
      const alt = getString(node, 'alt')
      const label = alt ? `[image: ${alt}]` : '[image]'
      if (url) {
        pushElements([{ tag: 'a', text: label, href: url } as FeishuLinkElement])
      } else {
        pushText(label)
      }
      return
    }

    // Default: render children as plain text
    pushElements(renderInlineChildren(getChildren(node)).lines.flatMap((l, idx) => {
      if (idx === 0) return l
      return [textElement('\n'), ...l]
    }))
  }

  for (const child of children) {
    renderInlineNode(child)
  }

  return { lines }
}

function renderParagraph(node: unknown): FeishuLine[] {
  return renderInlineChildren(getChildren(node)).lines
}

function renderHeading(node: unknown): FeishuLine[] {
  const depth = getNumber(node, 'depth') ?? 1
  const prefix = `${'#'.repeat(Math.min(Math.max(depth, 1), 6))} `
  const rendered = renderInlineChildren(getChildren(node)).lines
  if (rendered.length === 0) return [[textElement(prefix)]]
  const first = rendered[0]
  return [[textElement(prefix), ...first], ...rendered.slice(1)]
}

function renderBlockquote(node: unknown): FeishuLine[] {
  const out: FeishuLine[] = []
  const blocks = renderBlockChildren(getChildren(node), 0)
  for (const line of blocks) {
    if (line.length === 0) {
      out.push([])
      continue
    }
    out.push([textElement('│ '), ...line])
  }
  return out
}

function renderCodeBlock(node: unknown): FeishuLine[] {
  const value = getString(node, 'value') ?? ''
  const lang = getString(node, 'lang')
  const fenceStart = lang ? `\`\`\`${lang}` : '```'
  const lines = splitLines(value)
  return [
    [textElement(fenceStart)],
    ...lines.map((l) => [textElement(l)]),
    [textElement('```')],
  ]
}

function renderThematicBreak(): FeishuLine[] {
  return [[textElement('---')]]
}

function renderList(node: unknown, indentLevel: number): FeishuLine[] {
  const ordered = isRecord(node) ? Boolean(node.ordered) : false
  const start = isRecord(node) && typeof node.start === 'number' ? node.start : 1
  const children = getChildren(node)

  const out: FeishuLine[] = []
  let index = 0
  for (const child of children) {
    if (!hasType(child, 'listItem')) continue
    const itemLines = renderListItem(child, indentLevel, ordered, start + index)
    out.push(...itemLines)
    index += 1
  }
  return out
}

function renderListItem(
  node: unknown,
  indentLevel: number,
  ordered: boolean,
  index: number,
): FeishuLine[] {
  const indent = '  '.repeat(Math.max(indentLevel, 0))
  const marker = ordered ? `${index}. ` : '• '
  const prefix = `${indent}${marker}`

  const blocks = renderBlockChildren(getChildren(node), indentLevel + 1)
  if (blocks.length === 0) return [[textElement(prefix)]]

  const out: FeishuLine[] = []
  const first = blocks[0]
  out.push([textElement(prefix), ...first])
  const continuationIndent = ' '.repeat(prefix.length)
  for (const line of blocks.slice(1)) {
    if (line.length === 0) {
      out.push([])
    } else {
      out.push([textElement(continuationIndent), ...line])
    }
  }
  return out
}

function renderBlockChildren(children: unknown[], indentLevel: number): FeishuLine[] {
  const out: FeishuLine[] = []

  const appendWithSeparation = (block: FeishuLine[]) => {
    if (block.length === 0) return
    if (out.length > 0) {
      const last = out[out.length - 1]
      if (last.length !== 0) out.push([])
    }
    out.push(...block)
  }

  for (const child of children) {
    if (!isNode(child)) continue
    switch (child.type) {
      case 'paragraph':
        appendWithSeparation(renderParagraph(child))
        break
      case 'heading':
        appendWithSeparation(renderHeading(child))
        break
      case 'blockquote':
        appendWithSeparation(renderBlockquote(child))
        break
      case 'list':
        appendWithSeparation(renderList(child, indentLevel))
        break
      case 'code':
        appendWithSeparation(renderCodeBlock(child))
        break
      case 'thematicBreak':
        appendWithSeparation(renderThematicBreak())
        break
      default:
        // Unknown block: best-effort flatten to text
        appendWithSeparation([[textElement(nodeToPlainText(child))]])
        break
    }
  }

  return out
}

export function markdownToFeishuPost(markdown: string): FeishuPostContent {
  const trimmed = markdown.trim()
  if (!trimmed) return { content: [] }

  try {
    const tree: unknown = unified().use(remarkParse).use(remarkGfm).parse(trimmed)
    const children = getChildren(tree)

    // Optional: treat leading H1 as title and remove it from body
    let title: string | undefined
    let bodyMarkdown = trimmed
    const first = children[0]
    if (first && hasType(first, 'heading') && getNumber(first, 'depth') === 1) {
      const h1 = nodeToPlainText(first).trim()
      if (h1) {
        title = h1

        const position = isRecord(first) ? (first as Record<string, unknown>).position : undefined
        if (isRecord(position)) {
          const end = position.end
          if (isRecord(end) && typeof end.offset === 'number') {
            bodyMarkdown = bodyMarkdown.slice(end.offset).trimStart()
          }
        }
      }
    }

    const content = clampPostLines([[{ tag: 'md', text: bodyMarkdown }]])
    return title ? { title, content } : { content }
  } catch {
    // Fallback: plain text, one line per \n
    const content = clampPostLines(splitLines(trimmed).map((line) => [textElement(line)]))
    return { content }
  }
}

export function feishuPostToJson(post: FeishuPostContent): string {
  // Server API expects the locale object as the root of content JSON.
  // See: https://open.feishu.cn/document/server-docs/im-v1/message-content-description/create_json
  return JSON.stringify({
    zh_cn: {
      ...(post.title ? { title: post.title } : {}),
      content: post.content,
    },
  })
}
