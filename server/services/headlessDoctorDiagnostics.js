/** Read-only host observations. None of these checks starts a model, MCP server or renderer. */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { resolveMcpStdioCommand } from '../mcp/mcpStdioCommand.js'
import { attachmentRoot } from './managedAttachmentStoreSupport.js'
import { resolveMemoryEmbeddingConfig } from './memoryEmbeddingService.js'
import { resolveModelConfigForModel } from '../adapters/modelProviderConfig.js'
import { resolveEndpointProfile } from '../utils/endpointProfile.js'
import { promptCacheKeyFor } from '../adapters/modelRequestCache.js'
import { redactSensitiveText } from '../../shared/sensitiveText.js'

const require = createRequire(import.meta.url)
export const DOCTOR_DATABASE_CHECK_MAX_BYTES = 16 * 1024 * 1024
const CHECK_ROW_LIMIT = 100

function codeOf(error, fallback) {
  return typeof error?.code === 'string' && /^[A-Z0-9_]{1,100}$/u.test(error.code) ? error.code : fallback
}

function readPackage(name) {
  if (name === 'gugo') return JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
  let directory = path.dirname(require.resolve(name))
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(directory, 'package.json')
    try {
      if (fs.statSync(candidate).size <= 128 * 1024) {
        const manifest = JSON.parse(fs.readFileSync(candidate, 'utf8'))
        if (manifest.name === name) return manifest
      }
    } catch { /* package exports may require walking from the resolved entry */ }
    const parent = path.dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return null
}

function versionParts(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/u.exec(String(value || ''))
  return match ? match.slice(1).map(Number) : null
}

function declaredRangeSupport(version, range) {
  const installed = versionParts(version)
  if (!installed || typeof range !== 'string') return null
  const branches = range.split('||').map((part) => {
    const match = /^(\^|>=|=)?\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/u.exec(part.trim())
    if (!match) return null
    const required = [Number(match[2]), Number(match[3] || 0), Number(match[4] || 0)]
    const compare = installed[0] - required[0] || installed[1] - required[1] || installed[2] - required[2]
    if (match[1] === '>=') return compare >= 0
    if (match[1] === '^' && required[0] > 0) return installed[0] === required[0] && compare >= 0
    return match[1] === '^' ? null : compare === 0
  })
  return branches.includes(true) ? true : branches.includes(null) ? null : false
}

export function inspectDoctorDependencies({ nodeVersion = process.versions.node, readPackageManifest = readPackage } = {}) {
  const load = (name) => { try { return readPackageManifest(name) || null } catch { return null } }
  const host = load('gugo')
  const react = load('react')
  const dom = load('react-dom')
  const ink = load('ink')
  const nodeSupported = declaredRangeSupport(nodeVersion, host?.engines?.node)
  const reactMatched = !!react?.version && !!dom?.version && react.version === dom.version
  const inkNode = ink ? declaredRangeSupport(nodeVersion, ink.engines?.node) : null
  const inkReact = ink ? declaredRangeSupport(react?.version, ink.peerDependencies?.react) : null
  return {
    mode: 'installed_package_metadata', runtimeRenderTested: false,
    node: { version: nodeVersion, required: host?.engines?.node || null,
      status: nodeSupported === true ? 'passed' : nodeSupported === false ? 'failed' : 'not_checked' },
    react: { version: react?.version || null, status: react?.version ? 'passed' : 'unavailable' },
    reactDom: { version: dom?.version || null, reactVersion: react?.version || null,
      status: !dom?.version || !react?.version ? 'unavailable' : reactMatched ? 'passed' : 'failed',
      code: reactMatched ? null : 'REACT_DOM_VERSION_MISMATCH' },
    ink: { version: ink?.version || null, optional: true, fallback: 'readline',
      status: !ink ? 'unavailable' : inkNode === false || inkReact === false ? 'unavailable'
        : inkNode === true && inkReact === true ? 'passed' : 'not_checked',
      nodeSupported: inkNode, reactSupported: inkReact, requiredNode: ink?.engines?.node || null,
      requiredReact: ink?.peerDependencies?.react || null },
  }
}

function databaseCheck(db, pragma) {
  try {
    const rows = db.pragma(`${pragma}(1)`)
    const passed = rows.length === 1 && Object.values(rows[0])[0] === 'ok'
    return { status: passed ? 'passed' : 'failed', checked: true, maxErrors: 1,
      issues: passed ? [] : rows.slice(0, 1).map((row) => redactSensitiveText(String(Object.values(row)[0])).slice(0, 300)) }
  } catch (error) { return { status: 'failed', checked: true, code: codeOf(error, 'SQLITE_CHECK_FAILED') } }
}

export function inspectDoctorDatabase({ db = null, integrity = false, databaseBytes = null, unavailableCode = null } = {}) {
  const skipped = (reason) => ({ status: 'not_checked', checked: false, reason })
  if (!db) return { status: unavailableCode || 'unavailable', quickCheck: skipped('database_unavailable'),
    integrityCheck: skipped('database_unavailable'), foreignKeys: skipped('database_unavailable') }
  let bytes = databaseBytes
  if (bytes == null) {
    try { bytes = Number(db.pragma('page_count', { simple: true })) * Number(db.pragma('page_size', { simple: true })) } catch { bytes = null }
  }
  const bounded = Number.isSafeInteger(bytes) && bytes >= 0 && bytes <= DOCTOR_DATABASE_CHECK_MAX_BYTES
  const permitted = integrity || bounded
  const quickCheck = permitted ? databaseCheck(db, 'quick_check') : skipped('large_or_unknown_database_requires_integrity_opt_in')
  const integrityCheck = integrity ? databaseCheck(db, 'integrity_check')
    : { ...skipped('explicit_integrity_flag_required'), requiredFlag: '--integrity' }
  let foreignKeys = skipped('large_or_unknown_database_requires_integrity_opt_in')
  if (permitted) {
    try {
      const rows = db.prepare('SELECT "table",rowid,parent,fkid FROM pragma_foreign_key_check LIMIT ?').all(CHECK_ROW_LIMIT + 1)
      foreignKeys = { status: rows.length ? 'failed' : 'passed', checked: true,
        violations: rows.slice(0, CHECK_ROW_LIMIT), truncated: rows.length > CHECK_ROW_LIMIT }
    } catch (error) { foreignKeys = { status: 'failed', checked: true, code: codeOf(error, 'SQLITE_FOREIGN_KEY_CHECK_FAILED') } }
  }
  const checks = [quickCheck, integrityCheck, foreignKeys]
  return { status: checks.some((check) => check.status === 'failed') ? 'failed' : quickCheck.status,
    databaseBytes: bytes, defaultCheckMaxBytes: DOCTOR_DATABASE_CHECK_MAX_BYTES,
    quickCheck, integrityCheck, foreignKeys, readOnlyInspection: true }
}

function inspectFts(db) {
  if (!db) return { status: 'not_checked', checked: false, reason: 'database_unavailable' }
  try {
    db.prepare('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ? LIMIT 1').get('"gugo_doctor_fts_metadata_probe"')
    return { status: 'passed', checked: true, mode: 'read_query', indexIntegrity: 'not_checked', indexRebuilt: false }
  } catch (error) { return { status: 'unavailable', checked: true, code: codeOf(error, 'FTS_UNAVAILABLE'), indexRebuilt: false } }
}

function inspectMemoryIndex(db, userId, env) {
  const embedding = resolveMemoryEmbeddingConfig(env)
  const result = { status: 'not_checked', checked: false,
    embedding: { status: embedding ? 'configured_not_probed' : String(env.MEMORY_EMBEDDINGS_ENABLED || '').trim() === '1'
      ? 'configuration_incomplete' : 'disabled', probed: false }, rebuilt: false }
  if (!db || !userId) return { ...result, reason: db ? 'owner_unavailable' : 'database_unavailable' }
  try {
    const rows = db.prepare('SELECT 1 FROM memory_search_pending WHERE user_id = ? LIMIT ?').all(userId, 1001)
    return { ...result, status: rows.length ? 'pending' : 'passed', checked: true,
      pending: Math.min(rows.length, 1000), pendingIsExact: rows.length <= 1000 }
  } catch (error) { return { ...result, status: 'unavailable', code: codeOf(error, 'MEMORY_SEARCH_INDEX_UNAVAILABLE') } }
}

export function inspectDoctorAttachmentStorage(env, { stat = fs.lstatSync, access = fs.accessSync } = {}) {
  const root = attachmentRoot(env)
  let candidate = root
  for (let depth = 0; depth < 32; depth += 1) {
    try {
      const found = stat(candidate)
      if (!found.isDirectory() || found.isSymbolicLink()) return { status: 'failed', root, code: 'ATTACHMENT_STORAGE_PATH_INVALID', writeTested: false }
      access(candidate, fs.constants.W_OK)
      return { status: candidate === root ? 'passed' : 'not_checked', root, exists: candidate === root,
        metadataWritable: true, metadataCheckedPath: candidate, writeTested: false,
        reason: candidate === root ? 'metadata_access_only' : 'directory_not_created' }
    } catch (error) {
      if (error?.code !== 'ENOENT') return { status: 'failed', root, code: codeOf(error, 'ATTACHMENT_STORAGE_UNAVAILABLE'), writeTested: false }
    }
    const parent = path.dirname(candidate)
    if (parent === candidate) break
    candidate = parent
  }
  return { status: 'not_checked', root, reason: 'no_existing_parent_in_budget', writeTested: false }
}

function inspectMcp(env, cwd, dependencies) {
  const resolve = dependencies.resolveMcpCommand || resolveMcpStdioCommand
  const platform = dependencies.platform || process.platform
  const interpreters = ['node', 'npx', 'python', 'uvx'].map((name) => {
    try {
      const result = resolve({ command: name, args: [] }, { platform, cwd, sourceEnv: env })
      return { name, status: platform === 'win32' ? 'passed' : 'not_checked', resolvedCommand: result.command,
        ...(platform === 'win32' ? {} : { reason: 'posix_path_resolution_deferred_to_os' }) }
    } catch (error) { return { name, status: 'unavailable', code: codeOf(error, 'MCP_INTERPRETER_UNAVAILABLE') } }
  })
  return { mode: 'interpreter_resolution_only', processStarted: false, serverProtocolChecked: false, interpreters }
}

export function inspectDoctorCache(env, model) {
  let profile = null
  let routeHint = null
  try {
    const config = resolveModelConfigForModel({ modelName: model?.modelName || '', providerId: model?.providerId || '', env })
    if (config.configured) {
      profile = resolveEndpointProfile({ baseUrl: config.baseUrl, modelName: config.modelName, env, overrides: config.profileOverrides })
      routeHint = !!promptCacheKeyFor({ config, profile, ownerId: 'doctor-capability-only' })
    }
  } catch { /* absent or ambiguous configuration is not a measured capability */ }
  return { status: 'not_observed', networkProbePerformed: false, kvCacheInspected: false,
    cacheReadTokens: null, hitRate: null, endpointKind: profile?.kind || null,
    capabilities: { source: 'endpoint_profile_not_measurement', streamUsage: profile?.supportsStreamUsage ?? null,
      promptCacheRoutingHint: routeHint } }
}

export function collectHeadlessDoctorDiagnostics({ db = null, env = {}, userId = null, model = null,
  runtimeCwd = process.cwd(), integrity = false, databaseStatus = null } = {}, dependencies = {}) {
  if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) dependencies = {}
  return {
    runtimeDependencies: inspectDoctorDependencies(dependencies),
    sqlite: inspectDoctorDatabase({ db, integrity, databaseBytes: dependencies.databaseBytes, unavailableCode: databaseStatus }),
    fts: inspectFts(db), memoryIndex: inspectMemoryIndex(db, userId, env),
    attachments: inspectDoctorAttachmentStorage(env, dependencies.attachmentIo),
    mcp: inspectMcp(env, runtimeCwd, dependencies),
    cache: inspectDoctorCache(env, model),
  }
}

export function doctorDiagnosticsBlocking(diagnostics) {
  if (diagnostics?.sqlite?.status === 'failed') return {
    code: 'DOCTOR_DATABASE_CHECK_FAILED', action: 'check_database',
    message: '数据库检查发现错误；Doctor 没有修改或修复数据，请先核查数据库。',
  }
  if (diagnostics?.runtimeDependencies?.node?.status === 'failed') return {
    code: 'DOCTOR_NODE_VERSION_UNSUPPORTED', action: 'use_supported_node',
    message: '当前 Node.js 版本不满足项目声明的运行要求。',
  }
  if (diagnostics?.runtimeDependencies?.reactDom?.status === 'failed') return {
    code: 'REACT_DOM_VERSION_MISMATCH', action: 'align_runtime_dependencies',
    message: 'React 与 React DOM 的实际安装版本不匹配，请检查依赖安装。',
  }
  return null
}
