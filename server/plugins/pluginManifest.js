/**
 * server/plugins/pluginManifest.js
 *
 * Plugin manifest 校验（纯函数，无外部依赖）。
 * Manifest 是纯 JSON，本阶段（v0.1）不执行任何 plugin 代码。
 *
 * Schema:
 *   id          string  必填  [a-z0-9-]+，全局唯一
 *   name        string  必填  人读名称，1..120
 *   version     string  必填  semver: MAJOR.MINOR.PATCH (+pre/build 可选)
 *   type        string  必填  枚举见 PLUGIN_TYPES
 *   entry       string  必填  相对 plugin 根目录的入口文件路径，禁止 .. / 绝对路径
 *   description string  可选  ≤ 2000
 *   author      string  可选  ≤ 200
 *   license     string  可选  ≤ 80
 *   tags        string[] 可选 每个 ≤ 40，总数 ≤ 20
 */

export const PLUGIN_TYPES = Object.freeze([
  'ppt-theme',
  'prompt-template',
  'asset-pack',
  'agent-template',
  'skill-bundle',
])

const ID_RE = /^[a-z0-9][a-z0-9-]*$/
// 宽松 semver：MAJOR.MINOR.PATCH(-prerelease)?(+build)?
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

function isStr(v) { return typeof v === 'string' }
function isNonEmptyStr(v, max) { return isStr(v) && v.length > 0 && v.length <= max }

/**
 * @param {unknown} json
 * @returns {{ ok: boolean, errors: string[], manifest: object | null }}
 */
export function validateManifest(json) {
  const errors = []
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return { ok: false, errors: ['manifest must be a plain object'], manifest: null }
  }
  const m = /** @type {Record<string, unknown>} */ (json)

  // id
  if (!isStr(m.id)) errors.push('id: required string')
  else if (!ID_RE.test(/** @type {string} */ (m.id))) errors.push('id: must match [a-z0-9][a-z0-9-]*')
  else if (/** @type {string} */ (m.id).length > 80) errors.push('id: too long (>80)')

  // name
  if (!isNonEmptyStr(m.name, 120)) errors.push('name: required non-empty string (≤120)')

  // version (semver)
  if (!isStr(m.version)) errors.push('version: required string')
  else if (!SEMVER_RE.test(/** @type {string} */ (m.version))) errors.push('version: not a valid semver (MAJOR.MINOR.PATCH)')

  // type
  if (!isStr(m.type)) errors.push('type: required string')
  else if (!PLUGIN_TYPES.includes(/** @type {string} */ (m.type))) {
    errors.push(`type: must be one of ${PLUGIN_TYPES.join('|')}`)
  }

  // entry
  if (!isStr(m.entry)) errors.push('entry: required string')
  else {
    const e = /** @type {string} */ (m.entry)
    if (!e) errors.push('entry: empty')
    else if (e.startsWith('/') || /^[A-Za-z]:[\\/]/.test(e)) errors.push('entry: must be relative (no leading /)')
    else if (e.split(/[\\/]/).includes('..')) errors.push('entry: must not contain ..')
  }

  // optional
  if (m.description !== undefined && (!isStr(m.description) || /** @type {string} */ (m.description).length > 2000)) {
    errors.push('description: must be string ≤2000 when present')
  }
  if (m.author !== undefined && (!isStr(m.author) || /** @type {string} */ (m.author).length > 200)) {
    errors.push('author: must be string ≤200 when present')
  }
  if (m.license !== undefined && (!isStr(m.license) || /** @type {string} */ (m.license).length > 80)) {
    errors.push('license: must be string ≤80 when present')
  }
  if (m.tags !== undefined) {
    if (!Array.isArray(m.tags)) errors.push('tags: must be array when present')
    else if (m.tags.length > 20) errors.push('tags: too many (>20)')
    else if (!m.tags.every((t) => isStr(t) && /** @type {string} */ (t).length > 0 && /** @type {string} */ (t).length <= 40)) {
      errors.push('tags: each item must be non-empty string ≤40')
    }
  }

  if (errors.length) return { ok: false, errors, manifest: null }

  const manifest = {
    id: m.id,
    name: m.name,
    version: m.version,
    type: m.type,
    entry: m.entry,
    description: m.description ?? '',
    author: m.author ?? '',
    license: m.license ?? '',
    tags: Array.isArray(m.tags) ? [...m.tags] : [],
  }
  return { ok: true, errors: [], manifest }
}
