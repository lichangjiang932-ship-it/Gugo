import { modelProviderResponseEvents } from './modelNonStreaming.js'

function notifyObserver(observer) {
  if (typeof observer !== 'function') return
  try { observer() } catch { /* observability must not fail the request */ }
}

export async function readJsonModelResponseEvents(response, profile, { onFirstByte } = {}) {
  const contentType = String(response.headers?.get?.('content-type') || '')
  if (!/\bapplication\/(?:[^;\s]+\+)?json\b/i.test(contentType)) return null

  const text = await response.text()
  notifyObserver(onFirstByte)
  let data
  try { data = text ? JSON.parse(text) : null } catch { data = { raw: text } }
  return [...modelProviderResponseEvents(data, profile)]
}

/**
 * Decode a model SSE body into complete lines. The final buffered data field is
 * emitted even when a lightweight local server closes without a trailing LF.
 */
export async function* readModelSseLines(reader, { onFirstByte, onChunk } = {}) {
  const decoder = new TextDecoder()
  let buffer = ''
  let sawFirstChunk = false

  while (true) {
    const { done, value } = await reader.read()
    if (done) {
      buffer += decoder.decode()
      if (buffer) buffer += '\n'
    } else {
      if (!sawFirstChunk) {
        sawFirstChunk = true
        notifyObserver(onFirstByte)
      }
      if (typeof onChunk === 'function') onChunk()
      buffer += decoder.decode(value, { stream: true })
    }

    const lines = buffer.split('\n')
    buffer = lines.pop() || ''
    yield* lines
    if (done) return
  }
}
