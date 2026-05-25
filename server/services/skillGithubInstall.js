/**
 * skillGithubInstall.js — Phase 2 A1
 *
 * 从 GitHub 仓库 URL 拉取 skill 并走现有 installValidatedSkillPack 管线安装。
 *
 * 支持两种仓库格式：
 *   1. yma 原生：`skill.json` + `prompts/system.md`（直接对接现有 schema）
 *   2. openhanako 风格：根目录或 subpath 下有 `SKILL.md`，YAML frontmatter 含 name/description 等
 *      → 自动转换成 yma 格式（合成一份 skill.json，把 markdown 当 system prompt）
 *
 * 安全策略（web 版精简版）：
 *   - 仅信任 github.com，其他域名拒绝
 *   - 文件大小 ≤ 200KB
 *   - 不执行任何远程代码（永远只读 markdown / json）
 *
 * 不做的事：
 *   - star 门槛（web 用户已知导入风险，前端会展示来源）
 *   - LLM 安全审查（yma 没有专用 utility model）
 */

const MAX_FILE_BYTES = 200 * 1024
const FETCH_TIMEOUT = 15_000
const RAW_HOST = 'raw.githubusercontent.com'
const API_HOST = 'api.github.com'

/**
 * 解析 GitHub URL → { owner, repo, branch, subpath }
 *
 * 支持：
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo/tree/<branch>/<subpath>
 *   https://github.com/owner/repo/blob/<branch>/<file>
 */
export function parseGithubSkillUrl(url) {
  if (!url || typeof url !== 'string') return null
  let u
  try {
    u = new URL(url.trim())
  } catch {
    return null
  }
  if (u.hostname !== 'github.com') return null
  const parts = u.pathname.split('/').filter(Boolean)
  if (parts.length < 2) return null
  const owner = parts[0]
  const repo = parts[1]
  let branch = 'HEAD'
  let subpath = ''
  // /tree/<branch>/<subpath...> 或 /blob/<branch>/<file...>
  const treeIdx = parts.findIndex((p, i) => i >= 2 && (p === 'tree' || p === 'blob'))
  if (treeIdx !== -1 && parts.length > treeIdx + 1) {
    branch = parts[treeIdx + 1] || 'HEAD'
    if (parts.length > treeIdx + 2) {
      subpath = parts.slice(treeIdx + 2).join('/')
      // /blob/<branch>/<file> → 取目录
      if (parts[treeIdx] === 'blob') {
        subpath = subpath.replace(/\/[^/]+$/, '')
      }
    }
  }
  return { owner, repo, branch, subpath }
}

function buildRawUrl({ owner, repo, branch, subpath }, filePath) {
  const cleanSubpath = subpath ? `${subpath.replace(/^\/+|\/+$/g, '')}/` : ''
  return `https://${RAW_HOST}/${owner}/${repo}/${branch}/${cleanSubpath}${filePath}`
}

async function fetchRawFile(rawUrl, fetchImpl = fetch) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT)
  try {
    const r = await fetchImpl(rawUrl, {
      headers: { 'User-Agent': 'your-model-atelier/skill-importer' },
      signal: controller.signal,
    })
    if (!r.ok) return { ok: false, status: r.status }
    // 不能完全信任 content-length，但能抓多少抓多少
    const ab = await r.arrayBuffer()
    if (ab.byteLength > MAX_FILE_BYTES) {
      return { ok: false, status: 0, reason: `文件过大（>${MAX_FILE_BYTES} bytes）` }
    }
    const text = new TextDecoder('utf-8').decode(ab)
    return { ok: true, text }
  } catch (err) {
    return { ok: false, status: 0, reason: err?.message || 'fetch failed' }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 解析 SKILL.md 的 YAML frontmatter（轻量版，只取一级 key: value 行）
 */
export function parseSkillMdFrontmatter(content) {
  const body = String(content || '')
  const match = body.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n([\s\S]*)$/)
  if (!match) return { meta: {}, body: body }
  const meta = {}
  const lines = match[1].split(/\r?\n/)
  for (const line of lines) {
    const m = line.match(/^([a-zA-Z][a-zA-Z0-9_-]*)\s*:\s*(.*)$/)
    if (!m) continue
    let val = m[2].trim()
    // 去掉首尾引号
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    meta[m[1].toLowerCase()] = val
  }
  return { meta, body: match[2] }
}

/**
 * 把 SKILL.md 风格的 frontmatter + markdown 转换成 yma installValidatedSkillPack 接受的 files 结构
 *   files['skill.json']            ← 合成的 manifest
 *   files['prompts/system.md']     ← markdown body
 */
export function adaptSkillMdToYma(content) {
  const { meta, body } = parseSkillMdFrontmatter(content)
  const rawId = String(meta.id || meta.name || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  if (!rawId) return null
  const manifest = {
    id: rawId,
    name: String(meta.name || rawId),
    description: String(meta.description || meta.desc || rawId),
    version: String(meta.version || '0.1.0'),
    icon: String(meta.icon || '✨'),
    permissions: [],
  }
  return {
    'skill.json': JSON.stringify(manifest, null, 2),
    'prompts/system.md': body,
  }
}

/**
 * 尝试从 GitHub 仓库拉取 skill pack 文件
 *
 * @returns {Promise<{ok: true, files: Record<string,string>, source: 'yma'|'skill-md', meta: object}|{ok:false, reason:string}>}
 */
export async function fetchSkillPackFromGithub(parsed, { fetchImpl = fetch } = {}) {
  if (!parsed) return { ok: false, reason: '无效的 GitHub URL' }
  // 先试 yma 原生：skill.json + prompts/system.md
  const skillJsonUrl = buildRawUrl(parsed, 'skill.json')
  const sysPromptUrl = buildRawUrl(parsed, 'prompts/system.md')

  const skillJsonRes = await fetchRawFile(skillJsonUrl, fetchImpl)
  if (skillJsonRes.ok) {
    const sysRes = await fetchRawFile(sysPromptUrl, fetchImpl)
    if (!sysRes.ok) {
      return { ok: false, reason: `找到 skill.json 但 prompts/system.md 缺失（${sysRes.reason || sysRes.status}）` }
    }
    return {
      ok: true,
      source: 'yma',
      files: { 'skill.json': skillJsonRes.text, 'prompts/system.md': sysRes.text },
      meta: { skillJsonUrl, sysPromptUrl },
    }
  }

  // 退化路径：SKILL.md
  const skillMdUrl = buildRawUrl(parsed, 'SKILL.md')
  const skillMdRes = await fetchRawFile(skillMdUrl, fetchImpl)
  if (skillMdRes.ok) {
    const adapted = adaptSkillMdToYma(skillMdRes.text)
    if (!adapted) {
      return { ok: false, reason: 'SKILL.md frontmatter 缺少 id/name 字段' }
    }
    return {
      ok: true,
      source: 'skill-md',
      files: adapted,
      meta: { skillMdUrl },
    }
  }

  return {
    ok: false,
    reason: `仓库内未找到可识别的 skill 文件：${skillJsonUrl} / ${skillMdUrl}（HTTP ${skillJsonRes.status}/${skillMdRes.status}）`,
  }
}

/**
 * 顶层入口：URL → files → installValidatedSkillPack
 *
 * 调用方需注入 installFn（= installValidatedSkillPack）和 listExistingIdsFn 以保持纯度。
 */
export async function installSkillFromGithubUrl({
  url,
  userId,
  installFn,
  listExistingIdsFn,
  fetchImpl = fetch,
}) {
  if (!userId) return { ok: false, reason: '请先登录后再导入技能' }
  const parsed = parseGithubSkillUrl(url)
  if (!parsed) return { ok: false, reason: '只支持 https://github.com/owner/repo[...] 形式的 URL' }

  const fetchResult = await fetchSkillPackFromGithub(parsed, { fetchImpl })
  if (!fetchResult.ok) return { ok: false, reason: fetchResult.reason }

  const existingIds = typeof listExistingIdsFn === 'function' ? listExistingIdsFn({ userId }) : []
  const installResult = installFn({
    files: fetchResult.files,
    existingIds,
    userId,
  })
  if (!installResult.ok) return { ok: false, reason: installResult.reason }
  return {
    ok: true,
    skill: installResult.skill,
    source: fetchResult.source,
    repo: `${parsed.owner}/${parsed.repo}`,
    subpath: parsed.subpath || '',
  }
}

// 内部辅助暴露给测试
export const __test = {
  buildRawUrl,
  fetchRawFile,
  MAX_FILE_BYTES,
  API_HOST,
}
