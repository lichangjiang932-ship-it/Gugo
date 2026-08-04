const STORAGE_KEY = 'yma:chat-feedback'

export function recordLocalChatFeedback(value, sessionId) {
  if (typeof window === 'undefined') return false
  try {
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '[]')
    const entries = Array.isArray(stored) ? stored : []
    entries.push({ value: String(value), sessionId: sessionId || null, createdAt: Date.now() })
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(-50)))
    return true
  } catch {
    return false
  }
}
