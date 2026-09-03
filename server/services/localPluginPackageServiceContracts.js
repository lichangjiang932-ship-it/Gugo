import path from 'node:path'

import { localPluginPackagePublicView as packageView } from '../plugins/localPluginPackagePublicView.js'

export const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/u
export const SHA256_RE = /^sha256-[a-f0-9]{64}$/u

const MAX_SOURCE_DIRECTORY_LENGTH = 4_096
const IMPORT_FIELDS = Object.freeze([
  'sourceDirectory',
  'expectedRevision',
  'replace',
  'expectedPluginId',
])
const UNINSTALL_FIELDS = Object.freeze(['pluginId', 'expectedRevision'])
const RECOVERY_FIELDS = Object.freeze(['pluginId', 'expectedRevision', 'expectedGeneration'])

const PUBLIC_MESSAGES = Object.freeze({
  PLUGIN_PACKAGE_SERVICE_INPUT_INVALID: '本地插件包请求无效',
  PLUGIN_PACKAGE_DISCOVERY_UNAVAILABLE: '本地插件包目录尚未由启动流程启用',
  PLUGIN_PACKAGE_DISCOVERY_CHANGED: '本地插件包目录身份已变化，请重启后重试',
  PLUGIN_PACKAGE_ID_PROTECTED: '该插件 ID 由内置插件保留，不能导入或卸载',
  PLUGIN_PACKAGE_HAS_DEPENDANTS: '仍有其他插件依赖该插件，不能卸载',
  PLUGIN_PACKAGE_RUNTIME_ACTIVE: '插件仍处于启用或活动状态，不能卸载',
  PLUGIN_PACKAGE_RELEASES_RETAINED: '插件仍有 Release 或运行回执引用，不能卸载',
  PLUGIN_PACKAGE_UNINSTALL_GUARD_UNAVAILABLE: '无法完整验证插件卸载安全性，已拒绝卸载',
  PLUGIN_PACKAGE_REVISION_REQUIRED: '需要有效的插件包目录版本，请刷新后重试',
  PLUGIN_PACKAGE_REVISION_CONFLICT: '插件包目录已变化，请刷新后重试',
  PLUGIN_PACKAGE_ALREADY_INSTALLED: '该插件包已安装；升级时必须明确选择替换',
  PLUGIN_PACKAGE_NOT_INSTALLED: '该插件包尚未安装',
  PLUGIN_PACKAGE_ID_MISMATCH: '所选插件包与目标插件 ID 不一致',
  PLUGIN_PACKAGE_SOURCE_NOT_FOUND: '所选本地插件目录不存在',
  PLUGIN_PACKAGE_SOURCE_INVALID: '所选本地插件目录无效',
  PLUGIN_PACKAGE_SOURCE_OVERLAP: '所选插件目录不能位于受管插件目录内或与其重叠',
  PLUGIN_PACKAGE_STORE_BUSY: '插件包目录正由另一项操作使用，请稍后重试',
  PLUGIN_PACKAGE_STORE_FAILED: '本地插件包操作失败',
  PLUGIN_PACKAGE_REFRESH_FAILED: '插件包已保存到本地，但当前进程刷新失败',
  PLUGIN_PACKAGE_RECOVERY_NOT_REQUIRED: '该插件没有需要恢复的生命周期屏障',
  PLUGIN_PACKAGE_RECOVERY_OWNER_ACTIVE: '原插件生命周期进程仍在运行，已拒绝恢复',
  PLUGIN_PACKAGE_RECOVERY_UNSAFE: '无法证明插件磁盘、Registry 与运行状态一致，已拒绝恢复',
})

export function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const entry of Object.values(value)) deepFreeze(entry)
  return Object.freeze(value)
}

export function serviceError(code, statusCode, details = null) {
  const error = new Error(PUBLIC_MESSAGES[code] || PUBLIC_MESSAGES.PLUGIN_PACKAGE_STORE_FAILED)
  error.code = code
  error.statusCode = statusCode
  error.retryable = false
  if (details) error.details = deepFreeze(details)
  return error
}

export function safeDependencyError(error, fallbackCode = 'PLUGIN_PACKAGE_STORE_FAILED') {
  const candidate = typeof error?.code === 'string' ? error.code : ''
  const code = candidate.startsWith('PLUGIN_PACKAGE_') ? candidate : fallbackCode
  const statusCode = Number.isInteger(error?.statusCode)
    && error.statusCode >= 400
    && error.statusCode <= 599
    ? error.statusCode
    : code === 'PLUGIN_PACKAGE_STORE_BUSY' ? 409 : 500
  return serviceError(code, statusCode)
}

function ownRequestValues(input, allowedFields, label) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw serviceError('PLUGIN_PACKAGE_SERVICE_INPUT_INVALID', 400)
  }
  let prototype
  let keys
  try {
    prototype = Object.getPrototypeOf(input)
    keys = Reflect.ownKeys(input)
  } catch {
    throw serviceError('PLUGIN_PACKAGE_SERVICE_INPUT_INVALID', 400)
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw serviceError('PLUGIN_PACKAGE_SERVICE_INPUT_INVALID', 400)
  }
  const allowed = new Set(allowedFields)
  const output = Object.create(null)
  for (const key of keys) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw serviceError('PLUGIN_PACKAGE_SERVICE_INPUT_INVALID', 400)
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      throw serviceError('PLUGIN_PACKAGE_SERVICE_INPUT_INVALID', 400)
    }
    output[key] = descriptor.value
  }
  if (!keys.length && label === 'import') {
    throw serviceError('PLUGIN_PACKAGE_SERVICE_INPUT_INVALID', 400)
  }
  return output
}

export function normalizePluginId(value) {
  const pluginId = String(value || '').trim().toLowerCase()
  if (!PLUGIN_ID_RE.test(pluginId)) {
    throw serviceError('PLUGIN_PACKAGE_SERVICE_INPUT_INVALID', 400)
  }
  return pluginId
}

function normalizeRevision(value) {
  const revision = String(value || '').trim().toLowerCase()
  if (!SHA256_RE.test(revision)) {
    throw serviceError('PLUGIN_PACKAGE_REVISION_REQUIRED', 409)
  }
  return revision
}

export function normalizeImportRequest(input) {
  const values = ownRequestValues(input, IMPORT_FIELDS, 'import')
  const sourceDirectoryInput = typeof values.sourceDirectory === 'string'
    ? values.sourceDirectory.trim()
    : ''
  if (
    !sourceDirectoryInput
    || sourceDirectoryInput.length > MAX_SOURCE_DIRECTORY_LENGTH
    || sourceDirectoryInput.includes('\0')
    || !path.isAbsolute(sourceDirectoryInput)
  ) {
    throw serviceError('PLUGIN_PACKAGE_SERVICE_INPUT_INVALID', 400)
  }
  const sourceDirectory = path.normalize(sourceDirectoryInput)
  const replace = values.replace === undefined ? false : values.replace
  if (typeof replace !== 'boolean') {
    throw serviceError('PLUGIN_PACKAGE_SERVICE_INPUT_INVALID', 400)
  }
  const expectedPluginId = values.expectedPluginId == null
    ? null
    : normalizePluginId(values.expectedPluginId)
  if (replace && !expectedPluginId) {
    throw serviceError('PLUGIN_PACKAGE_SERVICE_INPUT_INVALID', 400)
  }
  return Object.freeze({
    sourceDirectory,
    expectedRevision: normalizeRevision(values.expectedRevision),
    replace,
    expectedPluginId,
  })
}

export function normalizeUninstallRequest(input) {
  const values = ownRequestValues(input, UNINSTALL_FIELDS, 'uninstall')
  return Object.freeze({
    pluginId: normalizePluginId(values.pluginId),
    expectedRevision: normalizeRevision(values.expectedRevision),
  })
}

export function normalizeRecoveryRequest(input) {
  const values = ownRequestValues(input, RECOVERY_FIELDS, 'recovery')
  const expectedGeneration = Number(values.expectedGeneration)
  if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1) {
    throw serviceError('PLUGIN_PACKAGE_SERVICE_INPUT_INVALID', 400)
  }
  return Object.freeze({
    pluginId: normalizePluginId(values.pluginId),
    expectedRevision: normalizeRevision(values.expectedRevision),
    expectedGeneration,
  })
}

export function storeView(value) {
  if (
    !value
    || typeof value !== 'object'
    || value.schemaVersion !== 1
    || !SHA256_RE.test(String(value.revision || ''))
    || !Array.isArray(value.packages)
  ) {
    throw serviceError('PLUGIN_PACKAGE_STORE_FAILED', 500)
  }
  return Object.freeze({
    schemaVersion: 1,
    revision: value.revision,
    packages: Object.freeze(value.packages.map(packageView)),
  })
}

export function mutationResultView(value) {
  if (!value || typeof value !== 'object') {
    throw serviceError('PLUGIN_PACKAGE_STORE_FAILED', 500)
  }
  return Object.freeze({
    changed: value.changed === true,
    operation: String(value.operation || ''),
    package: packageView(value.package),
    cleanupDeferred: value.cleanupDeferred === true,
  })
}

export function refreshFailureView(error) {
  const candidate = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{2,79}$/u.test(error.code)
    ? error.code
    : 'PLUGIN_PACKAGE_REFRESH_FAILED'
  return Object.freeze({
    code: candidate,
    message: PUBLIC_MESSAGES.PLUGIN_PACKAGE_REFRESH_FAILED,
  })
}
