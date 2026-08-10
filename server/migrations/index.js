import { migrateToV31 } from './v31McpOAuth.js'
import { migrateToV32 } from './v32WorkspaceTrust.js'
import { migrateToV33 } from './v33ProviderRiskOverrides.js'
import { migrateToV34 } from './v34TurnEventRetention.js'
import { migrateToV35 } from './v35SecurityState.js'
import { migrateToV36 } from './v36MessageModelContext.js'
import { migrateToV37 } from './v37SessionRevision.js'
import { migrateToV38 } from './v38JobExecutionLeases.js'
import { migrateToV39 } from './v39ConnectorIdempotency.js'
import { migrateToV40 } from './v40SessionPinning.js'
import { migrateToV41 } from './v41WebSearchConfig.js'
import { migrateToV42 } from './v42ManagedAttachments.js'
import { migrateToV43 } from './v43TurnExecutionLeases.js'
import { migrateToV44 } from './v44TurnSteering.js'

export { migrateToV31, migrateToV32, migrateToV33, migrateToV34, migrateToV35, migrateToV36, migrateToV37, migrateToV38, migrateToV39, migrateToV40, migrateToV41, migrateToV42, migrateToV43, migrateToV44 }

/**
 * V2-V30 stay in db.js for upgrade compatibility. New migrations are registered
 * here so ordering and the latest schema version have one source of truth.
 */
export const schemaMigrations = Object.freeze([
  { version: 31, up: migrateToV31 },
  { version: 32, up: migrateToV32 },
  { version: 33, up: migrateToV33 },
  { version: 34, up: migrateToV34 },
  { version: 35, up: migrateToV35 },
  { version: 36, up: migrateToV36 },
  { version: 37, up: migrateToV37 },
  { version: 38, up: migrateToV38 },
  { version: 39, up: migrateToV39 },
  { version: 40, up: migrateToV40 },
  { version: 41, up: migrateToV41 },
  { version: 42, up: migrateToV42 },
  { version: 43, up: migrateToV43 },
  { version: 44, up: migrateToV44 },
])

export const LATEST_SCHEMA_VERSION = schemaMigrations.at(-1)?.version || 30

export function createSchemaMigrationPlan(legacyMigrations = []) {
  const plan = [...legacyMigrations, ...schemaMigrations]
    .map((migration) => ({ ...migration }))
    .sort((left, right) => left.version - right.version)

  for (let index = 0; index < plan.length; index += 1) {
    const migration = plan[index]
    if (!Number.isInteger(migration.version) || migration.version < 2 || typeof migration.up !== 'function') {
      throw new TypeError(`Invalid schema migration at index ${index}`)
    }
    if (index > 0 && migration.version !== plan[index - 1].version + 1) {
      throw new Error(`Schema migrations must be contiguous; found v${plan[index - 1].version} then v${migration.version}`)
    }
  }
  return plan
}

export function runSchemaMigrations(db, { legacyMigrations = [] } = {}) {
  const readVersion = () => {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')
    return row ? Number(row.value) : 0
  }
  const writeVersion = (version) => db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run('schema_version', String(version))

  let currentVersion = readVersion()
  for (const migration of createSchemaMigrationPlan(legacyMigrations)) {
    if (currentVersion >= migration.version) continue
    migration.up(db)
    // The runner owns version advancement. Legacy migrations may also write the
    // same value until they are eventually extracted from db.js.
    writeVersion(migration.version)
    currentVersion = migration.version
  }
  return currentVersion
}

export function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column)
}
