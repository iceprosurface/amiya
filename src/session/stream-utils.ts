export function splitMarkdownIntoChunks(text: string, maxChars: number): string[] {
  if (!text) return []
  if (maxChars <= 0) return [text]

  const chunks: string[] = []
  let remaining = text

  while (remaining.length > maxChars) {
    const slice = remaining.slice(0, maxChars)
    let splitIndex = slice.lastIndexOf("\n\n")
    if (splitIndex <= 0) {
      splitIndex = slice.lastIndexOf("\n")
    }
    if (splitIndex <= 0) {
      splitIndex = maxChars
    }
    const chunk = remaining.slice(0, splitIndex)
    if (chunk.length > 0) {
      chunks.push(chunk)
    }
    remaining = remaining.slice(splitIndex)
  }

  if (remaining.length > 0) {
    chunks.push(remaining)
  }

  return chunks
}
