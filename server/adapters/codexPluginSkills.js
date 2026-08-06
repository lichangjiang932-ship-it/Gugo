/**
 * Read-only adapter for Codex plugin repositories.
 *
 * Discovery reads only `.codex-plugin/plugin.json` and nested skill manifests.
 * App descriptors, MCP descriptors, scripts, hooks, agents, and commands are
 * classified as requirements but are never loaded or executed here.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseCodexSkillMarkdown } from './codexSkillMarkdown.js'

export { parseCodexSkillMarkdown }

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_REPO_ROOT = path.resolve(__dirname, '../..')

export const CODEX_SKILL_COMPATIBILITY = Object.freeze([
  'ready',
  'needs-app',
  'needs-mcp',
  'needs-runtime',
])

export const RECOMMENDED_CODEX_PLUGINS = Object.freeze({
  'build-web-apps': 'https://github.com/openai/plugins',
  coderabbit: 'https://github.com/coderabbitai/codex-plugin',
  'game-studio': 'https://github.com/openai/plugins',
  'plugin-eval': 'https://github.com/openai/plugins',
  remotion: 'https://github.com/remotion-dev/remotion',
  superpowers: 'https://github.com/obra/superpowers',
})

const MAX_MANIFEST_BYTES = 256 * 1024
const MAX_SKILL_BYTES = 512 * 1024
const MAX_SKILL_METADATA_BYTES = 64 * 1024
const MAX_SCAN_DIRECTORIES = 20_000
const MAX_MANIFESTS = 2_000
const MAX_SKILLS = 5_000
const MAX_MANIFEST_DEPTH = 5
const MAX_SKILL_DEPTH = 8
const MANIFEST_SCAN_SKIP = new Set([
  '.git', '.github', '.agents', 'node_modules', 'assets', 'skills', 'scripts',
  'agents', 'commands', 'references', 'tests', 'fixtures', 'examples',
])
const SKILL_SCAN_SKIP = new Set([
  '.git', '.github', 'node_modules', 'assets', 'scripts', 'agents', 'commands',
  'references', 'reference', 'tests', 'fixtures', 'examples', 'evals', 'evaluations',
])
const RUNTIME_MARKERS = Object.freeze([
  'scripts', 'commands', 'bin', 'preflight', 'workflows', 'hooks.json',
])
const RUNTIME_MARKER_SET = new Set(RUNTIME_MARKERS)
const SKILL_RESOURCE_REFERENCE_RE = /(?:^|[\s("'`<[])(?:\.\.?[\\/])?(references?|assets|templates)[\\/]/gim

let CURRENT_SKILLS = []
let CURRENT_SKILL_SOURCES = new Map()
let PROMPT_CACHE = new Map()
let LAST_DISCOVERY = { roots: [], plugins: [], skills: [], errors: [] }

const SKILL_SOURCE = Symbol('codexPluginSkillSource')

function normalizedPathKey(value) {
  const normalized = path.normalize(String(value || ''))
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function isInside(root, target) {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
}

function cloneRequirements(requirements = {}) {
  return {
    app: !!requirements.app,
    mcp: !!requirements.mcp,
    runtime: Array.isArray(requirements.runtime) ? [...requirements.runtime] : [],
  }
}

function cloneSkill(skill) {
  return {
    ...skill,
    permissions: [...(skill.permissions || [])],
    perms: [...(skill.perms || [])],
    requirements: cloneRequirements(skill.requirements),
    source: skill.source ? { ...skill.source } : null,
  }
}

function clonePlugin(plugin) {
  return {
    ...plugin,
    requirements: cloneRequirements(plugin.requirements),
    source: plugin.source ? { ...plugin.source } : null,
  }
}

function discoveryError(code, target, message) {
  return { code, target: String(target || ''), message: String(message || code) }
}

function trimOuterQuotes(value) {
  const input = String(value || '').trim()
  if (input.length >= 2 && (
    (input.startsWith('"') && input.endsWith('"'))
    || (input.startsWith("'") && input.endsWith("'"))
  )) return input.slice(1, -1).trim()
  return input
}

export function parseCodexPluginRoots(value, { delimiter = path.delimiter } = {}) {
  const input = String(value || '').trim()
  if (!input) return []
  if (input.startsWith('[')) {
    try {
      const parsed = JSON.parse(input)
      if (Array.isArray(parsed)) return parsed.map(trimOuterQuotes).filter(Boolean)
    } catch {
      // Fall through to the platform-delimited form.
    }
  }
  return input
    .split(/\r?\n/)
    .flatMap((line) => line.split(delimiter))
    .map(trimOuterQuotes)
    .filter(Boolean)
}

function ancestorCandidates(startPath) {
  const candidates = []
  let current = path.resolve(startPath)
  while (true) {
    if (path.basename(current).toLowerCase() === 'codex-plugins') candidates.push(current)
    candidates.push(path.join(current, 'codex-plugins'))
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return candidates
}

function isReadableDirectory(target) {
  try {
    const stat = fs.lstatSync(target)
    return stat.isDirectory() && !stat.isSymbolicLink()
  } catch {
    return false
  }
}

export function resolveCodexPluginRoots({
  env = process.env,
  repoRoot = DEFAULT_REPO_ROOT,
  cwd = process.cwd(),
  includeAuto = true,
} = {}) {
  const configured = parseCodexPluginRoots(env.CODEX_PLUGIN_ROOTS)
    .map((root) => path.resolve(repoRoot, root))
  const automatic = includeAuto
    ? [...ancestorCandidates(repoRoot), ...ancestorCandidates(cwd)].filter(isReadableDirectory)
    : []
  const seen = new Set()
  return [...configured, ...automatic].filter((root) => {
    const key = normalizedPathKey(root)
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function readBoundedText(filePath, maxBytes) {
  const stat = fs.lstatSync(filePath)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('not a regular file')
  if (stat.size > maxBytes) throw new Error(`file exceeds ${maxBytes} bytes`)
  return fs.readFileSync(filePath, 'utf8')
}

function manifestAt(directory) {
  const markerDir = path.join(directory, '.codex-plugin')
  const manifestPath = path.join(markerDir, 'plugin.json')
  try {
    const markerStat = fs.lstatSync(markerDir)
    const manifestStat = fs.lstatSync(manifestPath)
    if (!markerStat.isDirectory() || markerStat.isSymbolicLink()) return null
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) return null
    return manifestPath
  } catch {
    return null
  }
}

function collectManifestPaths(root, errors) {
  const manifests = []
  const stack = [{ directory: root, depth: 0 }]
  let visited = 0
  while (stack.length && manifests.length < MAX_MANIFESTS) {
    const { directory, depth } = stack.pop()
    visited += 1
    if (visited > MAX_SCAN_DIRECTORIES) {
      errors.push(discoveryError('SCAN_LIMIT', root, `directory scan exceeded ${MAX_SCAN_DIRECTORIES}`))
      break
    }
    const manifestPath = manifestAt(directory)
    if (manifestPath) {
      manifests.push(manifestPath)
      continue
    }
    if (depth >= MAX_MANIFEST_DEPTH) continue
    let entries
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true })
    } catch (error) {
      errors.push(discoveryError('READ_DIRECTORY_FAILED', directory, error.message))
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || MANIFEST_SCAN_SKIP.has(entry.name)) continue
      stack.push({ directory: path.join(directory, entry.name), depth: depth + 1 })
    }
  }
  if (manifests.length >= MAX_MANIFESTS) {
    errors.push(discoveryError('MANIFEST_LIMIT', root, `manifest count reached ${MAX_MANIFESTS}`))
  }
  return manifests.sort()
}

function slug(value, fallback = 'skill') {
  const normalized = String(value || '').toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return normalized || fallback
}

function boundedText(value, maxLength = 2_000) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}

function safeWebUrl(value) {
  const raw = typeof value === 'string'
    ? value
    : value && typeof value === 'object' && typeof value.url === 'string'
      ? value.url
      : ''
  try {
    const parsed = new URL(raw.trim())
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href.replace(/\/$/, '') : ''
  } catch {
    return ''
  }
}

function canonicalRepository(value) {
  return safeWebUrl(value).replace(/\.git$/i, '').toLowerCase()
}

function pluginMetadata(manifest, pluginId) {
  const repository = safeWebUrl(manifest.repository)
  const license = boundedText(manifest.license, 120)
  const homepage = safeWebUrl(manifest.homepage || manifest.interface?.websiteURL)
  const publisher = boundedText(
    typeof manifest.author === 'string' ? manifest.author : manifest.author?.name,
    120,
  ) || boundedText(manifest.interface?.developerName, 120)
  const expectedRepository = RECOMMENDED_CODEX_PLUGINS[pluginId]
  const recommended = license.toUpperCase() === 'MIT'
    && !!expectedRepository
    && canonicalRepository(repository) === canonicalRepository(expectedRepository)
  return { homepage, license, publisher, recommended, repository }
}

function stableSkillId(pluginId, skillId, sourceKey) {
  const base = `codex-${slug(pluginId, 'plugin')}-${slug(skillId)}`
  if (base.length <= 64) return base
  const suffix = crypto.createHash('sha256').update(sourceKey).digest('hex').slice(0, 8)
  return `${base.slice(0, 55).replace(/-+$/g, '')}-${suffix}`
}

function safeRelativeRoots(manifest) {
  const declared = Array.isArray(manifest.skills) ? manifest.skills : [manifest.skills || 'skills']
  return declared.map(String).map((value) => value.trim()).filter((value) => {
    if (!value || path.isAbsolute(value)) return false
    return !value.split(/[\\/]/).includes('..')
  })
}

function resolveSkillRoots(pluginRoot, manifest, errors) {
  const roots = []
  for (const relativeRoot of safeRelativeRoots(manifest)) {
    const candidate = path.resolve(pluginRoot, relativeRoot)
    if (!isInside(pluginRoot, candidate)) {
      errors.push(discoveryError('SKILL_ROOT_ESCAPE', relativeRoot, 'skill root escapes plugin directory'))
      continue
    }
    try {
      const stat = fs.lstatSync(candidate)
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue
      const canonical = fs.realpathSync(candidate)
      if (!isInside(pluginRoot, canonical)) {
        errors.push(discoveryError('SKILL_ROOT_ESCAPE', relativeRoot, 'skill root resolves outside plugin directory'))
        continue
      }
      roots.push(canonical)
    } catch {
      // Plugins without a skills directory are valid catalog entries.
    }
  }
  return [...new Set(roots.map(normalizedPathKey))].map((key) => roots.find((root) => normalizedPathKey(root) === key))
}

function collectSkillFiles(skillRoot, errors) {
  const files = []
  const stack = [{ directory: skillRoot, depth: 0 }]
  let visited = 0
  while (stack.length && files.length < MAX_SKILLS) {
    const { directory, depth } = stack.pop()
    visited += 1
    if (visited > MAX_SCAN_DIRECTORIES) {
      errors.push(discoveryError('SCAN_LIMIT', skillRoot, `skill scan exceeded ${MAX_SCAN_DIRECTORIES}`))
      break
    }
    let entries
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true })
    } catch (error) {
      errors.push(discoveryError('READ_DIRECTORY_FAILED', directory, error.message))
      continue
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const entryPath = path.join(directory, entry.name)
      if (entry.isFile() && entry.name === 'SKILL.md') files.push(entryPath)
      else if (entry.isDirectory() && depth < MAX_SKILL_DEPTH && !SKILL_SCAN_SKIP.has(entry.name)) {
        stack.push({ directory: entryPath, depth: depth + 1 })
      }
    }
  }
  if (files.length >= MAX_SKILLS) {
    errors.push(discoveryError('SKILL_LIMIT', skillRoot, `skill count reached ${MAX_SKILLS}`))
  }
  return files.sort()
}

function referencedSkillResourceRequirements(skillText) {
  const requirements = []
  for (const match of String(skillText || '').matchAll(SKILL_RESOURCE_REFERENCE_RE)) {
    const directory = match[1].toLowerCase() === 'reference' ? 'references' : match[1].toLowerCase()
    requirements.push(`resource:${directory}`)
  }
  return [...new Set(requirements)].sort()
}

function runtimeRequirements(pluginRoot, skillDir, manifest, skillText = '') {
  const requirements = []
  const declared = ['runtime', 'scripts', 'commands', 'hooks']
    .filter((key) => manifest[key] != null)
    .map((key) => `manifest:${key}`)
  requirements.push(...declared)
  const base = skillDir ? path.resolve(skillDir) : null
  if (base) {
    try {
      for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
        if (entry.isSymbolicLink() || !RUNTIME_MARKER_SET.has(entry.name)) continue
        const candidate = path.join(base, entry.name)
        const relative = pluginRoot && isInside(path.resolve(pluginRoot), candidate)
          ? path.relative(path.resolve(pluginRoot), candidate)
          : entry.name
        requirements.push(relative.replace(/\\/g, '/'))
      }
    } catch {
      // Missing or unreadable skill directories are handled by discovery.
    }
  }
  requirements.push(...referencedSkillResourceRequirements(skillText))
  return [...new Set(requirements)].sort()
}

export function classifyCodexSkill({ manifest = {}, pluginRoot = '', skillDir = '', skillText = '' } = {}) {
  const requirements = {
    app: manifest.apps != null,
    mcp: manifest.mcpServers != null,
    runtime: runtimeRequirements(pluginRoot, skillDir, manifest, skillText),
  }
  const compatibility = requirements.app
    ? 'needs-app'
    : requirements.mcp
      ? 'needs-mcp'
      : requirements.runtime.length
        ? 'needs-runtime'
        : 'ready'
  return { compatibility, requirements }
}

function loadManifest(manifestPath, sourceRoot, errors) {
  let manifest
  try {
    manifest = JSON.parse(readBoundedText(manifestPath, MAX_MANIFEST_BYTES))
  } catch (error) {
    errors.push(discoveryError('MANIFEST_INVALID', manifestPath, error.message))
    return null
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || !String(manifest.name || '').trim()) {
    errors.push(discoveryError('MANIFEST_INVALID', manifestPath, 'manifest requires a name'))
    return null
  }
  const pluginRoot = fs.realpathSync(path.dirname(path.dirname(manifestPath)))
  if (!isInside(sourceRoot, pluginRoot)) {
    errors.push(discoveryError('PLUGIN_ROOT_ESCAPE', manifestPath, 'plugin resolves outside configured root'))
    return null
  }
  return { manifest, pluginRoot }
}

function adaptSkill({ manifest, pluginRoot, skillPath, sourceRoot, seenIds, errors }) {
  let skillText
  let metadataText
  try {
    skillText = readBoundedText(skillPath, MAX_SKILL_BYTES)
    metadataText = skillText.slice(0, MAX_SKILL_METADATA_BYTES)
  } catch (error) {
    errors.push(discoveryError('SKILL_READ_FAILED', skillPath, error.message))
    return null
  }
  if (!metadataText.trim()) {
    errors.push(discoveryError('SKILL_EMPTY', skillPath, 'SKILL.md is empty'))
    return null
  }
  const { meta } = parseCodexSkillMarkdown(metadataText)
  const rawSkillId = meta.id || meta.name || path.basename(path.dirname(skillPath))
  const pluginId = slug(manifest.name, 'plugin')
  const relativePath = path.relative(pluginRoot, skillPath).replace(/\\/g, '/')
  let id = stableSkillId(pluginId, rawSkillId, `${pluginRoot}\0${relativePath}`)
  if (seenIds.has(id)) {
    const suffix = crypto.createHash('sha256').update(`${pluginRoot}\0${relativePath}`).digest('hex').slice(0, 8)
    id = `${id.slice(0, 55).replace(/-+$/g, '')}-${suffix}`
  }
  if (seenIds.has(id)) {
    errors.push(discoveryError('DUPLICATE_SKILL_ID', relativePath, `duplicate skill id: ${id}`))
    return null
  }
  const classification = classifyCodexSkill({
    manifest,
    pluginRoot,
    skillDir: path.dirname(skillPath),
    skillText,
  })
  const displayName = String(meta.name || rawSkillId).trim().slice(0, 120) || id
  const description = String(meta.description || meta.desc || manifest.description || displayName).trim().slice(0, 2_000)
  const pluginName = String(manifest.interface?.displayName || manifest.name).trim().slice(0, 120)
  const metadata = pluginMetadata(manifest, pluginId)
  seenIds.add(id)
  const skill = {
    id,
    name: displayName,
    desc: description,
    description,
    icon: '🧩',
    permissions: [],
    perms: [],
    recommended: metadata.recommended,
    custom: false,
    imported: false,
    external: true,
    readOnly: true,
    codexPlugin: true,
    runnable: classification.compatibility === 'ready',
    compatibility: classification.compatibility,
    status: classification.compatibility,
    requirements: classification.requirements,
    version: String(manifest.version || '0.0.0').slice(0, 64),
    pluginId,
    pluginName,
    homepage: metadata.homepage,
    license: metadata.license,
    publisher: metadata.publisher,
    repository: metadata.repository,
    source: {
      type: 'codex-plugin',
      pluginId,
      pluginName,
      path: relativePath,
      skillPath: relativePath,
      rootName: path.basename(sourceRoot),
    },
  }
  Object.defineProperty(skill, SKILL_SOURCE, {
    value: Object.freeze({
      pluginRoot,
      skillPath: fs.realpathSync(skillPath),
    }),
  })
  return skill
}

export function discoverCodexPluginSkills({
  roots,
  env = process.env,
  repoRoot = DEFAULT_REPO_ROOT,
  cwd = process.cwd(),
  includeAuto = true,
} = {}) {
  const requestedRoots = Array.isArray(roots)
    ? roots.map((root) => path.resolve(root))
    : resolveCodexPluginRoots({ env, repoRoot, cwd, includeAuto })
  const result = { roots: [], plugins: [], skills: [], errors: [] }
  const seenRoots = new Set()
  const seenManifests = new Set()
  const seenIds = new Set()
  for (const requestedRoot of requestedRoots) {
    let sourceRoot
    try {
      const stat = fs.lstatSync(requestedRoot)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('root must be a real directory')
      sourceRoot = fs.realpathSync(requestedRoot)
    } catch (error) {
      result.errors.push(discoveryError('ROOT_UNAVAILABLE', requestedRoot, error.message))
      continue
    }
    const rootKey = normalizedPathKey(sourceRoot)
    if (seenRoots.has(rootKey)) continue
    seenRoots.add(rootKey)
    result.roots.push(sourceRoot)
    for (const manifestPath of collectManifestPaths(sourceRoot, result.errors)) {
      const manifestKey = normalizedPathKey(fs.realpathSync(manifestPath))
      if (seenManifests.has(manifestKey)) continue
      seenManifests.add(manifestKey)
      const loaded = loadManifest(manifestPath, sourceRoot, result.errors)
      if (!loaded) continue
      const { manifest, pluginRoot } = loaded
      const pluginId = slug(manifest.name, 'plugin')
      const metadata = pluginMetadata(manifest, pluginId)
      const pluginClassification = classifyCodexSkill({ manifest, pluginRoot, skillDir: pluginRoot })
      const plugin = {
        id: pluginId,
        name: String(manifest.interface?.displayName || manifest.name).trim().slice(0, 120),
        version: String(manifest.version || '0.0.0').slice(0, 64),
        description: String(manifest.description || '').slice(0, 2_000),
        homepage: metadata.homepage,
        license: metadata.license,
        publisher: metadata.publisher,
        recommended: metadata.recommended,
        repository: metadata.repository,
        compatibility: pluginClassification.compatibility,
        requirements: pluginClassification.requirements,
        source: {
          type: 'codex-plugin',
          directory: path.relative(sourceRoot, pluginRoot).replace(/\\/g, '/'),
          rootName: path.basename(sourceRoot),
        },
      }
      result.plugins.push(plugin)
      for (const skillRoot of resolveSkillRoots(pluginRoot, manifest, result.errors)) {
        for (const skillPath of collectSkillFiles(skillRoot, result.errors)) {
          if (result.skills.length >= MAX_SKILLS) break
          const skill = adaptSkill({ manifest, pluginRoot, skillPath, sourceRoot, seenIds, errors: result.errors })
          if (skill) result.skills.push(skill)
        }
      }
    }
  }
  result.plugins.sort((left, right) => Number(right.recommended) - Number(left.recommended)
    || left.id.localeCompare(right.id))
  result.skills.sort((left, right) => Number(right.recommended) - Number(left.recommended)
    || left.id.localeCompare(right.id))
  return result
}

export function initCodexPluginSkills(options = {}) {
  const discovered = discoverCodexPluginSkills(options)
  CURRENT_SKILL_SOURCES = new Map(discovered.skills
    .map((skill) => [skill.id, skill[SKILL_SOURCE]])
    .filter(([, source]) => source))
  PROMPT_CACHE = new Map()
  CURRENT_SKILLS = discovered.skills.map(cloneSkill)
  LAST_DISCOVERY = {
    roots: [...discovered.roots],
    plugins: discovered.plugins.map(clonePlugin),
    skills: CURRENT_SKILLS.map(cloneSkill),
    errors: discovered.errors.map((error) => ({ ...error })),
  }
  return getCodexPluginDiscovery()
}

export function listCodexPluginSkills({ runnableOnly = false } = {}) {
  return CURRENT_SKILLS
    .filter((skill) => !runnableOnly || skill.runnable)
    .map(cloneSkill)
}

function loadCurrentSkillPrompt(id) {
  const source = CURRENT_SKILL_SOURCES.get(id)
  if (!source) return null
  try {
    const stat = fs.lstatSync(source.skillPath)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SKILL_BYTES) return null
    const realPath = fs.realpathSync(source.skillPath)
    if (!isInside(source.pluginRoot, realPath)
      || normalizedPathKey(realPath) !== normalizedPathKey(source.skillPath)) return null
    const cacheKey = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
    const cached = PROMPT_CACHE.get(id)
    if (cached?.key === cacheKey) return cached.prompt
    const { body } = parseCodexSkillMarkdown(readBoundedText(realPath, MAX_SKILL_BYTES))
    const prompt = String(body || '').trim()
    if (!prompt) return null
    PROMPT_CACHE.set(id, { key: cacheKey, prompt })
    return prompt
  } catch {
    return null
  }
}

export function getCodexPluginSkill(id, { runnableOnly = false, loadPrompt = false } = {}) {
  const skill = CURRENT_SKILLS.find((candidate) => candidate.id === id)
  if (!skill || (runnableOnly && !skill.runnable)) return null
  const cloned = cloneSkill(skill)
  if (!loadPrompt || !skill.runnable) return cloned
  const systemPrompt = loadCurrentSkillPrompt(skill.id)
  return systemPrompt ? { ...cloned, systemPrompt } : null
}

export function getCodexPluginDiscovery() {
  return {
    roots: [...LAST_DISCOVERY.roots],
    plugins: LAST_DISCOVERY.plugins.map(clonePlugin),
    skills: LAST_DISCOVERY.skills.map(cloneSkill),
    errors: LAST_DISCOVERY.errors.map((error) => ({ ...error })),
  }
}

export function _resetCodexPluginSkillsForTests() {
  CURRENT_SKILLS = []
  CURRENT_SKILL_SOURCES = new Map()
  PROMPT_CACHE = new Map()
  LAST_DISCOVERY = { roots: [], plugins: [], skills: [], errors: [] }
}
