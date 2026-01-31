export function createThrottledRenderer(
  renderFn: (text: string) => Promise<void>,
  throttleMs: number,
): { update: (text: string) => void; flush: () => Promise<void> } {
  let pendingText: string | null = null
  let timer: NodeJS.Timeout | null = null
  let lastRun = 0
  let chain = Promise.resolve()

  const schedule = () => {
    if (timer) return
    const delay = Math.max(0, throttleMs - (Date.now() - lastRun))
    timer = setTimeout(() => {
      timer = null
      const text = pendingText
      if (text === null) return
      pendingText = null
      lastRun = Date.now()
      chain = chain.then(() => renderFn(text)).catch(() => {})
      if (pendingText !== null) schedule()
    }, delay)
  }

  return {
    update(text: string) {
      pendingText = text
      schedule()
    },
    async flush() {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      const text = pendingText
      if (text === null) return
      pendingText = null
      lastRun = Date.now()
      chain = chain.then(() => renderFn(text))
      await chain.catch(() => {})
    },
  }
}
