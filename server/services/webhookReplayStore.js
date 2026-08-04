import { getDb } from '../db.js'

export function claimWebhookDelivery({ integrationId, signatureDigest, expiresAt, now = Date.now() }) {
  if (!integrationId || !signatureDigest) throw new Error('integrationId and signatureDigest are required')
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return false
  const db = getDb()
  return db.transaction(() => {
    db.prepare('DELETE FROM webhook_replay_guard WHERE expires_at <= ?').run(now)
    const result = db.prepare(`
      INSERT INTO webhook_replay_guard
        (integration_id, signature_digest, expires_at, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(integration_id, signature_digest) DO NOTHING
    `).run(integrationId, signatureDigest, expiresAt, now)
    return result.changes === 1
  })()
}
