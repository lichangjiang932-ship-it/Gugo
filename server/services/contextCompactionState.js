/** Keep provider-only reductions out of durable loop checkpoints and telemetry. */
export function withCanonicalContext(prepared, messages) {
  Object.defineProperty(prepared, 'canonicalMessages', { value: messages, enumerable: false })
  return prepared
}

export function canonicalContextMessages(prepared) {
  return prepared.canonicalMessages || prepared.messages
}

export function assertContextRecoveryActive(signal) {
  if (!signal?.aborted) return
  const reason = signal.reason
  if (reason instanceof Error) throw reason
  const error = new Error('Context recovery cancelled')
  error.name = 'AbortError'
  if (reason?.code) error.code = reason.code
  throw error
}
