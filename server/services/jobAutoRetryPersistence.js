export function mapJobAutoRetry(row) {
  return {
    enabled: row.auto_retry_enabled === 1,
    maxAttempts: Math.max(0, Number(row.auto_retry_max_attempts) || 0),
    attempts: Math.max(0, Number(row.auto_retry_attempts) || 0),
    baseDelayMs: Math.max(0, Number(row.auto_retry_base_delay_ms) || 0),
  }
}

export function insertJobWithAutoRetry(db, {
  id,
  userId,
  title,
  prompt,
  modelName,
  modelProviderId,
  modelConfigRevision,
  sourceType,
  sourceId,
  grantsJson,
  status,
  progress,
  now,
}, autoRetry) {
  db.prepare(`
    INSERT INTO jobs (
      id, user_id, title, prompt, model_name, model_provider_id, model_config_revision,
      source_type, source_id, grants_json, status, progress, created_at, updated_at,
      auto_retry_enabled, auto_retry_max_attempts, auto_retry_attempts, auto_retry_base_delay_ms
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
  `).run(
    id,
    userId,
    title,
    prompt,
    modelName,
    modelProviderId,
    modelConfigRevision,
    sourceType,
    sourceId,
    grantsJson,
    status,
    progress,
    now,
    now,
    autoRetry.enabled ? 1 : 0,
    autoRetry.maxAttempts,
    autoRetry.baseDelayMs,
  )
}

export function updateJobAutoRetryAttemptsInDb(
  db,
  id,
  { userId, attempts } = {},
  now = Date.now(),
) {
  const normalizedAttempts = Number(attempts)
  if (!id || !userId || !Number.isInteger(normalizedAttempts) || normalizedAttempts < 0) {
    throw new Error('valid job auto-retry identity and attempts are required')
  }
  return db.prepare(`
    UPDATE jobs SET auto_retry_attempts = ?, updated_at = ?
     WHERE id = ? AND user_id = ?
  `).run(normalizedAttempts, now, id, userId).changes === 1
}
