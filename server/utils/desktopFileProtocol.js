import { createHmac, timingSafeEqual } from 'node:crypto'
import { desktopFileError } from '../../shared/desktopFileReference.js'

const PROTOCOL = 'gugo.desktop-file-target.v1'

export function isDesktopBridgeSecret(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
}

function messageSignature(payload, secret) {
  if (!isDesktopBridgeSecret(secret)) throw desktopFileError('DESKTOP_FILE_BRIDGE_UNAVAILABLE')
  return createHmac('sha256', secret).update(JSON.stringify(payload, (_key, value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]]))
  })).digest('hex')
}

export function signDesktopFileMessage(payload, secret) {
  const message = { protocol: PROTOCOL, ...payload }
  return { ...message, signature: messageSignature(message, secret) }
}

export function verifyDesktopFileMessage(value, secret, { nonce, now = Date.now() } = {}) {
  const { signature, ...message } = value && typeof value === 'object' ? value : {}
  const expected = messageSignature(message, secret)
  if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/u.test(signature)
    || !timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))
    || message.protocol !== PROTOCOL || !/^[a-f0-9]{32}$/u.test(message.nonce || '')
    || (nonce && nonce !== message.nonce) || !Number.isSafeInteger(message.issuedAt)
    || message.issuedAt < now - 10_000 || message.issuedAt > now + 1_000) {
    throw desktopFileError('DESKTOP_FILE_SERVICE_UNTRUSTED')
  }
  return message
}

export function desktopFileStatFingerprint(stat) {
  return [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':')
}
