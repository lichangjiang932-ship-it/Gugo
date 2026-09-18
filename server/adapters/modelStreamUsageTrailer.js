import { decodeModelStreamLine } from './modelResponseStream.js'
import { extractUsage } from './modelProviderResponse.js'

const TRAILER_TIMEOUT_MS = 1000
const TRAILER_MAX_LINES = 64
const TRAILER_MAX_BYTES = 65_536

export function requestsCompatibleUsageTrailer(providerRequest, terminalChunk) {
  if (!terminalChunk?.choices?.[0]?.finish_reason) return false
  try {
    return JSON.parse(providerRequest?.init?.body)?.stream_options?.include_usage === true
  } catch { return false }
}

/** A verified Chat Completions terminal can precede its optional usage frame.
 * Read only statistics, with a fixed deadline and byte/line bounds. Trailer
 * errors cannot revoke an already known response or authorize another request. */
export function createUsageTrailerReader(reader, signal) {
  let stop = null
  let bytes = 0
  return {
    onChunk(value) {
      if (stop && (bytes += value?.byteLength || 0) > TRAILER_MAX_BYTES) stop()
    },
    async read(lines) {
      const stopped = new Promise((resolve) => {
        stop = () => {
          resolve({ done: true })
          // Unblock a pending read as well as the race. Fetch readers release
          // pending reads even if their source's cancellation promise rejects.
          try { Promise.resolve(reader.cancel()).catch(() => {}) } catch { /* already closed */ }
        }
      })
      const onAbort = () => stop?.()
      const timer = setTimeout(onAbort, TRAILER_TIMEOUT_MS)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) onAbort()
      let characters = 0
      try {
        for (let count = 0; count < TRAILER_MAX_LINES; count += 1) {
          const next = await Promise.race([lines.next(), stopped])
          if (next.done) return null
          characters += next.value.length
          if (characters > TRAILER_MAX_BYTES) return null
          const decoded = decodeModelStreamLine(next.value)
          if (!decoded) continue
          if (decoded.done) return null
          // No text, reasoning, error or tool delta can re-open generation.
          // Unexpected data terminates this optional read, not the response.
          if (!Array.isArray(decoded.data?.choices) || decoded.data.choices.length !== 0) return null
          const usage = extractUsage(decoded.data)
          if (usage) return usage
        }
      } catch { /* missing telemetry is not an unknown model outcome */ }
      finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        stop = null
      }
      return null
    },
  }
}
