import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  timingSafeEqual,
  verify as verifySignature,
} from 'node:crypto'
import { claimWebhookDelivery } from '../services/webhookReplayStore.js'

const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000
const ED25519_SEED_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

function verificationError(message, code = 'WEBHOOK_UNAUTHORIZED', statusCode = 401) {
  const error = new Error(message)
  error.statusCode = statusCode
  error.code = code
  return error
}

function header(headers, name) {
  const value = headers?.[name.toLowerCase()]
  return Array.isArray(value) ? String(value[0] || '').trim() : String(value || '').trim()
}

function equalSecret(actual, expected) {
  const left = Buffer.from(String(actual || ''), 'utf8')
  const right = Buffer.from(String(expected || ''), 'utf8')
  return left.length > 0 && left.length === right.length && timingSafeEqual(left, right)
}

function assertFreshTimestamp(value, now) {
  const raw = Number(value)
  if (!Number.isFinite(raw) || raw <= 0) throw verificationError('webhook timestamp missing or invalid')
  const timestampMs = raw < 1e12 ? raw * 1000 : raw
  if (Math.abs(now - timestampMs) > MAX_SIGNATURE_AGE_MS) {
    throw verificationError('webhook timestamp expired', 'WEBHOOK_TIMESTAMP_EXPIRED')
  }
  return timestampMs
}

function verifyTelegram({ headers, integration }) {
  const expected = integration?.secret?.webhookSecret || integration?.secret?.secretToken
  if (!expected) throw verificationError('Telegram webhook secret is not configured', 'WEBHOOK_SECRET_NOT_CONFIGURED')
  const actual = header(headers, 'x-telegram-bot-api-secret-token')
  if (!equalSecret(actual, expected)) throw verificationError('Telegram webhook secret is invalid')
}

function verifyFeishu({ headers, rawBody, body, integration, now }) {
  const verificationToken = integration?.secret?.verificationToken
  const requestToken = body?.token || body?.header?.token
  if (verificationToken && requestToken && equalSecret(requestToken, verificationToken)) return

  const encryptKey = integration?.secret?.encryptKey
  const timestamp = header(headers, 'x-lark-request-timestamp')
  const nonce = header(headers, 'x-lark-request-nonce')
  const signature = header(headers, 'x-lark-signature')
  if (encryptKey && timestamp && nonce && signature) {
    assertFreshTimestamp(timestamp, now)
    const expected = createHash('sha256')
      .update(`${timestamp}${nonce}${encryptKey}${rawBody}`)
      .digest('hex')
    if (equalSecret(signature.toLowerCase(), expected)) return
  }

  if (!verificationToken && !encryptKey) {
    throw verificationError('Feishu verification token or encrypt key is not configured', 'WEBHOOK_SECRET_NOT_CONFIGURED')
  }
  throw verificationError('Feishu webhook signature is invalid')
}

function qqPublicKey(secret) {
  let seedText = String(secret || '')
  if (!seedText) return null
  while (Buffer.byteLength(seedText, 'utf8') < 32) seedText += seedText
  const seed = Buffer.from(seedText, 'utf8').subarray(0, 32)
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_SEED_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  })
  return createPublicKey(privateKey)
}

function verifyQQ({ headers, rawBody, integration, now }) {
  const secret = integration?.secret?.appSecret || integration?.secret?.clientSecret
  if (!secret) throw verificationError('QQ app secret is not configured', 'WEBHOOK_SECRET_NOT_CONFIGURED')
  const timestamp = header(headers, 'x-signature-timestamp')
  const signatureHex = header(headers, 'x-signature-ed25519')
  assertFreshTimestamp(timestamp, now)
  if (!/^[a-f0-9]{128}$/i.test(signatureHex)) throw verificationError('QQ webhook signature is invalid')
  const valid = verifySignature(
    null,
    Buffer.from(`${timestamp}${rawBody}`, 'utf8'),
    qqPublicKey(secret),
    Buffer.from(signatureHex, 'hex'),
  )
  if (!valid) throw verificationError('QQ webhook signature is invalid')
}

function verifyHmac({ headers, rawBody, integration, now, claimReplay }) {
  const secret = integration?.secret?.signingSecret
    || integration?.secret?.webhookSecret
    || integration?.secret?.botToken
  if (!secret) throw verificationError('webhook signing secret is not configured', 'WEBHOOK_SECRET_NOT_CONFIGURED')
  const supplied = header(headers, 'x-gugo-signature')
    || header(headers, 'x-signature-256')
    || header(headers, 'x-hub-signature-256')
  const timestamp = header(headers, 'x-gugo-timestamp')
    || header(headers, 'x-webhook-timestamp')
    || header(headers, 'x-signature-timestamp')
  const timestampMs = assertFreshTimestamp(timestamp, now)
  const actual = supplied.replace(/^sha256=/i, '').toLowerCase()
  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')
  // Some existing webhook clients concatenate the timestamp without a separator.
  // It is still replay-safe because the timestamp remains covered by the MAC.
  const compatible = createHmac('sha256', secret).update(`${timestamp}${rawBody}`).digest('hex')
  if (
    !/^[a-f0-9]{64}$/.test(actual)
    || (!equalSecret(actual, expected) && !equalSecret(actual, compatible))
  ) {
    throw verificationError('webhook HMAC signature is invalid')
  }
  const signatureDigest = createHash('sha256')
    .update(`${timestamp}:${actual}`, 'utf8')
    .digest('hex')
  const accepted = claimReplay({
    integrationId: integration.id,
    signatureDigest,
    expiresAt: timestampMs + MAX_SIGNATURE_AGE_MS,
    now,
  })
  if (!accepted) {
    throw verificationError('webhook delivery was already processed', 'WEBHOOK_REPLAYED', 409)
  }
}

export function verifyBridgeWebhook({
  provider,
  headers,
  rawBody,
  body,
  integration,
  now = Date.now(),
  claimReplay = claimWebhookDelivery,
}) {
  if (!integration?.id || !integration.enabled || integration.provider !== provider) {
    throw verificationError('integration is missing, disabled, or does not match provider')
  }
  if (provider === 'telegram') return verifyTelegram({ headers, integration })
  if (provider === 'feishu') return verifyFeishu({ headers, rawBody, body, integration, now })
  if (provider === 'qq') return verifyQQ({ headers, rawBody, integration, now })
  if (provider === 'webhook' || provider === 'wechat' || provider === 'wechat_personal') {
    return verifyHmac({ headers, rawBody, integration, now, claimReplay })
  }
  throw verificationError(`unsupported webhook provider: ${provider}`, 'WEBHOOK_PROVIDER_UNSUPPORTED')
}

export const _webhookVerificationInternals = {
  MAX_SIGNATURE_AGE_MS,
  qqPublicKey,
}
