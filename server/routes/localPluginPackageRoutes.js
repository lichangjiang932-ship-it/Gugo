import { readJson, sendJson } from '../utils.js'
import { authorizeRuntimeControl } from './pluginRouteAuthorization.js'
import { assertOnlyFields, isPlainObject } from './pluginRouteValidation.js'

const LOCAL_PACKAGE_BODY_LIMIT = 8 * 1024
const LOCAL_PACKAGE_PATH = '/api/plugins/packages'
const LOCAL_PACKAGE_IMPORT_PATH = '/api/plugins/packages/actions/import'
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

export function isLocalPluginPackageRoute(url) {
  return url.pathname === LOCAL_PACKAGE_PATH
    || url.pathname === LOCAL_PACKAGE_IMPORT_PATH
    || /^\/api\/plugins\/packages\/[a-z0-9][a-z0-9-]{0,79}$/iu.test(url.pathname)
    || /^\/api\/plugins\/packages\/[a-z0-9][a-z0-9-]{0,79}\/actions\/recover$/iu.test(url.pathname)
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

export async function handleLocalPackageRequest(req, res, {
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
