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
import { migrateToV45 } from './v45ModelProfiles.js'
import { migrateToV46 } from './v46FileSnapshots.js'
import { migrateToV47 } from './v47BackgroundProcesses.js'
import { migrateToV48 } from './v48HooksEvents.js'
import { migrateToV49 } from './v49HookArgumentMatcher.js'
import { migrateToV50 } from './v50DefaultExecutionPermissions.js'
import { migrateToV51 } from './v51TurnCheckpoints.js'
import { migrateToV52 } from './v52DefaultOutputDirectory.js'
import { migrateToV53 } from './v53PermissionModeEvents.js'
import { migrateToV54 } from './v54ApprovalMetadataSource.js'
import { migrateToV55 } from './v55ToolAuditLifecycle.js'
import { migrateToV56 } from './v56McpToolRiskDeclarations.js'

export { migrateToV31, migrateToV32, migrateToV33, migrateToV34, migrateToV35, migrateToV36, migrateToV37, migrateToV38, migrateToV39, migrateToV40, migrateToV41, migrateToV42, migrateToV43, migrateToV44, migrateToV45, migrateToV46, migrateToV47, migrateToV48, migrateToV49, migrateToV50, migrateToV51, migrateToV52, migrateToV53, migrateToV54, migrateToV55, migrateToV56 }

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
  { version: 45, up: migrateToV45 },
  { version: 46, up: migrateToV46 },
  { version: 47, up: migrateToV47 },
  { version: 48, up: migrateToV48 },
  { version: 49, up: migrateToV49 },
  { version: 50, up: migrateToV50 },
  { version: 51, up: migrateToV51 },
  { version: 52, up: migrateToV52 },
  { version: 53, up: migrateToV53 },
  { version: 54, up: migrateToV54 },
  { version: 55, up: migrateToV55 },
  { version: 56, up: migrateToV56 },
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
