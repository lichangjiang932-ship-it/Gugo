/** Default Doctor composition: inspect existing runtime state without bootstrapping it. */
import fs from 'node:fs'
import path from 'node:path'
import Database from '../adapters/sqliteDriver.js'
import { DB_SCHEMA_VERSION } from '../db.js'
import { assertCurrentSchemaContract } from '../dbSchemaContract.js'
import { withDiagnosticRuntimeScope } from '../core/diagnosticRuntimeScope.js'
import { getLocalOwnerUserId, resolveAuthMode } from '../adapters/authAccount.js'
import { resolveRuntimeStartupConfigPaths, resolveRuntimeStartupEnvironment } from '../utils/runtimeEnv.js'
import { readRuntimePluginConfigSourceSnapshot } from '../plugins/runtimePluginConfigFile.js'
import { collectHeadlessDoctorDiagnostics } from './headlessDoctorDiagnostics.js'
import { assertNoDoctorSqliteRecovery, openDoctorDatabaseReader } from './headlessDoctorDatabaseReader.js'

function failure(code, action, status, message) {
  return { code, action, status, message }
}

function pendingJournal({ cwd, env }) {
  const target = resolveRuntimeStartupConfigPaths({ cwd, env }).user
  const journal = path.join(path.dirname(target), `.${path.basename(target)}.evolution-config.pending.json`)
  try { fs.lstatSync(journal); return true } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

function schemaState(db) {
  try {
    const meta = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta' LIMIT 1").get()
    if (!meta) return { status: 'not_initialized', code: 'DOCTOR_DATABASE_NOT_INITIALIZED', expectedVersion: DB_SCHEMA_VERSION }
    const rawVersion = db.prepare('SELECT value FROM meta WHERE key=? LIMIT 1').get('schema_version')?.value
    const version = typeof rawVersion === 'string' && !rawVersion.trim() ? Number.NaN : Number(rawVersion)
    if (!Number.isSafeInteger(version) || version < 0) return { status: 'failed', code: 'DB_SCHEMA_VERSION_INVALID', expectedVersion: DB_SCHEMA_VERSION }
    if (version < DB_SCHEMA_VERSION) return { status: 'migration_required', version, expectedVersion: DB_SCHEMA_VERSION, code: 'DOCTOR_MIGRATION_REQUIRED' }
    if (version > DB_SCHEMA_VERSION) return { status: 'failed', version, expectedVersion: DB_SCHEMA_VERSION, code: 'DB_SCHEMA_VERSION_UNSUPPORTED' }
    assertCurrentSchemaContract(db, DB_SCHEMA_VERSION, { stage: 'doctor_read_only' })
    return { status: 'passed', version, expectedVersion: DB_SCHEMA_VERSION }
  } catch (error) {
    return { status: 'failed', code: String(error?.code || 'DB_SCHEMA_INCOMPLETE'), expectedVersion: DB_SCHEMA_VERSION }
  }
}

function openProbeDatabase(env) {
  assertNoDoctorSqliteRecovery(env.APP_DB_PATH)
  const db = new Database(env.APP_DB_PATH, { fileMustExist: true })
  try {
    db.pragma('busy_timeout = 1000')
    return db
  } catch (error) { db.close(); throw error }
}

function localIdentity(env) {
  const mode = resolveAuthMode(env)
  const userId = mode === 'local' ? getLocalOwnerUserId(env) : null
  return { authenticated: !!userId, mode, ...(userId ? { user: { id: userId } } : {}) }
}

async function blockedReport(options, runReport, runtimeEnv, blocked, diagnostics) {
  const report = await runReport({
    preflight: () => {
      if (!runtimeEnv) throw Object.assign(new Error('Read-only runtime configuration unavailable'), { code: blocked.code })
      return { runtimeEnv }
    },
    auth: () => ({ authenticated: false }),
  })
  report.blocking = { code: blocked.code, action: blocked.action, message: blocked.message }
  report.diagnostics = diagnostics || collectHeadlessDoctorDiagnostics({
    env: runtimeEnv || options.env, runtimeCwd: options.runtimeCwd,
    integrity: options.integrity, databaseStatus: blocked.status,
  }, options.diagnosticDependencies)
  return report
}

export async function runDefaultReadOnlyDoctor(options, runReport) {
  let runtimeEnv
  let db = null
  let reader = null
  try {
    const pending = pendingJournal({ cwd: options.runtimeCwd, env: options.env })
    if (pending) return await blockedReport(options, runReport, null, failure('DOCTOR_RECOVERY_REQUIRED',
      'recover_runtime_config', 'recovery_required', '检测到待恢复的运行时配置事务；Doctor 不会自动恢复或修改它，请先完成运行时恢复。'))
    runtimeEnv = resolveRuntimeStartupEnvironment({ cwd: options.runtimeCwd, env: options.env })
    readRuntimePluginConfigSourceSnapshot({ cwd: options.runtimeCwd, env: runtimeEnv })
    try {
      const stat = fs.statSync(runtimeEnv.APP_DB_PATH)
      if (!stat.isFile()) throw Object.assign(new Error('Database path is not a file'), { code: 'DOCTOR_DATABASE_PATH_INVALID' })
      if (options.probe) db = openProbeDatabase(runtimeEnv)
      else {
        reader = await openDoctorDatabaseReader(runtimeEnv.APP_DB_PATH, { integrity: options.integrity })
        db = reader.database
      }
    } catch (error) {
      const missing = error?.code === 'ENOENT' || error?.code === 'DOCTOR_DATABASE_NOT_INITIALIZED'
      return await blockedReport(options, runReport, runtimeEnv, failure(missing ? 'DOCTOR_DATABASE_NOT_INITIALIZED'
        : String(error?.code || 'DOCTOR_DATABASE_UNAVAILABLE'), missing ? 'initialize_runtime' : 'check_database', missing ? 'not_initialized' : 'unavailable',
      missing ? '本地数据库尚不可用；Doctor 不会创建或迁移数据库，请正常初始化本地运行时后重试。'
        : '无法无副作用地读取当前数据库（例如活跃 WAL 或待恢复日志）；请使用运行中服务的 doctor，或正常关闭运行时后重试。'))
    }
    const schema = schemaState(db)
    if (schema.status !== 'passed') {
      const diagnostics = collectHeadlessDoctorDiagnostics({ db, env: runtimeEnv, integrity: options.integrity,
        runtimeCwd: options.runtimeCwd }, options.diagnosticDependencies)
      diagnostics.sqlite.status = schema.status
      diagnostics.sqlite.schema = schema
      return await blockedReport(options, runReport, runtimeEnv, failure(schema.code,
        schema.status === 'migration_required' ? 'migrate_runtime' : 'check_database', schema.status,
        '数据库版本或结构需要处理；Doctor 只读检查，不自动迁移或修复数据。'), diagnostics)
    }
    return await withDiagnosticRuntimeScope({ database: db, env: runtimeEnv }, async () => {
      const identity = await (options.auth || (() => localIdentity(runtimeEnv)))({ token: '', env: runtimeEnv })
      if (!identity?.authenticated || !identity?.user?.id) {
        const mode = resolveAuthMode(runtimeEnv)
        const diagnostics = collectHeadlessDoctorDiagnostics({ db, env: runtimeEnv, runtimeCwd: options.runtimeCwd,
          integrity: options.integrity }, options.diagnosticDependencies)
        diagnostics.sqlite.schema = schema
        return blockedReport(options, runReport, runtimeEnv, failure(mode === 'local' ? 'DOCTOR_LOCAL_IDENTITY_NOT_INITIALIZED' : 'AUTH_REQUIRED',
          mode === 'local' ? 'initialize_runtime' : 'login', 'not_initialized',
          mode === 'local' ? '本机身份尚未初始化；Doctor 不会创建账户或登录会话，请正常启动本地运行时后重试。' : '多用户部署需要已有有效身份。'), diagnostics)
      }
      const report = await runReport({ preflight: () => ({ runtimeEnv }), auth: () => identity })
      report.diagnostics ||= collectHeadlessDoctorDiagnostics({ db, env: runtimeEnv, userId: identity.user.id,
        model: report.model, runtimeCwd: options.runtimeCwd, integrity: options.integrity }, options.diagnosticDependencies)
      report.diagnostics.sqlite.schema = schema
      report.runtime.preflightMode = options.probe ? 'explicit_probe_existing_runtime' : 'read_only_existing_runtime'
      report.runtime.databaseReadMode = reader?.mode || 'explicit_probe_read_write'
      report.runtime.credentialWritesAllowed = false
      report.runtime.probeWritesRequested = options.probe === true
      if (reader && !reader.unchanged()) {
        report.ok = false
        report.diagnostics.sqlite.status = 'not_checked'
        report.diagnostics.sqlite.sourceChanged = true
        report.blocking = { code: 'DOCTOR_DATABASE_CHANGED', action: 'retry_read_only_inspection',
          message: '数据库在诊断期间发生变化；本次结果不能证明当前运行时状态，请重试。' }
      }
      return report
    })
  } catch (error) {
    return await blockedReport(options, runReport, runtimeEnv, failure(String(error?.code || 'DOCTOR_READ_ONLY_UNAVAILABLE'),
      'check_runtime_config', 'unavailable', '无法安全完成只读诊断；未回退到初始化或凭据写入路径。'))
  } finally { db?.close() }
}
