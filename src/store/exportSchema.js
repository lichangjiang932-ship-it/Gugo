// 数据导入/导出 schema —— 给会话和设置导出加版本号 + 校验,
// 让用户能跨设备 / 跨升级把状态搬来搬去而不会被恶意 / 损坏的 JSON 灌坏。
//
// 设计:
//   · 任何导出都包成 { __schema: 'yma.v1.<kind>', exportedAt, payload }
//   · 导入时先 parse → 检查 magic + version → 按 kind 走轻量结构校验 (不依赖 zod)
//   · 校验失败抛 InvalidExportError,UI 用 .reason 给用户人话提示
import { isThemeMode } from '../lib/themeMode.js'

export const SCHEMA_VERSION = 1
export const SESSIONS_SCHEMA = `yma.v${SCHEMA_VERSION}.sessions`
export const SETTINGS_SCHEMA = `yma.v${SCHEMA_VERSION}.settings`

// 已知 schema 列表 + 兼容老格式 (无 __schema)
const KNOWN = new Set([SESSIONS_SCHEMA, SETTINGS_SCHEMA])

export class InvalidExportError extends Error {
  constructor(reason) {
    super(reason)
    this.name = 'InvalidExportError'
    this.reason = reason
  }
}

/* ── 包装 ── */

export function wrapSessionsExport(sessions) {
  return {
    __schema: SESSIONS_SCHEMA,
    exportedAt: new Date().toISOString(),
    payload: Array.isArray(sessions) ? sessions : [],
  }
}

export function wrapSettingsExport(settings) {
  return {
    __schema: SETTINGS_SCHEMA,
    exportedAt: new Date().toISOString(),
    payload: settings && typeof settings === 'object' ? settings : {},
  }
}

/* ── 校验 ── */

function validateMessage(m) {
  if (!m || typeof m !== 'object') return false
  if (typeof m.role !== 'string') return false
  if (!['user', 'assistant', 'system'].includes(m.role)) return false
  if (typeof m.content !== 'string') return false
  return true
}

function validateSession(s) {
  if (!s || typeof s !== 'object') return { ok: false, reason: '会话项缺失' }
  if (typeof s.id !== 'string' || !s.id) return { ok: false, reason: 'session.id 必须为非空字符串' }
  if (typeof s.title !== 'string') return { ok: false, reason: 'session.title 必须为字符串' }
  if (!Array.isArray(s.messages)) return { ok: false, reason: 'session.messages 必须为数组' }
  for (const m of s.messages) {
    if (!validateMessage(m)) return { ok: false, reason: '存在不合法的 message (role/content 非法)' }
  }
  return { ok: true }
}

/**
 * 校验导入对象。允许:
 *   1. 包了 __schema 的现行格式
 *   2. 老格式: 直接是 sessions 数组 (兼容 PR #1 之前导出的文件)
 * 返回 { kind, payload } 或抛 InvalidExportError。
 */
export function parseImport(raw) {
  let data
  try {
    data = typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch {
    throw new InvalidExportError('文件不是合法 JSON')
  }
  if (!data || typeof data !== 'object') throw new InvalidExportError('文件内容不是对象')

  // ── 老格式: 裸 sessions 数组 ──
  if (Array.isArray(data)) {
    for (const s of data) {
      const r = validateSession(s)
      if (!r.ok) throw new InvalidExportError(`兼容旧格式校验失败: ${r.reason}`)
    }
    return { kind: 'sessions', payload: data, schema: 'legacy.sessions' }
  }

  const schema = data.__schema
  if (typeof schema !== 'string' || !KNOWN.has(schema)) {
    throw new InvalidExportError(`未知或不兼容的 schema: ${String(schema || '<missing>')}`)
  }
  if (!('payload' in data)) throw new InvalidExportError('缺少 payload 字段')

  if (schema === SESSIONS_SCHEMA) {
    if (!Array.isArray(data.payload)) throw new InvalidExportError('sessions payload 必须为数组')
    for (const s of data.payload) {
      const r = validateSession(s)
      if (!r.ok) throw new InvalidExportError(r.reason)
    }
    return { kind: 'sessions', payload: data.payload, schema }
  }

  if (schema === SETTINGS_SCHEMA) {
    const p = data.payload
    if (!p || typeof p !== 'object' || Array.isArray(p)) {
      throw new InvalidExportError('settings payload 必须为对象')
    }
    // 字段类型软校验,缺失允许 (老导出没全字段)
    const stringFields = ['theme', 'fontSize', 'density']
    for (const k of stringFields) {
      if (k in p && typeof p[k] !== 'string') {
        throw new InvalidExportError(`settings.${k} 必须为字符串`)
      }
    }
    if ('theme' in p && !isThemeMode(p.theme)) {
      throw new InvalidExportError('settings.theme 不是受支持的主题')
    }
    const booleanFields = ['animationsEnabled', 'inputHistoryNavigationEnabled']
    for (const k of booleanFields) {
      if (k in p && typeof p[k] !== 'boolean') {
        throw new InvalidExportError(`settings.${k} 必须为布尔`)
      }
    }
    if ('permissions' in p && !Array.isArray(p.permissions)) {
      throw new InvalidExportError('settings.permissions 必须为数组')
    }
    if ('skillConfigs' in p && (typeof p.skillConfigs !== 'object' || Array.isArray(p.skillConfigs))) {
      throw new InvalidExportError('settings.skillConfigs 必须为对象')
    }
    return { kind: 'settings', payload: p, schema }
  }

  // 不该走到这里
  throw new InvalidExportError(`未实现的 schema: ${schema}`)
}
