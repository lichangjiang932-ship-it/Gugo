import {
  assertCurrentSchemaContract,
  databaseSchemaIncompleteError,
} from './dbSchemaContract.js'

export { assertCurrentSchemaContract } from './dbSchemaContract.js'

function schemaVersionError(code, message) {
  return Object.assign(new Error(message), {
    code,
    retryable: false,
  })
}

export function preflightExistingSchemaVersion(db, supportedVersion) {
  const applicationObjects = db.prepare(`
    SELECT type, name FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `).all()
  const hasMetaTable = applicationObjects.some(
    (object) => object.type === 'table' && object.name === 'meta',
  )
  if (!hasMetaTable) {
    if (applicationObjects.length === 0) return
    throw databaseSchemaIncompleteError({
      expectedVersion: supportedVersion,
      stage: 'preflight',
      missing: ['table:meta'],
    })
  }

  const metaColumns = new Set(
    db.prepare('SELECT name FROM pragma_table_info(?)').all('meta').map((row) => row.name),
  )
  const missingMetaColumns = ['key', 'value'].filter((column) => !metaColumns.has(column))
  if (missingMetaColumns.length > 0) {
    throw databaseSchemaIncompleteError({
      expectedVersion: supportedVersion,
      stage: 'preflight',
      missing: missingMetaColumns.map((column) => `column:meta.${column}`),
    })
  }

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
  if (version === supportedVersion) {
    assertCurrentSchemaContract(db, supportedVersion, { stage: 'preflight' })
  }
}
