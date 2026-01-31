export function sanitizeMarkdownForPreview(text: string): string {
  if (!text) return ""
  const fenceCount = (text.match(/```/g) || []).length
  if (fenceCount % 2 !== 0) {
    return `${text}\n\`\`\``
  }
  return text
}
