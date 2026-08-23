import { createHash, timingSafeEqual } from 'node:crypto'

import { normalizePluginManifest } from '../../shared/pluginManifest.js'
import { PLUGIN_CAPABILITIES } from './pluginManifest.js'

export const RUNTIME_PLUGIN_RELEASE_DIGEST_VERSION = 1

const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/
const RELEASE_ID_RE = /^[a-z0-9][a-z0-9._:-]{0,127}$/
const SHA256_DIGEST_RE = /^sha256-[a-f0-9]{64}$/
const MAX_RELEASE_SOURCE_BYTES = 512 * 1024
const MAX_PLUGIN_SNAPSHOT_BYTES = 256 * 1024
const MAX_SNAPSHOT_DEPTH = 32
const MAX_SNAPSHOT_NODES = 4_096
const allowedCapabilities = new Set(PLUGIN_CAPABILITIES)

function corruptRelease(reason) {
  const error = new Error(`插件 Release 内容身份校验失败：${reason}`)
  error.code = 'PLUGIN_RELEASE_CORRUPT'
  error.statusCode = 500
  error.retryable = false
  return error
}

function normalizeString(value, field, { max, optional = false } = {}) {
  if (optional && value === undefined) return undefined
  if (typeof value !== 'string' || (max !== undefined && value.length > max)) {
    throw corruptRelease(`${field} 无效`)
  }
  return value
}

function canonicalSnapshot(value, state, depth = 0) {
  if (depth > MAX_SNAPSHOT_DEPTH) throw corruptRelease('清单快照层级过深')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw corruptRelease('清单快照包含非有限数字')
    return Object.is(value, -0) ? 0 : value
  }
  if (!value || typeof value !== 'object') throw corruptRelease('清单快照包含非 JSON 值')
  if (state.seen.has(value)) throw corruptRelease('清单快照包含循环引用')
  state.seen.add(value)
  state.nodes += 1
  if (state.nodes > MAX_SNAPSHOT_NODES) throw corruptRelease('清单快照项目过多')
  try {
    if (Array.isArray(value)) {
      return value.map((item) => canonicalSnapshot(item, state, depth + 1))
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw corruptRelease('清单快照必须是普通 JSON 对象')
    }
    const output = Object.create(null)
    for (const key of Object.keys(value).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
        throw corruptRelease(`清单快照字段 ${key} 不是数据属性`)
      }
      output[key] = canonicalSnapshot(descriptor.value, state, depth + 1)
    }
    return output
  } finally {
    state.seen.delete(value)
  }
}

function normalizeCapabilities(value) {
  if (!Array.isArray(value) || value.length > 16) {
    throw corruptRelease('capabilities 必须是最多 16 项的数组')
  }
  const capabilities = value.map((capability) => {
    if (typeof capability !== 'string' || !allowedCapabilities.has(capability)) {
      throw corruptRelease('capabilities 包含未声明能力')
    }
    return capability
  })
  return Object.freeze(capabilities)
}

function normalizeTags(value) {
  if (value === undefined) return Object.freeze([])
  if (!Array.isArray(value) || value.length > 20) throw corruptRelease('tags 无效')
  return Object.freeze(value.map((tag) => {
    if (typeof tag !== 'string' || tag.length === 0 || tag.length > 40) {
      throw corruptRelease('tags 无效')
    }
    return tag
  }))
}

function normalizedManifest(snapshot, pluginId) {
  let envelope
  try {
    envelope = normalizePluginManifest(snapshot)
  } catch (error) {
    if (error?.code === 'PLUGIN_RELEASE_CORRUPT') throw error
    throw corruptRelease(`清单规范化失败：${error?.message || String(error)}`)
  }
  if (envelope.id !== pluginId || snapshot.type !== 'transformer') {
    throw corruptRelease('插件身份或类型不匹配')
  }
  const capabilities = normalizeCapabilities(snapshot.capabilities)
  const description = normalizeString(snapshot.description ?? '', 'description', { max: 2_000 })
  const author = normalizeString(snapshot.author ?? '', 'author', { max: 200 })
  const license = normalizeString(snapshot.license ?? '', 'license', { max: 80 })
  const entry = normalizeString(snapshot.entry, 'entry', { optional: true })
  if (entry !== undefined && (
    !entry
    || entry.startsWith('/')
    || /^[A-Za-z]:[\\/]/.test(entry)
    || entry.split(/[\\/]/).includes('..')
    || !entry.endsWith('.js')
  )) throw corruptRelease('entry 无效')
  return Object.freeze({
    ...envelope,
    type: 'transformer',
    ...(entry === undefined ? {} : { entry }),
    description,
    author,
    license,
    tags: normalizeTags(snapshot.tags),
    capabilities,
  })
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

function normalizeReleaseFields(release) {
  const releaseId = String(release?.releaseId || '').trim()
  const pluginId = String(release?.pluginId || '').trim()
  if (!RELEASE_ID_RE.test(releaseId)) throw corruptRelease('releaseId 无效')
  if (!PLUGIN_ID_RE.test(pluginId)) throw corruptRelease('pluginId 无效')
  const source = normalizeString(release?.source, 'source')
  if (Buffer.byteLength(source, 'utf8') > MAX_RELEASE_SOURCE_BYTES) {
    throw corruptRelease('源码超过 512 KiB')
  }
  const sourceDigest = String(release?.sourceDigest || '').trim().toLowerCase()
  const expectedSourceDigest = `sha256-${createHash('sha256').update(source, 'utf8').digest('hex')}`
  if (!SHA256_DIGEST_RE.test(sourceDigest) || sourceDigest !== expectedSourceDigest) {
    throw corruptRelease('源码摘要不匹配')
  }
  const pluginSnapshotJson = normalizeString(release?.pluginSnapshotJson, 'pluginSnapshotJson')
  if (Buffer.byteLength(pluginSnapshotJson, 'utf8') > MAX_PLUGIN_SNAPSHOT_BYTES) {
    throw corruptRelease('清单快照超过 256 KiB')
  }
  let parsedSnapshot
  try {
    parsedSnapshot = JSON.parse(pluginSnapshotJson)
  } catch {
    throw corruptRelease('清单快照不是有效 JSON')
  }
  if (!parsedSnapshot || typeof parsedSnapshot !== 'object' || Array.isArray(parsedSnapshot)) {
    throw corruptRelease('清单快照必须是对象')
  }
  const snapshot = canonicalSnapshot(parsedSnapshot, { seen: new WeakSet(), nodes: 0 })
  const manifest = normalizedManifest(snapshot, pluginId)
  const validationStatus = release?.validationStatus
  const healthStatus = release?.healthStatus
  if (!['passed', 'failed'].includes(validationStatus)) throw corruptRelease('validationStatus 无效')
  if (!['passed', 'failed', 'not_run'].includes(healthStatus)) throw corruptRelease('healthStatus 无效')
  if ((validationStatus === 'failed' && healthStatus !== 'not_run')
    || (validationStatus === 'passed' && healthStatus === 'not_run')) {
    throw corruptRelease('发布门禁状态组合无效')
  }
  const failure = release?.failure == null ? null : normalizeString(release.failure, 'failure')
  const createdAt = Number(release?.createdAt)
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw corruptRelease('createdAt 无效')
  return {
    releaseId,
    pluginId,
    sourceDigest,
    source,
    pluginSnapshotJson,
    snapshot,
    manifest,
    validationStatus,
    healthStatus,
    failure,
    createdAt,
  }
}

function canonicalJson(value) {
  return JSON.stringify(canonicalSnapshot(value, { seen: new WeakSet(), nodes: 0 }))
}

export function buildRuntimePluginReleaseContentIdentity(release) {
  const normalized = normalizeReleaseFields(release)
  const digestEnvelope = {
    format: 'gugo-runtime-plugin-release',
    digestVersion: RUNTIME_PLUGIN_RELEASE_DIGEST_VERSION,
    releaseId: normalized.releaseId,
    pluginId: normalized.pluginId,
    sourceDigest: normalized.sourceDigest,
    source: normalized.source,
    manifest: normalized.manifest,
    capabilities: normalized.manifest.capabilities,
    snapshot: normalized.snapshot,
    validationStatus: normalized.validationStatus,
    healthStatus: normalized.healthStatus,
    failure: normalized.failure,
    createdAt: normalized.createdAt,
  }
  const releaseContentDigest = `sha256-${createHash('sha256')
    .update(canonicalJson(digestEnvelope), 'utf8')
    .digest('hex')}`
  return deepFreeze({
    ...normalized,
    plugin: {
      ...normalized.snapshot,
      ...normalized.manifest,
    },
    digestVersion: RUNTIME_PLUGIN_RELEASE_DIGEST_VERSION,
    releaseContentDigest,
  })
}

function equalDigest(left, right) {
  if (!SHA256_DIGEST_RE.test(left) || !SHA256_DIGEST_RE.test(right)) return false
  return timingSafeEqual(
    Buffer.from(left.slice('sha256-'.length), 'hex'),
    Buffer.from(right.slice('sha256-'.length), 'hex'),
  )
}

export function verifyRuntimePluginReleaseContentIdentity(release) {
  const digestVersion = Number(release?.digestVersion)
  if (digestVersion !== RUNTIME_PLUGIN_RELEASE_DIGEST_VERSION) {
    throw corruptRelease('缺少受支持的完整内容摘要')
  }
  const storedDigest = String(release?.releaseContentDigest || '').trim().toLowerCase()
  const identity = buildRuntimePluginReleaseContentIdentity(release)
  if (!equalDigest(storedDigest, identity.releaseContentDigest)) {
    throw corruptRelease('完整内容摘要不匹配')
  }
  return identity
}
