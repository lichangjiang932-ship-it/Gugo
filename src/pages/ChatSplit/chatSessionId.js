export function createChatSessionId(cryptoImpl = globalThis.crypto) {
  return cryptoImpl?.randomUUID?.()
    ?? `session-${Date.now()}-${Math.random().toString(36).slice(2)}`
}
