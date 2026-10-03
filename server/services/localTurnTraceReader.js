/** Read an existing runtime without initializing data, identity, credentials or SQLite sidecars. */
import fs from 'node:fs'
import path from 'node:path'
import { DB_SCHEMA_VERSION } from '../db.js'
import { assertCurrentSchemaContract } from '../dbSchemaContract.js'
import { getLocalOwnerUserId, resolveAuthMode } from '../adapters/authAccount.js'
import { withDiagnosticRuntimeScope } from '../core/diagnosticRuntimeScope.js'
import { resolveRuntimeStartupEnvironment, resolveRuntimeStartupConfigPaths } from '../utils/runtimeEnv.js'
import { openDoctorDatabaseReader } from './headlessDoctorDatabaseReader.js'

function traceReaderError(code) {
  return Object.assign(new Error('Read-only trace inspection is unavailable.'), { code, retryable: false })
}

function assertReadableTraceSchema(db) {
  const meta = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'").get()
  if (!meta) throw traceReaderError('TRACE_DATABASE_NOT_INITIALIZED')
  const raw = db.prepare('SELECT value FROM meta WHERE key=?').get('schema_version')?.value
  const version = typeof raw === 'string' && raw.trim() ? Number(raw) : Number.NaN
  if (!Number.isSafeInteger(version) || version < 0) throw traceReaderError('TRACE_SCHEMA_VERSION_INVALID')
  if (version < DB_SCHEMA_VERSION) throw traceReaderError('TRACE_MIGRATION_REQUIRED')
  if (version > DB_SCHEMA_VERSION) throw traceReaderError('TRACE_SCHEMA_VERSION_UNSUPPORTED')
  assertCurrentSchemaContract(db, DB_SCHEMA_VERSION, { stage: 'trace_read_only' })
}

/** Diagnostic callbacks use an async-scoped reader, never the normal writable singleton. */
export async function withLocalTurnTraceReader({ cwd, env }, read) {
  const options = { cwd, env, warnOnMissingDotEnv: false }
  const paths = resolveRuntimeStartupConfigPaths(options)
  const journal = path.join(path.dirname(paths.user), `.${path.basename(paths.user)}.evolution-config.pending.json`)
  if (fs.existsSync(journal)) throw traceReaderError('TRACE_RECOVERY_REQUIRED')
  const runtimeEnv = resolveRuntimeStartupEnvironment(options)
  if (resolveAuthMode(runtimeEnv) !== 'local') throw traceReaderError('AUTH_REQUIRED')
  // The shared diagnostic reader rejects live WAL/hot journals and uses an
  // immutable connection or bounded memory image, without creating WAL/SHM.
  const reader = await openDoctorDatabaseReader(runtimeEnv.APP_DB_PATH)
  try {
    return await withDiagnosticRuntimeScope({ database: reader.database, env: runtimeEnv }, async () => {
      assertReadableTraceSchema(reader.database)
      const userId = getLocalOwnerUserId(runtimeEnv)
      if (!userId) throw traceReaderError('TRACE_LOCAL_IDENTITY_NOT_INITIALIZED')
      const result = await read({ userId, env: runtimeEnv, databaseReadMode: reader.mode })
      if (!reader.unchanged()) throw traceReaderError('TRACE_DATABASE_CHANGED')
      return result
    })
  } finally { reader.database.close() }
}

/** Only expose a stable code; no raw SQL, configuration contents or filesystem error text. */
export function localTraceReadFailure(error) {
  const raw = String(error?.code || '')
  const code = /^[A-Z][A-Z0-9_]{1,127}$/u.test(raw) ? raw.replace(/^DOCTOR_/u, 'TRACE_') : 'TRACE_READ_ONLY_UNAVAILABLE'
  const action = code === 'AUTH_REQUIRED' ? 'use_authenticated_service'
    : ['TRACE_DATABASE_NOT_INITIALIZED', 'TRACE_LOCAL_IDENTITY_NOT_INITIALIZED'].includes(code) ? 'initialize_runtime'
      : code === 'TRACE_MIGRATION_REQUIRED' ? 'migrate_runtime'
        : code === 'TRACE_DATABASE_CHANGED' ? 'retry_read_only_inspection'
          : 'check_runtime_state'
  return { code, action }
}
