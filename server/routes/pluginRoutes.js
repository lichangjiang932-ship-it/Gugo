/**
 * server/routes/pluginRoutes.js
 *
 * 公开 GET 端点 + 受控登录 POST：
 *   GET /api/plugins              → 列出所有 plugin（可选 ?type=ppt-theme 过滤）
 *   GET /api/plugins/:id          → 回环地址上的本地 owner 查看详情 + entry 预览（限 50KB）
 *   GET /api/plugins/runtime      → 本地 owner 的版本化 runtime manifest 清单
 *   POST /api/plugins/runtime/:id/(enable|disable|reload) → 本地 owner 管理 transformer runtime
 *   POST /api/plugins/runtime/:id/config/reload → 本地 owner 原子重载进程内插件配置
 *   POST /api/plugins/:id/run-sandbox → 登录后运行 transformer 沙箱
 *   POST /api/plugins/:id/install-as-skill → 登录后安装 skill-bundle
 */

import { isIP } from 'node:net'
import {
  getPlugin,
  listPlugins,
  listRuntimePluginConfigReloadAudit,
  listRuntimePluginEffectiveConfigs,
  listRuntimePluginHttpCapabilityAudit,
  listRuntimePluginHttpCapabilities,
  listRuntimeCapabilities,
  listRuntimeCapabilityAudit,
  listRuntimeCapabilityBindings,
  reloadRuntimePluginConfig,
  runtimeCapabilityConfigFingerprint,
} from '../plugins/pluginRegistry.js'
import { readPluginEntryFile } from '../plugins/pluginEntryFile.js'
import { verifyPluginEntryIntegrity } from '../plugins/pluginIntegrity.js'
import { isLocalOwnerUser } from '../adapters/authAccount.js'
import { authenticateRequest } from '../middleware.js'
import { installPluginAsSkill } from '../services/pluginToSkill.js'
import { listAllRuntimeSkillIds } from '../services/skillRegistry.js'
import {
  disableRuntimePlugin,
  enableRuntimePlugin,
  listRuntimePluginInventory,
  reloadRuntimePlugin,
  revokeRuntimePluginPermissions,
  runRuntimePluginSandbox,
} from '../services/runtimePluginControlService.js'
import {
  RUNTIME_PLUGIN_RELEASE_GC_PREVIEW_TTL_MS,
  listRuntimePluginReleaseGcAudits,
  resolveRuntimePluginReleaseRetentionPolicy,
  runRuntimePluginReleaseGc,
} from '../services/runtimePluginReleaseGc.js'
import {
  importLocalPluginPackage,
  listLocalPluginPackages,
  recoverManagedLocalPluginPackage,
  uninstallManagedLocalPluginPackage,
} from '../services/localPluginPackageService.js'
import { toPublicRuntimeConfigHttpError } from '../utils/runtimeConfigErrors.js'
import { readJson, sendJson } from '../utils.js'

const ENTRY_PREVIEW_LIMIT = 50 * 1024
const SANDBOX_INPUT_LIMIT = 64 * 1024
const RELEASE_GC_BODY_LIMIT = 8 * 1024
const CONFIG_RELOAD_BODY_LIMIT = 1024
const LOCAL_PACKAGE_BODY_LIMIT = 8 * 1024
const RUNTIME_PLUGIN_PERMISSION_APPROVAL_HEADER = 'x-gugo-plugin-permission-approval'
const RELEASE_GC_PATH = '/api/plugins/runtime/releases/gc'
const LOCAL_PACKAGE_PATH = '/api/plugins/packages'
const LOCAL_PACKAGE_IMPORT_PATH = '/api/plugins/packages/actions/import'
const RELEASE_GC_CONFIRMATION = 'delete_eligible_releases'
const RELEASE_GC_BODY_FIELDS = new Set(['dryRun', 'confirm', 'policy', 'previewRunId'])
const RELEASE_GC_POLICY_FIELDS = new Set([
  'keepLatest',
  'minAgeMs',
  'maxDeletesPerRun',
  'maxReleasesScanned',
  'maxAuditRuns',
])
const RELEASE_GC_CONFLICT_CODES = new Set([
  'PLUGIN_RELEASE_GC_DELETE_CONFLICT',
  'PLUGIN_RELEASE_GC_REFERENCE_INVALID',
  'PLUGIN_RELEASE_GC_REFERENCE_LIMIT',
  'PLUGIN_RELEASE_GC_REFERENCE_UNREADABLE',
  'PLUGIN_RELEASE_GC_RELEASE_LIMIT',
  'PLUGIN_RELEASE_GC_RELEASE_SCAN_INVALID',
  'PLUGIN_RELEASE_GC_PREVIEW_ALREADY_USED',
  'PLUGIN_RELEASE_GC_PREVIEW_EXPIRED',
  'PLUGIN_RELEASE_GC_PREVIEW_INVALID',
  'PLUGIN_RELEASE_GC_PREVIEW_NOT_FOUND',
  'PLUGIN_RELEASE_GC_PREVIEW_OWNER_MISMATCH',
  'PLUGIN_RELEASE_GC_PREVIEW_REQUIRED',
  'PLUGIN_RELEASE_GC_PREVIEW_STALE',
])
const LOCAL_PACKAGE_IMPORT_FIELDS = new Set([
  'sourceDirectory',
  'expectedRevision',
  'replace',
  'expectedPluginId',
])
const LOCAL_PACKAGE_UNINSTALL_FIELDS = new Set(['expectedRevision'])
const LOCAL_PACKAGE_RECOVERY_FIELDS = new Set(['expectedRevision', 'expectedGeneration'])
const LOCAL_PACKAGE_BLOCKING_REASONS = new Set([
  'builtin_plugin',
  'manifest_dependant',
  'runtime_enabled',
  'runtime_active',
  'runtime_state_not_inactive',
  'retained_release',
  'release_pin',
  'checkpoint_reference',
  'release_reference',
  'guard_unavailable',
])
const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/u
const SHA256_RE = /^sha256-[a-f0-9]{64}$/u
const DEFAULT_LOCAL_PLUGIN_PACKAGE_SERVICE = Object.freeze({
  importLocalPluginPackage,
  listLocalPluginPackages,
  recoverManagedLocalPluginPackage,
  uninstallManagedLocalPluginPackage,
})

function publicView(p) {
  if (!p) return null
  // 不暴露绝对路径
  return {
    id: p.id,
    name: p.name,
    version: p.version,
    type: p.type,
    entry: p.entry,
    description: p.description,
    author: p.author,
    license: p.license,
    tags: p.tags,
    dir: p.dir,
  }
}

async function readEntryPreview(p) {
  try {
    let { bytes, size, truncated } = await readPluginEntryFile({
      rootDir: p.rootDir,
      entryPath: p.entryPath,
      maxBytes: ENTRY_PREVIEW_LIMIT,
      truncate: true,
    })
    if (p.integrity && truncated) {
      const verified = await readPluginEntryFile({
        rootDir: p.rootDir,
        entryPath: p.entryPath,
        maxBytes: Math.max(size, 1),
      })
      verifyPluginEntryIntegrity({ integrity: p.integrity, bytes: verified.bytes })
      bytes = verified.bytes.subarray(0, ENTRY_PREVIEW_LIMIT)
      size = verified.size
      truncated = verified.size > ENTRY_PREVIEW_LIMIT
    } else {
      verifyPluginEntryIntegrity({ integrity: p.integrity, bytes })
    }
    return {
      size,
      truncated,
      bytes: bytes.length,
      content: bytes.toString('utf8'),
      integrityStatus: p.integrity ? 'verified' : 'not_declared',
    }
  } catch (err) {
    const code = String(err?.code || 'PLUGIN_ENTRY_PREVIEW_FAILED')
    const integrityFailure = code.startsWith('PLUGIN_INTEGRITY_')
    return {
      trusted: false,
      integrityStatus: integrityFailure ? 'failed' : 'unavailable',
      error: {
        code,
        message: integrityFailure
          ? '插件入口完整性校验失败，源码预览不可信'
          : err?.message || '插件入口预览不可用',
      },
    }
  }
}

function isSandboxInput(input) {
  return typeof input === 'string' || (input !== null && typeof input === 'object')
}

function serializedInputSize(input) {
  return Buffer.byteLength(JSON.stringify(input), 'utf8')
}

function isLoopbackRequest(req) {
  const address = String(req.socket?.remoteAddress || '').trim().toLowerCase()
  if (isIP(address) === 4) return Number(address.split('.')[0]) === 127
  if (isIP(address) !== 6) return false
  try {
    const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1)
    if (normalized === '::1') return true
    const mapped = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
    return mapped ? (Number.parseInt(mapped[1], 16) >> 8) === 127 : false
  } catch {
    return false
  }
}

function authorizeRuntimeControl(req, res, env) {
  const userId = authenticateRequest(req)
  if (!userId) {
    sendJson(res, 401, {
      ok: false,
      error: { code: 'UNAUTHORIZED', message: '请先登录' },
    })
    return null
  }
  if (!isLoopbackRequest(req) || !isLocalOwnerUser(userId, env)) {
    sendJson(res, 403, {
      ok: false,
      error: {
        code: 'LOCAL_OWNER_ONLY',
        message: '插件源码预览和运行时控制仅限服务宿主机的本地所有者',
      },
    })
    return null
  }
  return userId
}

function runtimeControlError(res, error) {
  const publicError = toPublicRuntimeConfigHttpError(error)
  if (publicError) return sendJson(res, publicError.statusCode, publicError.body)
  const status = Number(error?.statusCode) || 500
  return sendJson(res, status, {
    ok: false,
    error: {
      code: error?.code || 'RUNTIME_PLUGIN_CONTROL_FAILED',
      message: status >= 500 ? '运行时插件操作失败' : error?.message || '运行时插件操作失败',
      ...(error?.permissionApproval
        ? { details: { permissionApproval: error.permissionApproval } }
        : {}),
    },
  })
}

function runtimePermissionApproval(req) {
  const value = req.headers?.[RUNTIME_PLUGIN_PERMISSION_APPROVAL_HEADER]
  if (Array.isArray(value)) return value[0] || null
  return typeof value === 'string' ? value : null
}

function gcErrorBody(code, message) {
  return { ok: false, error: { code, message } }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assertOnlyFields(value, allowed, label) {
  const unexpected = Object.keys(value).filter((field) => !allowed.has(field))
  if (unexpected.length > 0) {
    throw new TypeError(`${label} contains unsupported fields: ${unexpected.join(', ')}`)
  }
}

function assertLocalPackageService(service, method) {
  if (
    !service
    || typeof service !== 'object'
    || typeof service[method] !== 'function'
  ) {
    const error = new Error('local plugin package service is unavailable')
    error.code = 'PLUGIN_PACKAGE_SERVICE_UNAVAILABLE'
    error.statusCode = 503
    throw error
  }
  return service
}

function parseExpectedPackageRevision(value) {
  const revision = String(value || '').trim().toLowerCase()
  if (!SHA256_RE.test(revision)) {
    throw new TypeError('expectedRevision must be a valid package-store revision')
  }
  return revision
}

function parseLocalPackageImport(body) {
  if (!isPlainObject(body)) throw new TypeError('request body must be a JSON object')
  assertOnlyFields(body, LOCAL_PACKAGE_IMPORT_FIELDS, 'request body')
  const sourceDirectory = typeof body.sourceDirectory === 'string'
    ? body.sourceDirectory.trim()
    : ''
  if (!sourceDirectory || sourceDirectory.length > 4_096 || sourceDirectory.includes('\0')) {
    throw new TypeError('sourceDirectory must be a non-empty local directory path')
  }
  const replace = body.replace === undefined ? false : body.replace
  if (typeof replace !== 'boolean') throw new TypeError('replace must be a boolean')
  let expectedPluginId = null
  if (body.expectedPluginId !== undefined && body.expectedPluginId !== null) {
    expectedPluginId = String(body.expectedPluginId).trim().toLowerCase()
    if (!PLUGIN_ID_RE.test(expectedPluginId)) {
      throw new TypeError('expectedPluginId is invalid')
    }
  }
  if (replace && !expectedPluginId) {
    throw new TypeError('expectedPluginId is required for an explicit replacement')
  }
  return Object.freeze({
    sourceDirectory,
    expectedRevision: parseExpectedPackageRevision(body.expectedRevision),
    replace,
    expectedPluginId,
  })
}

function parseLocalPackageUninstall(body) {
  if (!isPlainObject(body)) throw new TypeError('request body must be a JSON object')
  assertOnlyFields(body, LOCAL_PACKAGE_UNINSTALL_FIELDS, 'request body')
  return Object.freeze({
    expectedRevision: parseExpectedPackageRevision(body.expectedRevision),
  })
}

function parseLocalPackageRecovery(body) {
  if (!isPlainObject(body)) throw new TypeError('request body must be a JSON object')
  assertOnlyFields(body, LOCAL_PACKAGE_RECOVERY_FIELDS, 'request body')
  if (!Number.isSafeInteger(body.expectedGeneration) || body.expectedGeneration < 1) {
    throw new TypeError('expectedGeneration must be a positive integer')
  }
  return Object.freeze({
    expectedRevision: parseExpectedPackageRevision(body.expectedRevision),
    expectedGeneration: body.expectedGeneration,
  })
}

function localPackagePublicErrorDetails(error) {
  const source = error?.details
  if (!isPlainObject(source)) return null
  const output = {}
  const pluginId = String(source.pluginId || '').trim().toLowerCase()
  if (PLUGIN_ID_RE.test(pluginId)) output.pluginId = pluginId
  if (Array.isArray(source.dependantPluginIds)) {
    const dependants = [...new Set(source.dependantPluginIds
      .map((value) => String(value || '').trim().toLowerCase())
      .filter((value) => PLUGIN_ID_RE.test(value)))]
      .sort((left, right) => left.localeCompare(right, 'en'))
      .slice(0, 100)
    if (dependants.length > 0) output.dependantPluginIds = dependants
  }
  for (const field of ['enabled', 'active']) {
    if (typeof source[field] === 'boolean') output[field] = source[field]
  }
  const runtimeState = String(source.runtimeState || '').trim().toLowerCase()
  if (/^[a-z0-9_-]{1,64}$/u.test(runtimeState)) output.runtimeState = runtimeState
  for (const field of ['releaseCount', 'pinCount', 'checkpointCount', 'referenceCount']) {
    const value = source[field]
    if (Number.isSafeInteger(value) && value >= 0 && value <= 100_000) output[field] = value
  }
  if (Array.isArray(source.blockingReasons)) {
    const reasons = [...new Set(source.blockingReasons
      .map((value) => String(value || '').trim())
      .filter((value) => LOCAL_PACKAGE_BLOCKING_REASONS.has(value)))]
    if (reasons.length > 0) output.blockingReasons = reasons
  }
  return Object.keys(output).length > 0 ? output : null
}

function localPackageRequestError(res, error, fallbackCode = 'PLUGIN_PACKAGE_REQUEST_INVALID') {
  const malformedJson = error instanceof SyntaxError
  const status = Number(error?.statusCode) || (
    malformedJson || error instanceof TypeError ? 400 : 500
  )
  const details = localPackagePublicErrorDetails(error)
  return sendJson(res, status, {
    ok: false,
    error: {
      code: error?.statusCode === 413
        ? 'REQUEST_TOO_LARGE'
        : malformedJson ? 'INVALID_JSON' : error?.code || fallbackCode,
      message: status >= 500
        ? '本地插件包操作失败'
        : error?.message || '本地插件包请求无效',
      ...(details ? { details } : {}),
    },
  })
}

async function readLocalPackageBody(req) {
  return readJson(req, { maxBytes: LOCAL_PACKAGE_BODY_LIMIT })
}

async function handleLocalPackageRequest(req, res, {
  url,
  env,
  service,
}) {
  if (!authorizeRuntimeControl(req, res, env)) return
  res.setHeader?.('Cache-Control', 'private, no-store')
  if ([...url.searchParams.keys()].length > 0) {
    return sendJson(res, 400, {
      ok: false,
      error: { code: 'PLUGIN_PACKAGE_QUERY_INVALID', message: '该请求不接受查询参数' },
    })
  }
  let packageService
  try {
    const requiredMethod = url.pathname === LOCAL_PACKAGE_PATH
      ? 'listLocalPluginPackages'
      : url.pathname === LOCAL_PACKAGE_IMPORT_PATH
        ? 'importLocalPluginPackage'
        : url.pathname.endsWith('/actions/recover')
          ? 'recoverManagedLocalPluginPackage'
          : 'uninstallManagedLocalPluginPackage'
    packageService = assertLocalPackageService(service, requiredMethod)
  } catch (error) {
    return localPackageRequestError(res, error)
  }

  if (url.pathname === LOCAL_PACKAGE_PATH) {
    if (req.method !== 'GET') {
      res.setHeader?.('Allow', 'GET')
      return sendJson(res, 405, {
        ok: false,
        error: { code: 'METHOD_NOT_ALLOWED', message: '仅支持 GET' },
      })
    }
    try {
      const result = await packageService.listLocalPluginPackages()
      return sendJson(res, 200, { ok: true, ...result })
    } catch (error) {
      return localPackageRequestError(res, error, 'PLUGIN_PACKAGE_LIST_FAILED')
    }
  }

  if (url.pathname === LOCAL_PACKAGE_IMPORT_PATH) {
    if (req.method !== 'POST') {
      res.setHeader?.('Allow', 'POST')
      return sendJson(res, 405, {
        ok: false,
        error: { code: 'METHOD_NOT_ALLOWED', message: '仅支持 POST' },
      })
    }
    let input
    try {
      input = parseLocalPackageImport(await readLocalPackageBody(req))
    } catch (error) {
      return localPackageRequestError(res, error)
    }
    try {
      const result = await packageService.importLocalPluginPackage(input)
      return sendJson(res, 200, { ok: true, ...result })
    } catch (error) {
      return localPackageRequestError(res, error, 'PLUGIN_PACKAGE_IMPORT_FAILED')
    }
  }

  const recoveryMatch = url.pathname.match(
    /^\/api\/plugins\/packages\/([a-z0-9][a-z0-9-]{0,79})\/actions\/recover$/iu,
  )
  if (recoveryMatch) {
    if (req.method !== 'POST') {
      res.setHeader?.('Allow', 'POST')
      return sendJson(res, 405, {
        ok: false,
        error: { code: 'METHOD_NOT_ALLOWED', message: '仅支持 POST' },
      })
    }
    let input
    try {
      input = parseLocalPackageRecovery(await readLocalPackageBody(req))
    } catch (error) {
      return localPackageRequestError(res, error)
    }
    try {
      const result = await packageService.recoverManagedLocalPluginPackage({
        pluginId: recoveryMatch[1].toLowerCase(),
        expectedRevision: input.expectedRevision,
        expectedGeneration: input.expectedGeneration,
      })
      return sendJson(res, 200, { ok: true, ...result })
    } catch (error) {
      return localPackageRequestError(res, error, 'PLUGIN_PACKAGE_RECOVERY_FAILED')
    }
  }

  const uninstallMatch = url.pathname.match(
    /^\/api\/plugins\/packages\/([a-z0-9][a-z0-9-]{0,79})$/iu,
  )
  if (!uninstallMatch) return sendJson(res, 404, {
    ok: false,
    error: { code: 'NOT_FOUND', message: '插件包端点不存在' },
  })
  if (req.method !== 'DELETE') {
    res.setHeader?.('Allow', 'DELETE')
    return sendJson(res, 405, {
      ok: false,
      error: { code: 'METHOD_NOT_ALLOWED', message: '仅支持 DELETE' },
    })
  }
  let input
  try {
    input = parseLocalPackageUninstall(await readLocalPackageBody(req))
  } catch (error) {
    return localPackageRequestError(res, error)
  }
  try {
    const result = await packageService.uninstallManagedLocalPluginPackage({
      pluginId: uninstallMatch[1].toLowerCase(),
      expectedRevision: input.expectedRevision,
    })
    return sendJson(res, 200, { ok: true, ...result })
  } catch (error) {
    return localPackageRequestError(res, error, 'PLUGIN_PACKAGE_UNINSTALL_FAILED')
  }
}

function parseGcPolicy(body, env) {
  if (!isPlainObject(body)) throw new TypeError('request body must be a JSON object')
  assertOnlyFields(body, RELEASE_GC_BODY_FIELDS, 'request body')
  if (body.policy !== undefined && !isPlainObject(body.policy)) {
    throw new TypeError('policy must be a JSON object')
  }
  const overrides = body.policy || {}
  assertOnlyFields(overrides, RELEASE_GC_POLICY_FIELDS, 'policy')
  for (const [field, value] of Object.entries(overrides)) {
    if (!Number.isSafeInteger(value)) throw new TypeError(`${field} must be an integer`)
  }
  return resolveRuntimePluginReleaseRetentionPolicy({
    env,
    overrides: { ...overrides, enabled: true },
  })
}

function parseGcAuditLimit(url) {
  const unexpected = [...url.searchParams.keys()].filter((field) => field !== 'limit')
  if (unexpected.length > 0) {
    throw new TypeError(`unsupported query fields: ${unexpected.join(', ')}`)
  }
  const values = url.searchParams.getAll('limit')
  if (values.length > 1) throw new TypeError('limit may only be provided once')
  const raw = values[0] ?? null
  if (raw === null) return 20
  if (!/^[1-9]\d{0,2}$/u.test(raw)) throw new TypeError('limit must be an integer between 1 and 100')
  const limit = Number(raw)
  if (limit > 100) throw new TypeError('limit must be an integer between 1 and 100')
  return limit
}

function gcAuditHttpStatus(audit) {
  if (audit?.status !== 'failed') return 200
  return RELEASE_GC_CONFLICT_CODES.has(audit?.result?.reason) ? 409 : 500
}

async function handleReleaseGcRequest(req, res, { url, env }) {
  const ownerId = authorizeRuntimeControl(req, res, env)
  if (!ownerId) return
  res.setHeader?.('Cache-Control', 'no-store')
  if (req.method === 'GET') {
    try {
      const limit = parseGcAuditLimit(url)
      const policy = resolveRuntimePluginReleaseRetentionPolicy({
        env,
        overrides: { enabled: true },
      })
      return sendJson(res, 200, {
        ok: true,
        schemaVersion: 1,
        dryRunDefault: true,
        previewTtlMs: RUNTIME_PLUGIN_RELEASE_GC_PREVIEW_TTL_MS,
        executionConfirmation: RELEASE_GC_CONFIRMATION,
        policy,
        audits: listRuntimePluginReleaseGcAudits({ limit }),
      })
    } catch (error) {
      return sendJson(res, 400, gcErrorBody(
        'PLUGIN_RELEASE_GC_QUERY_INVALID',
        error?.message || 'GC query is invalid',
      ))
    }
  }
  if (req.method !== 'POST') {
    return sendJson(res, 405, gcErrorBody('METHOD_NOT_ALLOWED', '仅支持 GET 或 POST'))
  }

  let body
  try {
    body = await readJson(req, { maxBytes: RELEASE_GC_BODY_LIMIT })
  } catch (error) {
    return sendJson(res, Number(error?.statusCode) || 400, gcErrorBody(
      error?.statusCode === 413 ? 'REQUEST_TOO_LARGE' : 'INVALID_JSON',
      error?.message || 'request body is invalid',
    ))
  }
  let dryRun
  let policy
  let previewRunId
  try {
    dryRun = body?.dryRun === undefined ? true : body.dryRun
    if (typeof dryRun !== 'boolean') throw new TypeError('dryRun must be a boolean')
    if (dryRun) {
      if (body.previewRunId !== undefined || body.confirm !== undefined) {
        throw new TypeError('dry-run cannot include previewRunId or confirm')
      }
      policy = parseGcPolicy(body, env)
    } else {
      if (!isPlainObject(body)) throw new TypeError('request body must be a JSON object')
      assertOnlyFields(body, RELEASE_GC_BODY_FIELDS, 'request body')
      if (body.policy !== undefined) throw new TypeError('actual GC cannot override preview policy')
      previewRunId = String(body.previewRunId || '').trim()
      if (!/^plugin-release-gc-[0-9a-f-]{36}$/u.test(previewRunId)) {
        throw new TypeError('actual GC requires a valid previewRunId')
      }
    }
    if (!dryRun && body.confirm !== RELEASE_GC_CONFIRMATION) {
      return sendJson(res, 400, gcErrorBody(
        'PLUGIN_RELEASE_GC_CONFIRMATION_REQUIRED',
        `actual deletion requires confirm="${RELEASE_GC_CONFIRMATION}"`,
      ))
    }
  } catch (error) {
    return sendJson(res, 400, gcErrorBody(
      'PLUGIN_RELEASE_GC_POLICY_INVALID',
      error?.message || 'GC policy is invalid',
    ))
  }
  try {
    const audit = runRuntimePluginReleaseGc({
      env,
      ...(dryRun ? { policy } : { previewRunId }),
      dryRun,
      ownerId,
    })
    const status = gcAuditHttpStatus(audit)
    return sendJson(res, status, {
      ok: status < 400,
      schemaVersion: 1,
      dryRun,
      audit,
    })
  } catch (error) {
    const status = RELEASE_GC_CONFLICT_CODES.has(error?.code) ? 409 : 500
    return sendJson(res, status, gcErrorBody(
      error?.code || 'PLUGIN_RELEASE_GC_FAILED',
      status === 409 ? error.message : '插件 Release GC 操作失败',
    ))
  }
}

export async function handlePluginRequest(req, res, {
  env = process.env,
  localPluginPackageService = DEFAULT_LOCAL_PLUGIN_PACKAGE_SERVICE,
} = {}) {
  const url = new URL(req.url, 'http://localhost')

  const localPackageRoute = url.pathname === LOCAL_PACKAGE_PATH
    || url.pathname === LOCAL_PACKAGE_IMPORT_PATH
    || /^\/api\/plugins\/packages\/[a-z0-9][a-z0-9-]{0,79}$/iu.test(url.pathname)
    || /^\/api\/plugins\/packages\/[a-z0-9][a-z0-9-]{0,79}\/actions\/recover$/iu.test(url.pathname)
  if (localPackageRoute) {
    return handleLocalPackageRequest(req, res, {
      url,
      env,
      service: localPluginPackageService,
    })
  }

  if (url.pathname === RELEASE_GC_PATH) {
    return handleReleaseGcRequest(req, res, { url, env })
  }

  const runtimeAction = url.pathname.match(
    /^\/api\/plugins\/runtime\/([a-z0-9][a-z0-9-]*)\/(enable|disable|reload|revoke-permissions)$/i,
  )
  const runtimeConfigReload = url.pathname.match(
    /^\/api\/plugins\/runtime\/([a-z0-9][a-z0-9-]*)\/config\/reload$/i,
  )
  if (url.pathname === '/api/plugins/runtime' || runtimeAction || runtimeConfigReload) {
    if (!authorizeRuntimeControl(req, res, env)) return
    if (url.pathname === '/api/plugins/runtime') {
      if (req.method !== 'GET') {
        return sendJson(res, 405, {
          ok: false,
          error: { code: 'METHOD_NOT_ALLOWED', message: '不支持的请求' },
        })
      }
      res.setHeader?.('Cache-Control', 'private, no-store')
      return sendJson(res, 200, {
        ok: true,
        schemaVersion: 7,
        plugins: listRuntimePluginInventory(),
        effectiveConfigs: listRuntimePluginEffectiveConfigs(),
        configReloadAudit: listRuntimePluginConfigReloadAudit(),
        httpCapabilities: listRuntimePluginHttpCapabilities(),
        httpCapabilityAudit: listRuntimePluginHttpCapabilityAudit(),
        runtimeCapabilities: listRuntimeCapabilities(),
        effectiveCapabilityBindings: listRuntimeCapabilityBindings(),
        runtimeCapabilityAudit: listRuntimeCapabilityAudit(),
        runtimeCapabilityConfigFingerprint: runtimeCapabilityConfigFingerprint(),
      })
    }
    if (req.method !== 'POST') {
      return sendJson(res, 405, {
        ok: false,
        error: { code: 'METHOD_NOT_ALLOWED', message: '不支持的请求' },
      })
    }
    if (runtimeConfigReload) {
      let body
      try {
        body = await readJson(req, { maxBytes: CONFIG_RELOAD_BODY_LIMIT })
        if (!isPlainObject(body)) throw new TypeError('request body must be a JSON object')
        assertOnlyFields(body, new Set(['expectedRevision']), 'request body')
        if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 1) {
          throw new TypeError('expectedRevision must be a positive safe integer')
        }
      } catch (error) {
        return sendJson(res, Number(error?.statusCode) || 400, {
          ok: false,
          error: {
            code: error?.statusCode === 413
              ? 'REQUEST_TOO_LARGE'
              : error instanceof SyntaxError ? 'INVALID_JSON' : 'PLUGIN_CONFIG_RELOAD_REQUEST_INVALID',
            message: error?.message || '配置重载请求无效',
          },
        })
      }
      try {
        const plugin = await reloadRuntimePluginConfig(runtimeConfigReload[1], {
          expectedRevision: body.expectedRevision,
        })
        return sendJson(res, 200, { ok: true, schemaVersion: 1, plugin })
      } catch (error) {
        return runtimeControlError(res, error)
      }
    }
    try {
      const action = runtimeAction[2].toLowerCase()
      const plugin = action === 'enable'
        ? await enableRuntimePlugin(runtimeAction[1], {
            permissionApproval: runtimePermissionApproval(req),
          })
        : action === 'reload'
          ? await reloadRuntimePlugin(runtimeAction[1], {
              permissionApproval: runtimePermissionApproval(req),
            })
          : action === 'revoke-permissions'
            ? await revokeRuntimePluginPermissions(runtimeAction[1])
            : await disableRuntimePlugin(runtimeAction[1])
      return sendJson(res, 200, { ok: true, plugin })
    } catch (error) {
      return runtimeControlError(res, error)
    }
  }

  // POST /api/plugins/:id/run-sandbox — 仅本机 owner，可运行已明确授权的 transformer
  const sandboxMatch = url.pathname.match(/^\/api\/plugins\/([a-z0-9][a-z0-9-]*)\/run-sandbox$/i)
  if (sandboxMatch && req.method === 'POST') {
    if (!authorizeRuntimeControl(req, res, env)) return

    let body
    try {
      body = await readJson(req, { maxBytes: 128 * 1024 })
    } catch (err) {
      return sendJson(res, 400, { error: err.message || 'invalid json' })
    }
    if (!Object.prototype.hasOwnProperty.call(body, 'input') || !isSandboxInput(body.input)) {
      return sendJson(res, 400, { error: 'input must be string or object' })
    }
    if (serializedInputSize(body.input) > SANDBOX_INPUT_LIMIT) {
      return sendJson(res, 400, { error: 'input exceeds 64KB' })
    }

    try {
      const result = await runRuntimePluginSandbox(sandboxMatch[1], body.input, {
        permissionApproval: runtimePermissionApproval(req),
      })
      return sendJson(res, 200, result)
    } catch (err) {
      if (err?.code === 'PLUGIN_PERMISSION_APPROVAL_REQUIRED') {
        return runtimeControlError(res, err)
      }
      const status = Number(err?.statusCode) || 500
      return sendJson(res, status, {
        ok: false,
        error: {
          code: err?.code || 'PLUGIN_SANDBOX_FAILED',
          message: status >= 500 ? 'sandbox internal error' : err.message,
        },
      })
    }
  }

  // POST /api/plugins/:id/install-as-skill — 需登录，将 skill-bundle plugin 装为用户 skill
  const installMatch = url.pathname.match(/^\/api\/plugins\/([a-z0-9][a-z0-9-]*)\/install-as-skill$/i)
  if (installMatch && req.method === 'POST') {
    const userId = authenticateRequest(req)
    if (!userId) return sendJson(res, 401, { error: 'Unauthorized' })
    const existingIds = listAllRuntimeSkillIds()
    const result = installPluginAsSkill({ pluginId: installMatch[1], userId, existingIds })
    if (!result.ok) {
      const status = /not found/i.test(result.reason) ? 404
        : /类型必须|缺少|路径越界|文件过大|超限/.test(result.reason) ? 400
        : 409
      return sendJson(res, status, { ok: false, error: result.reason })
    }
    return sendJson(res, 200, { ok: true, skill: result.skill })
  }

  if (req.method !== 'GET') {
    return sendJson(res, 405, { error: 'method not allowed' })
  }

  if (url.pathname === '/api/plugins') {
    const type = url.searchParams.get('type') || undefined
    const plugins = listPlugins({ type }).map(publicView)
    return sendJson(res, 200, { plugins })
  }

  const m = url.pathname.match(/^\/api\/plugins\/([a-z0-9][a-z0-9-]*)$/i)
  if (m) {
    if (!authorizeRuntimeControl(req, res, env)) return
    const internal = getPlugin(m[1])
    if (!internal) return sendJson(res, 404, { error: 'plugin not found' })
    return sendJson(res, 200, {
      plugin: publicView(internal),
      entryPreview: await readEntryPreview(internal),
    })
  }

  return sendJson(res, 404, { error: 'not found' })
}
