function schemaVersionError(code, message) {
  return Object.assign(new Error(message), {
    code,
    retryable: false,
  })
}

export function preflightExistingSchemaVersion(db, supportedVersion) {
  const hasMetaTable = Boolean(db.prepare(`
    SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'meta'
  `).get())
  if (!hasMetaTable) return

  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')
  const rawVersion = row?.value
  const version = typeof rawVersion === 'string' && rawVersion.trim() === ''
    ? Number.NaN
    : Number(rawVersion)
  if (!row || !Number.isFinite(version) || !Number.isInteger(version) || version < 0) {
    throw schemaVersionError(
      'DB_SCHEMA_VERSION_INVALID',
      'Database schema_version must be a finite non-negative integer.',
    )
  }
  if (version > supportedVersion) {
    throw schemaVersionError(
      'DB_SCHEMA_VERSION_UNSUPPORTED',
      `Database schema version ${version} is newer than supported version ${supportedVersion}.`,
    )
  }
}
