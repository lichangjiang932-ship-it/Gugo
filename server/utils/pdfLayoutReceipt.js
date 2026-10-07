import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

// Process authority, never written to env/files or shared with shell workers.
// Cold hosts require a fresh read-only verification; warm checkpoint JSON can
// retain a receipt without relying on an object identity/WeakSet.
const authority = randomBytes(32)

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
}

function signature(payload) {
  return createHmac('sha256', authority).update(JSON.stringify(canonical(payload))).digest('hex')
}

/** Called only after the builtin parser/renderer has satisfied every check. */
export function issuePdfLayoutReceipt(payload) {
  const data = structuredClone({ ...payload, version: 1, verifier: 'gugo_pdf_layout', verified: true })
  return Object.freeze({ ...data, signature: signature(data) })
}

export function isTrustedPdfLayoutReceipt(receipt, binding = {}) {
  try {
    if (!receipt || receipt.version !== 1 || receipt.verifier !== 'gugo_pdf_layout'
      || receipt.verified !== true || !/^[a-f0-9]{64}$/u.test(receipt.signature || '')
      || !/^[a-f0-9]{64}$/u.test(receipt.output?.sha256 || '')
      || !receipt.output?.path || !Array.isArray(receipt.checks) || receipt.checks.length < 3
      || receipt.checks.some((check) => check?.passed !== true)) return false
    for (const key of ['userId', 'sessionId', 'executionId']) {
      if (binding[key] != null && receipt[key] !== binding[key]) return false
    }
    const { signature: recorded, ...data } = receipt
    return timingSafeEqual(Buffer.from(recorded, 'hex'), Buffer.from(signature(data), 'hex'))
  } catch { return false }
}
