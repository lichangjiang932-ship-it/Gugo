import path from 'node:path'

import { fetchWithEnvProxy } from '../adapters/proxyFetch.js'
import { fetchSafeOutbound } from '../utils/outboundNetworkGuard.js'
import { SKILL_PACK_LIMITS } from './skillImport.js'

const FETCH_TIMEOUT_MS = 15_000
const IMPORT_TIMEOUT_MS = 60_000
const MAX_API_BYTES = 512 * 1024
const RAW_HOST = 'raw.githubusercontent.com'
const API_HOST = 'api.github.com'
const RESOURCE_ROOTS = Object.freeze(['prompts', 'scripts', 'references', 'assets'])
const TEXT_EXTENSIONS = new Set([
  '.css', '.csv', '.go', '.graphql', '.h', '.html', '.ini', '.java', '.js', '.json', '.jsx',
  '.kt', '.lua', '.md', '.mjs', '.php', '.ps1', '.py', '.r', '.rb', '.rs', '.scss', '.sh',
  '.sql', '.svg', '.toml', '.ts', '.tsx', '.txt', '.xml', '.yaml', '.yml',
])
const MIME_TYPES = Object.freeze({
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.ttf': 'font/ttf',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
})

function safeGithubSegment(value) {
  const segment = String(value || '')
  if (!segment || segment === '.' || segment === '..' || segment.includes('\\') || segment.includes('/')) return null
  if ([...segment].some((character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127
  })) return null
  return segment
}

function decodePathSegments(pathname) {
  try {
    return pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part))
  } catch {
    return null
  }
}

export function parseGithubSkillUrl(url) {
  if (!url || typeof url !== 'string') return null
  let parsedUrl
  try {
    parsedUrl = new URL(url.trim())
  } catch {
    return null
  }
  if (
    parsedUrl.protocol !== 'https:' ||
    parsedUrl.hostname.toLowerCase() !== 'github.com' ||
    parsedUrl.port ||
    parsedUrl.username ||
    parsedUrl.password
  ) return null

  const parts = decodePathSegments(parsedUrl.pathname)
  if (!parts || parts.length < 2) return null
  const owner = safeGithubSegment(parts[0])
  const repoSegment = safeGithubSegment(parts[1])
  const repo = repoSegment?.replace(/\.git$/i, '')
  if (!owner || !repo || !/^[a-z0-9_.-]+$/i.test(owner) || !/^[a-z0-9_.-]+$/i.test(repo)) return null
  if (parts.length === 2) return { owner, repo, branch: 'HEAD', subpath: '' }
  if (!['tree', 'blob'].includes(parts[2]) || parts.length < 4) return null

  const branch = safeGithubSegment(parts[3])
  if (!branch) return null
  const remaining = parts.slice(4)
  if (remaining.some((part) => !safeGithubSegment(part))) return null
  if (parts[2] === 'blob') remaining.pop()
  return { owner, repo, branch, subpath: remaining.join('/') }
}

function encodeGithubPath(value) {
  return String(value || '').split('/').filter(Boolean).map(encodeURIComponent).join('/')
}

function buildRawUrl({ owner, repo, branch, subpath }, filePath) {
  const base = [subpath, filePath].filter(Boolean).join('/')
  return `https://${RAW_HOST}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(branch)}/${encodeGithubPath(base)}`
}

function buildApiUrl(parsed, suffix, query = {}) {
  const url = new URL(`https://${API_HOST}/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}/${suffix}`)
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
  }
  return url.toString()
}

function requestHeaders({ env = process.env, accept = 'application/vnd.github+json' } = {}) {
  const headers = {
    Accept: accept,
    'User-Agent': 'Gugo/skill-importer',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  const token = String(env?.GITHUB_TOKEN || env?.GH_TOKEN || '').trim()
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

async function readBoundedResponse(response, maxBytes) {
  const reader = response.body?.getReader?.()
  if (!reader) {
    const bytes = Buffer.from(await response.arrayBuffer())
    return bytes.length > maxBytes ? null : bytes
  }

  const chunks = []
  let totalBytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = Buffer.from(value)
      totalBytes += chunk.length
      if (totalBytes > maxBytes) {
        try { await reader.cancel() } catch { /* best effort */ }
        return null
      }
      chunks.push(chunk)
    }
    return Buffer.concat(chunks, totalBytes)
  } finally {
    reader.releaseLock?.()
  }
}

async function fetchBytes(url, {
  fetchImpl = fetchWithEnvProxy,
  env = process.env,
  lookup,
  maxBytes = SKILL_PACK_LIMITS.maxFileBytes,
  deadlineAt = 0,
  accept,
} = {}) {
  const remaining = deadlineAt ? deadlineAt - Date.now() : FETCH_TIMEOUT_MS
  if (remaining <= 0) return { ok: false, status: 0, reason: 'GitHub 技能导入超时' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.min(FETCH_TIMEOUT_MS, remaining))
  try {
    const resolveDns = typeof lookup === 'function'
      || fetchImpl === fetchWithEnvProxy
      || fetchImpl === globalThis.fetch
    const response = await fetchSafeOutbound(url, {
      headers: requestHeaders({ env, accept }),
      signal: controller.signal,
    }, {
      fetchImpl: (input, init) => fetchImpl(input, init, env),
      allowLocal: false,
      resolveDns,
      maxRedirects: 0,
      ...(typeof lookup === 'function' ? { lookup } : {}),
    })
    if (!response.ok) return { ok: false, status: response.status }
    const contentLength = Number(response.headers?.get?.('content-length') || 0)
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      return { ok: false, status: 0, reason: `远程文件超过 ${maxBytes} bytes` }
    }
    const bytes = await readBoundedResponse(response, maxBytes)
    if (!bytes) return { ok: false, status: 0, reason: `远程文件超过 ${maxBytes} bytes` }
    return { ok: true, bytes }
  } catch (error) {
    const reason = error?.name === 'AbortError' ? 'GitHub 请求超时' : (error?.message || 'GitHub 请求失败')
    return { ok: false, status: 0, reason }
  } finally {
    clearTimeout(timer)
  }
}

async function fetchRawFile(rawUrl, fetchImpl = fetchWithEnvProxy, options = {}) {
  const result = await fetchBytes(rawUrl, { ...options, fetchImpl, accept: 'application/octet-stream' })
  if (!result.ok) return result
  return { ...result, text: new TextDecoder('utf-8').decode(result.bytes) }
}

async function fetchJson(url, options = {}) {
  const result = await fetchBytes(url, { ...options, maxBytes: MAX_API_BYTES })
  if (!result.ok) return result
  try {
    return { ok: true, value: JSON.parse(result.bytes.toString('utf8')) }
  } catch {
    return { ok: false, status: 0, reason: 'GitHub API 返回了无效 JSON' }
  }
}

function parseInlineScalar(value) {
  const input = String(value || '').trim()
  if (input.length >= 2 && input.startsWith('"') && input.endsWith('"')) {
    try { return JSON.parse(input) } catch { return input.slice(1, -1) }
  }
  if (input.length >= 2 && input.startsWith("'") && input.endsWith("'")) {
    return input.slice(1, -1).replace(/''/g, "'")
  }
  return input
}

function parseBlockScalar(lines, startIndex, style, chomping) {
  const captured = []
  let index = startIndex
  while (index < lines.length) {
    const line = lines[index]
    if (line && !/^\s/.test(line)) break
    captured.push(line)
    index += 1
  }
  const indents = captured.filter((line) => line.trim()).map((line) => /^\s*/.exec(line)?.[0].length || 0)
  const indent = indents.length ? Math.min(...indents) : 0
  const values = captured.map((line) => line ? line.slice(Math.min(indent, line.length)) : '')
  let value
  if (style === '|') {
    value = values.join('\n')
  } else {
    value = values.reduce((result, line, lineIndex) => {
      if (lineIndex === 0) return line
      const previous = values[lineIndex - 1]
      return result + ((!line || !previous) ? '\n' : ' ') + line
    }, '')
  }
  if (chomping === '-') value = value.replace(/\n+$/g, '')
  else if (chomping !== '+' && captured.length) value = value.replace(/\n*$/g, '\n')
  return { value, nextIndex: index }
}

export function parseSkillMdFrontmatter(content) {
  const input = String(content || '').replace(/^\uFEFF/, '')
  const match = input.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/)
  if (!match) return { meta: {}, body: input }
  const lines = match[1].split(/\r?\n/)
  const meta = {}
  let index = 0
  while (index < lines.length) {
    const parsed = /^([a-zA-Z][a-zA-Z0-9_-]*)\s*:\s*(.*)$/.exec(lines[index])
    index += 1
    if (!parsed) continue
    const key = parsed[1].toLowerCase()
    const block = /^([>|])([+-])?$/.exec(parsed[2].trim())
    if (block) {
      const scalar = parseBlockScalar(lines, index, block[1], block[2] || '')
      meta[key] = scalar.value
      index = scalar.nextIndex
    } else {
      meta[key] = parseInlineScalar(parsed[2])
    }
  }
  return { meta, body: match[2] }
}

function sanitizeSkillId(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
}

export function adaptSkillMdToYma(content, { fallbackId = '', source } = {}) {
  const { meta, body } = parseSkillMdFrontmatter(content)
  const id = sanitizeSkillId(meta.id || meta.name || fallbackId)
  if (!id) return null
  const manifest = {
    id,
    name: String(meta.name || id).trim(),
    description: String(meta.description || meta.desc || id).trim(),
    version: String(meta.version || '0.1.0').trim(),
    icon: String(meta.icon || '🧩').trim(),
    permissions: [],
  }
  if (source) manifest.source = source
  return {
    'skill.json': JSON.stringify(manifest, null, 2),
    'prompts/system.md': body,
  }
}

async function resolveRevision(parsed, options) {
  const url = buildApiUrl(parsed, `commits/${encodeURIComponent(parsed.branch)}`)
  const result = await fetchJson(url, options)
  const sha = String(result.ok ? result.value?.sha || '' : '')
  if (/^[a-f0-9]{40}$/i.test(sha)) return { revision: sha, resolved: true }
  return { revision: parsed.branch, resolved: false }
}

function detectLicenseText(value) {
  const text = String(value || '')
  if (/MIT License/i.test(text)) return 'MIT'
  if (/Apache License[\s\S]{0,80}Version 2\.0/i.test(text)) return 'Apache-2.0'
  if (/GNU AFFERO GENERAL PUBLIC LICENSE[\s\S]{0,80}Version 3/i.test(text)) return 'AGPL-3.0'
  if (/GNU GENERAL PUBLIC LICENSE[\s\S]{0,80}Version 3/i.test(text)) return 'GPL-3.0'
  if (/Mozilla Public License[\s\S]{0,80}2\.0/i.test(text)) return 'MPL-2.0'
  if (/Redistribution and use in source and binary forms[\s\S]*three conditions/i.test(text)) return 'BSD-3-Clause'
  return ''
}

async function resolveLicense(parsed, revision, declaredLicense, options) {
  const url = buildApiUrl(parsed, 'license', { ref: revision })
  const result = await fetchJson(url, options)
  if (result.ok) {
    const spdx = String(result.value?.license?.spdx_id || '').trim()
    if (spdx && !['NOASSERTION', 'OTHER'].includes(spdx.toUpperCase())) {
      return { license: spdx, evidence: 'github-api' }
    }
    const encoded = String(result.value?.content || '').replace(/\s/g, '')
    const detected = encoded ? detectLicenseText(Buffer.from(encoded, 'base64').toString('utf8')) : ''
    if (detected) return { license: detected, evidence: 'github-api' }
  }
  const declared = String(declaredLicense || '').trim()
  return declared
    ? { license: declared.slice(0, 100), evidence: 'frontmatter' }
    : { license: 'NOASSERTION', evidence: 'unverified' }
}

function normalizeRepoPath(value) {
  const input = String(value || '').replace(/\\/g, '/')
  if (!input || input.startsWith('/') || /^[a-z]:/i.test(input)) return null
  if ([...input].some((character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127
  })) return null
  const segments = input.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null
  return segments.join('/')
}

function relativeSkillPath(parsed, repoPath) {
  const normalized = normalizeRepoPath(repoPath)
  if (!normalized) return null
  if (!parsed.subpath) return normalized
  const prefix = `${parsed.subpath}/`
  return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : null
}

/**
 * 从 GitHub contents API 响应中提取目录条目数组。
 * 普通目录返回数组；截断的大目录返回 { truncated: true, content: [...] }。
 * 非目录/异常结构返回 null（调用方据此区分"截断"与"不是目录"）。
 */
function extractDirectoryEntries(value) {
  if (Array.isArray(value)) return value
  if (Array.isArray(value?.content)) return value.content
  return null
}

function serializeResource(bytes, filePath) {
  const extension = path.posix.extname(filePath).toLowerCase()
  let text = null
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { /* binary */ }
  if (text != null && !text.includes('\0')) return { ok: true, content: text }
  if (!filePath.startsWith('assets/') || TEXT_EXTENSIONS.has(extension)) {
    return { ok: false, reason: `资源文件不是 UTF-8 文本: ${filePath}` }
  }
  const mime = MIME_TYPES[extension] || 'application/octet-stream'
  return { ok: true, content: `data:${mime};base64,${bytes.toString('base64')}` }
}

async function collectResourceFiles(parsed, revision, options) {
  const files = {}
  const seenDirectories = new Set()
  const deadlineAt = options.deadlineAt

  for (const root of RESOURCE_ROOTS) {
    const queue = [root]
    while (queue.length) {
      const relativeDirectory = queue.shift()
      if (seenDirectories.has(relativeDirectory)) continue
      seenDirectories.add(relativeDirectory)
      if (seenDirectories.size > SKILL_PACK_LIMITS.maxFiles) {
        return { ok: false, reason: `GitHub 技能目录数超过 ${SKILL_PACK_LIMITS.maxFiles}` }
      }
      const repoDirectory = [parsed.subpath, relativeDirectory].filter(Boolean).join('/')
      const apiUrl = buildApiUrl(parsed, `contents/${encodeGithubPath(repoDirectory)}`, { ref: revision })
      const listing = await fetchJson(apiUrl, { ...options, deadlineAt })
      if (!listing.ok && listing.status === 404 && relativeDirectory === root) break
      if (!listing.ok) return { ok: false, reason: `读取 GitHub 目录失败: ${relativeDirectory} (${listing.reason || listing.status})` }
      const directoryEntries = extractDirectoryEntries(listing.value)
      if (directoryEntries == null) {
        // GitHub contents API 对超过 1000 项的大目录返回 { truncated: true, content: [...] }。
        // 必须显式拒绝而非静默取部分内容，否则出现"安装成功但内容不全"。
        const truncated = listing.value?.truncated === true || listing.value?.content?.truncated === true
        return truncated
          ? { ok: false, reason: `GitHub 目录超过 1000 项被截断，安装会不完整: ${relativeDirectory}` }
          : { ok: false, reason: `GitHub 资源路径不是目录: ${relativeDirectory}` }
      }

      const entries = [...directoryEntries].sort((a, b) => String(a?.path || '').localeCompare(String(b?.path || '')))
      for (const entry of entries) {
        const relativePath = relativeSkillPath(parsed, entry?.path)
        if (!relativePath || !(relativePath === root || relativePath.startsWith(`${root}/`))) {
          return { ok: false, reason: `GitHub API 返回了越界路径: ${String(entry?.path || '')}` }
        }
        if (entry?.type === 'dir') {
          queue.push(relativePath)
          continue
        }
        if (entry?.type !== 'file') return { ok: false, reason: `不支持符号链接或子模块: ${relativePath}` }
        if (Object.keys(files).length + 3 >= SKILL_PACK_LIMITS.maxFiles) {
          return { ok: false, reason: `GitHub 技能文件数超过 ${SKILL_PACK_LIMITS.maxFiles}` }
        }
        if (Number(entry.size || 0) > SKILL_PACK_LIMITS.maxFileBytes) {
          return { ok: false, reason: `GitHub 技能文件过大: ${relativePath}` }
        }
        if (relativePath === 'prompts/system.md') continue
        const rawUrl = buildRawUrl({ ...parsed, branch: revision }, relativePath)
        const fetched = await fetchBytes(rawUrl, {
          ...options,
          deadlineAt,
          maxBytes: SKILL_PACK_LIMITS.maxFileBytes,
          accept: 'application/octet-stream',
        })
        if (!fetched.ok) return { ok: false, reason: `下载 GitHub 资源失败: ${relativePath} (${fetched.reason || fetched.status})` }
        const serialized = serializeResource(fetched.bytes, relativePath)
        if (!serialized.ok) return serialized
        files[relativePath] = serialized.content
      }
    }
  }
  return { ok: true, files }
}

function sourceUrl(parsed, revision) {
  const base = `https://github.com/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`
  return parsed.subpath
    ? `${base}/tree/${encodeURIComponent(revision)}/${encodeGithubPath(parsed.subpath)}`
    : base
}

function addSourceToManifest(skillJson, source) {
  try {
    const manifest = JSON.parse(skillJson)
    manifest.source = source
    return JSON.stringify(manifest, null, 2)
  } catch {
    return skillJson
  }
}

export async function fetchSkillPackFromGithub(parsed, {
  fetchImpl = fetchWithEnvProxy,
  env = process.env,
  lookup,
} = {}) {
  if (!parsed) return { ok: false, reason: '无效的 GitHub URL' }
  const deadlineAt = Date.now() + IMPORT_TIMEOUT_MS
  const options = { fetchImpl, env, deadlineAt, ...(typeof lookup === 'function' ? { lookup } : {}) }
  const resolved = await resolveRevision(parsed, options)
  const pinned = { ...parsed, branch: resolved.revision }

  const skillJsonUrl = buildRawUrl(pinned, 'skill.json')
  const skillJsonResult = await fetchRawFile(skillJsonUrl, fetchImpl, options)
  let format = 'yma'
  let files
  let declaredLicense = ''
  let primaryUrl = skillJsonUrl

  if (skillJsonResult.ok) {
    const systemPromptUrl = buildRawUrl(pinned, 'prompts/system.md')
    const systemPromptResult = await fetchRawFile(systemPromptUrl, fetchImpl, options)
    if (!systemPromptResult.ok) {
      return { ok: false, reason: `找到 skill.json，但缺少 prompts/system.md (${systemPromptResult.reason || systemPromptResult.status})` }
    }
    files = {
      'skill.json': skillJsonResult.text,
      'prompts/system.md': systemPromptResult.text,
    }
    try { declaredLicense = JSON.parse(skillJsonResult.text)?.license || '' } catch { /* validator reports malformed JSON */ }
  } else {
    format = 'skill-md'
    const skillMdUrl = buildRawUrl(pinned, 'SKILL.md')
    primaryUrl = skillMdUrl
    const skillMdResult = await fetchRawFile(skillMdUrl, fetchImpl, options)
    if (!skillMdResult.ok) {
      return {
        ok: false,
        reason: `仓库内未找到 skill.json 或 SKILL.md (HTTP ${skillJsonResult.status}/${skillMdResult.status})`,
      }
    }
    const parsedSkill = parseSkillMdFrontmatter(skillMdResult.text)
    declaredLicense = parsedSkill.meta.license || ''
    const fallbackId = parsed.subpath.split('/').filter(Boolean).at(-1) || parsed.repo
    files = adaptSkillMdToYma(skillMdResult.text, { fallbackId })
    if (!files) return { ok: false, reason: 'SKILL.md frontmatter 缺少可用的 id/name' }
    files['SKILL.md'] = skillMdResult.text
  }

  const license = await resolveLicense(parsed, resolved.revision, declaredLicense, options)
  const source = {
    type: 'github',
    repository: `${parsed.owner}/${parsed.repo}`,
    url: sourceUrl(parsed, resolved.revision),
    revision: resolved.revision,
    subpath: parsed.subpath || '',
    license: license.license,
    licenseEvidence: license.evidence,
  }
  files['skill.json'] = addSourceToManifest(files['skill.json'], source)

  const resources = await collectResourceFiles(parsed, resolved.revision, options)
  if (!resources.ok) return resources
  Object.assign(files, resources.files)

  return {
    ok: true,
    source: format,
    files,
    meta: {
      primaryUrl,
      revision: resolved.revision,
      revisionResolved: resolved.resolved,
      license: license.license,
      licenseEvidence: license.evidence,
      sourceUrl: source.url,
    },
  }
}

export async function installSkillFromGithubUrl({
  url,
  userId,
  installFn,
  listExistingIdsFn,
  fetchImpl = fetchWithEnvProxy,
  env = process.env,
  lookup,
}) {
  if (!userId) return { ok: false, reason: '请先登录后再导入技能' }
  if (typeof installFn !== 'function') return { ok: false, reason: '技能安装器不可用' }
  const parsed = parseGithubSkillUrl(url)
  if (!parsed) return { ok: false, reason: '只支持安全的 https://github.com/owner/repo[...] URL' }

  const fetched = await fetchSkillPackFromGithub(parsed, { fetchImpl, env, lookup })
  if (!fetched.ok) return { ok: false, reason: fetched.reason }
  const existingIds = typeof listExistingIdsFn === 'function' ? listExistingIdsFn({ userId }) : []
  const installed = installFn({ files: fetched.files, existingIds, userId })
  if (!installed.ok) return { ok: false, reason: installed.reason }
  return {
    ok: true,
    skill: installed.skill,
    source: fetched.source,
    repo: `${parsed.owner}/${parsed.repo}`,
    subpath: parsed.subpath || '',
    revision: fetched.meta.revision,
    license: fetched.meta.license,
    sourceUrl: fetched.meta.sourceUrl,
  }
}

export const __test = Object.freeze({
  API_HOST,
  IMPORT_TIMEOUT_MS,
  MAX_API_BYTES,
  RAW_HOST,
  RESOURCE_ROOTS,
  buildApiUrl,
  buildRawUrl,
  detectLicenseText,
  extractDirectoryEntries,
  fetchRawFile,
  normalizeRepoPath,
  serializeResource,
})
