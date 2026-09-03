import { migrateToV1 } from './v1InitialSchema.js'
import { LEGACY_SCHEMA_MIGRATIONS } from './legacyCompatibility.js'
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
import { migrateToV57 } from './v57EventWriteFailures.js'
import { migrateToV58 } from './v58CronTaskGrants.js'
import { migrateToV59 } from './v59SessionBranches.js'
import { migrateToV60 } from './v60RuntimePluginStates.js'
import { migrateToV61 } from './v61EvolutionEvidence.js'
import { migrateToV62 } from './v62EvolutionExclusions.js'
import { migrateToV63 } from './v63EvolutionCandidates.js'
import { migrateToV64 } from './v64EvolutionReplay.js'
import { migrateToV65 } from './v65EvolutionEvaluations.js'
import { migrateToV66 } from './v66EvolutionApprovals.js'
import { migrateToV67 } from './v67EvolutionCanaries.js'
import { migrateToV68 } from './v68EvolutionCanaryRollback.js'
import { migrateToV69 } from './v69TurnRecoveryStates.js'
import { migrateToV70 } from './v70ModelProviderReadiness.js'
import { migrateToV71 } from './v71EvolutionModelProviders.js'
import { migrateToV72 } from './v72SubagentModelBindings.js'
import { migrateToV73 } from './v73EvolutionModelRevisions.js'
import { migrateToV74 } from './v74RuntimePluginReleases.js'
import { migrateToV75 } from './v75RuntimePluginReleaseRevision.js'
import { migrateToV76 } from './v76RuntimePluginReleaseContentIdentity.js'
import { migrateToV77 } from './v77UserDataClearOperations.js'
import { migrateToV78 } from './v78RuntimePluginReleaseRetention.js'
import { migrateToV79 } from './v79SideEffectExecutions.js'
import { migrateToV80 } from './v80SideEffectRecoveryMetadata.js'
import { migrateToV81 } from './v81EvolutionPromotions.js'
import { migrateToV82 } from './v82EvolutionOnlineGrades.js'
import { migrateToV83 } from './v83EvolutionPromotionOnlineGrades.js'
import { migrateToV84 } from './v84EvolutionConfigChanges.js'
import { migrateToV85 } from './v85ModelRequestRecovery.js'
import { migrateToV86 } from './v86JobModelRequestRecovery.js'
import { migrateToV87 } from './v87TurnEventFailureRecovery.js'
import { migrateToV88 } from './v88EvolutionOperations.js'
import { migrateToV89 } from './v89EvolutionOperationLeases.js'
import { migrateToV90 } from './v90EvolutionOperationRecoveryChallenge.js'
import { migrateToV91 } from './v91PendingApprovalPolicyProvenance.js'
import { migrateToV92 } from './v92HookSideEffectExecutions.js'
import { migrateToV93 } from './v93TurnExecutionFencing.js'
import { migrateToV94 } from './v94SessionContentOutbox.js'
import { migrateToV95 } from './v95RetiredAccountFields.js'
import { migrateToV96 } from './v96SideEffectRecoveryPlans.js'
import { migrateToV97 } from './v97CompactionArchiveStorage.js'
import { migrateToV98 } from './v98ManagedAttachmentUploadLeases.js'
import { migrateToV99 } from './v99CompactionArchiveGovernanceJournal.js'
import { migrateToV100 } from './v100RuntimePluginPermissionGrants.js'
import { migrateToV101 } from './v101RuntimePluginPermissionOwners.js'
import { migrateToV102 } from './v102FileSnapshotAfterIdentity.js'
import { migrateToV103 } from './v103RuntimePluginMutationBarrier.js'
import { migrateToV104 } from './v104RuntimePluginMutationRecoveryReceipts.js'
import { migrateToV105 } from './v105RuntimePluginMutationBarrierHardening.js'
import { migrateToV106 } from './v106EvolutionAutoLoop.js'
import { migrateToV107 } from './v107SchemaContractRepair.js'
import { migrateToV108 } from './v108UnifiedBootstrapSchema.js'
import { migrateToV109 } from './v109SessionWorkspacePath.js'
import { migrateToV110 } from './v110JobAutoRetry.js'
import { migrateToV111 } from './v111JobEventLocalization.js'
import { migrateToV112 } from './v112JobAutoRetryWakeClaims.js'
import { migrateToV113 } from './v113AgentEventOutbox.js'
import { migrateToV114 } from './v114AgentEventSubscriptions.js'

export { migrateToV1, migrateToV31, migrateToV32, migrateToV33, migrateToV34, migrateToV35, migrateToV36, migrateToV37, migrateToV38, migrateToV39, migrateToV40, migrateToV41, migrateToV42, migrateToV43, migrateToV44, migrateToV45, migrateToV46, migrateToV47, migrateToV48, migrateToV49, migrateToV50, migrateToV51, migrateToV52, migrateToV53, migrateToV54, migrateToV55, migrateToV56, migrateToV57, migrateToV58, migrateToV59, migrateToV60, migrateToV61, migrateToV62, migrateToV63, migrateToV64, migrateToV65, migrateToV66, migrateToV67, migrateToV68, migrateToV69, migrateToV70, migrateToV71, migrateToV72, migrateToV73, migrateToV74, migrateToV75, migrateToV76, migrateToV77, migrateToV78, migrateToV79, migrateToV80, migrateToV81, migrateToV82, migrateToV83, migrateToV84, migrateToV85, migrateToV86, migrateToV87, migrateToV88, migrateToV89, migrateToV90, migrateToV91, migrateToV92, migrateToV93, migrateToV94, migrateToV95, migrateToV96, migrateToV97, migrateToV98, migrateToV99, migrateToV100, migrateToV101, migrateToV102, migrateToV103, migrateToV104, migrateToV105, migrateToV106, migrateToV107, migrateToV108, migrateToV109, migrateToV110, migrateToV111, migrateToV112, migrateToV113, migrateToV114 }

/**
 * V2-V30 remain isolated behind the legacy compatibility adapter. The primary
 * registry owns empty-database bootstrap and every current migration.
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
  { version: 57, up: migrateToV57 },
  { version: 58, up: migrateToV58 },
  { version: 59, up: migrateToV59 },
  { version: 60, up: migrateToV60 },
  { version: 61, up: migrateToV61 },
  { version: 62, up: migrateToV62 },
  { version: 63, up: migrateToV63 },
  { version: 64, up: migrateToV64 },
  { version: 65, up: migrateToV65 },
  { version: 66, up: migrateToV66 },
  { version: 67, up: migrateToV67 },
  { version: 68, up: migrateToV68 },
  { version: 69, up: migrateToV69 },
  { version: 70, up: migrateToV70 },
  { version: 71, up: migrateToV71 },
  { version: 72, up: migrateToV72 },
  { version: 73, up: migrateToV73 },
  { version: 74, up: migrateToV74 },
  { version: 75, up: migrateToV75 },
  { version: 76, up: migrateToV76 },
  { version: 77, up: migrateToV77 },
  { version: 78, up: migrateToV78 },
  { version: 79, up: migrateToV79 },
  { version: 80, up: migrateToV80 },
  { version: 81, up: migrateToV81 },
  { version: 82, up: migrateToV82 },
  { version: 83, up: migrateToV83 },
  { version: 84, up: migrateToV84 },
  { version: 85, up: migrateToV85 },
  { version: 86, up: migrateToV86 },
  { version: 87, up: migrateToV87 },
  { version: 88, up: migrateToV88 },
  { version: 89, up: migrateToV89 },
  { version: 90, up: migrateToV90 },
  { version: 91, up: migrateToV91 },
  { version: 92, up: migrateToV92 },
  { version: 93, up: migrateToV93 },
  { version: 94, up: migrateToV94 },
  { version: 95, up: migrateToV95, atomicWithVersion: true },
  { version: 96, up: migrateToV96 },
  { version: 97, up: migrateToV97, atomicWithVersion: true },
  { version: 98, up: migrateToV98 },
  { version: 99, up: migrateToV99, atomicWithVersion: true },
  { version: 100, up: migrateToV100 },
  { version: 101, up: migrateToV101, atomicWithVersion: true },
  { version: 102, up: migrateToV102, atomicWithVersion: true },
  { version: 103, up: migrateToV103, atomicWithVersion: true },
  { version: 104, up: migrateToV104, atomicWithVersion: true },
  { version: 105, up: migrateToV105, atomicWithVersion: true },
  { version: 106, up: migrateToV106, atomicWithVersion: true },
  { version: 107, up: migrateToV107, atomicWithVersion: true },
  { version: 108, up: migrateToV108, atomicWithVersion: true },
  { version: 109, up: migrateToV109, atomicWithVersion: true },
  { version: 110, up: migrateToV110, atomicWithVersion: true },
  { version: 111, up: migrateToV111, atomicWithVersion: true },
  { version: 112, up: migrateToV112, atomicWithVersion: true },
  { version: 113, up: migrateToV113, atomicWithVersion: true },
  { version: 114, up: migrateToV114, atomicWithVersion: true },
])

export const LATEST_SCHEMA_VERSION = schemaMigrations.at(-1)?.version || 30

function schemaVersionError(code, message) {
  return Object.assign(new Error(message), {
    code,
    retryable: false,
  })
}

function validatedCurrentSchemaVersion(row) {
  if (!row) return 0
  const rawVersion = row.value
  const version = typeof rawVersion === 'string' && rawVersion.trim() === ''
    ? Number.NaN
    : Number(rawVersion)
  if (!Number.isFinite(version) || !Number.isInteger(version) || version < 0) {
    throw schemaVersionError(
      'DB_SCHEMA_VERSION_INVALID',
      'Database schema_version must be a finite non-negative integer.',
    )
  }
  if (version > LATEST_SCHEMA_VERSION) {
    throw schemaVersionError(
      'DB_SCHEMA_VERSION_UNSUPPORTED',
      `Database schema version ${version} is newer than supported version ${LATEST_SCHEMA_VERSION}.`,
    )
  }
  return version
}

export function createSchemaMigrationPlan(legacyMigrations = LEGACY_SCHEMA_MIGRATIONS) {
  const plan = [{ version: 1, up: migrateToV1, atomicWithVersion: true }, ...legacyMigrations, ...schemaMigrations]
    .map((migration) => ({ ...migration }))
    .sort((left, right) => left.version - right.version)

  for (let index = 0; index < plan.length; index += 1) {
    const migration = plan[index]
    if (!Number.isInteger(migration.version) || migration.version < 1 || typeof migration.up !== 'function') {
      throw new TypeError(`Invalid schema migration at index ${index}`)
    }
    if (index > 0 && migration.version !== plan[index - 1].version + 1) {
      throw new Error(`Schema migrations must be contiguous; found v${plan[index - 1].version} then v${migration.version}`)
    }
  }
  return plan
}

export function runSchemaMigrations(db, { legacyMigrations = LEGACY_SCHEMA_MIGRATIONS } = {}) {
  const readVersion = () => {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')
    return validatedCurrentSchemaVersion(row)
  }
  const writeVersion = (version) => db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run('schema_version', String(version))

  const plan = createSchemaMigrationPlan(legacyMigrations)
  let currentVersion = hasTable(db, 'meta') ? readVersion() : 0
  // Historical v1 databases were allowed to omit part of the bootstrap
  // contract. Replaying the idempotent v1 entry preserves that compatibility
  // without keeping an out-of-band initializer in db.js.
  if (currentVersion === 1) {
    db.transaction(() => migrateToV1(db)).immediate()
  }
  for (const migration of plan) {
    if (currentVersion >= migration.version) continue
    const applyMigration = () => {
      migration.up(db)
      // The runner owns version advancement. Legacy migrations may also write
      // the same value until they are eventually extracted from db.js.
      writeVersion(migration.version)
    }
    if (migration.atomicWithVersion) {
      db.transaction(applyMigration).immediate()
    } else {
      applyMigration()
    }
    currentVersion = migration.version
  }
  return currentVersion
}

export function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column)
}

export function hasTable(db, table) {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table))
}
