import { createHash, timingSafeEqual } from 'node:crypto'

function integrityError(code, message) {
  return Object.assign(new Error(message), {
    code,
    statusCode: 400,
    retryable: false,
  })
}

function expectedDigest(integrity) {
  const value = String(integrity || '').trim()
  if (!value) return null
  const match = value.match(/^sha256-(.+)$/i)
  const encoded = match?.[1] || ''
  if (/^[a-f0-9]{64}$/i.test(encoded)) return Buffer.from(encoded, 'hex')
  if (/^[A-Za-z0-9+/]{43}=$/.test(encoded)) return Buffer.from(encoded, 'base64')
  throw integrityError('PLUGIN_INTEGRITY_INVALID', '插件 manifest integrity 不是有效的 SHA-256 摘要')
}

export function verifyPluginEntryIntegrity({ integrity, bytes } = {}) {
  const expected = expectedDigest(integrity)
  if (!expected) return true
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
    throw integrityError('PLUGIN_INTEGRITY_INPUT_INVALID', '插件入口完整性校验需要原始字节')
  }
  const actual = createHash('sha256').update(bytes).digest()
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw integrityError('PLUGIN_INTEGRITY_MISMATCH', '插件入口内容与 manifest integrity 不匹配')
  }
  return true
}
