import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { listEnabledMcpServerRevisionIdentities } from '../mcp/mcpStore.js'
import { CONNECTOR_TOOL_NAMES } from './connectorTools.js'
import { getBuiltinSpec, getDynamicTool } from './toolRegistry.js'

export const TOOL_IMPLEMENTATION_REVISION_VERSION = 1
export const TOOL_IMPLEMENTATION_REVISION_UNAVAILABLE = 'TOOL_IMPLEMENTATION_REVISION_UNAVAILABLE'

const MODULE_DIR = dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = resolve(MODULE_DIR, '..', '..')
const LOCAL_IMPORT_PATTERN = /\b(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"](\.[^'"]+)['"]/gu
const DYNAMIC_IMPORT_PATTERN = /\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/gu
const SOURCE_EXTENSIONS = Object.freeze(['.js', '.mjs', '.cjs', '.json'])
const CONNECTOR_TOOL_NAME_SET = new Set(CONNECTOR_TOOL_NAMES)
const localRevisionCache = new Map()

function revisionError(message) {
  const error = new Error(message)
  error.code = TOOL_IMPLEMENTATION_REVISION_UNAVAILABLE
  error.statusCode = 409
  error.retryable = false
  error.unsafeToReplay = true
  return error
}

function sha256(value) {
  return `sha256-${createHash('sha256').update(value).digest('hex')}`
}

function repositoryLabel(filePath) {
  const label = relative(REPOSITORY_ROOT, filePath).replace(/\\/gu, '/')
  if (!label || label === '..' || label.startsWith('../') || isAbsolute(label)) {
    throw revisionError('tool implementation source escapes the repository root')
  }
  return label
}

function resolveLocalImport(importerPath, specifier) {
  const clean = String(specifier || '').split(/[?#]/u, 1)[0]
  const base = resolve(dirname(importerPath), clean)
  const candidates = extname(base)
    ? [base]
    : [
        ...SOURCE_EXTENSIONS.map((extension) => `${base}${extension}`),
        ...SOURCE_EXTENSIONS.map((extension) => resolve(base, `index${extension}`)),
      ]
  return candidates.find((candidate) => {
    try {
      repositoryLabel(candidate)
      return existsSync(candidate)
    } catch {
      return false
    }
  }) || null
}

function localImports(source) {
  const imports = new Set()
  for (const pattern of [LOCAL_IMPORT_PATTERN, DYNAMIC_IMPORT_PATTERN]) {
    pattern.lastIndex = 0
    let match
    while ((match = pattern.exec(source)) !== null) imports.add(match[1])
  }
  return [...imports]
}

function moduleGraphRevision(entryLabels) {
  const cacheKey = [...entryLabels].sort().join('\u0000')
  if (localRevisionCache.has(cacheKey)) return localRevisionCache.get(cacheKey)
  const pending = [...entryLabels].map((label) => resolve(REPOSITORY_ROOT, label))
  const sources = new Map()
  while (pending.length) {
    const filePath = pending.pop()
    const label = repositoryLabel(filePath)
    if (sources.has(label)) continue
    let source
    try {
      source = readFileSync(filePath, 'utf8')
    } catch (error) {
      throw revisionError(`cannot read tool implementation source ${label}: ${error?.message || error}`)
    }
    sources.set(label, source)
    for (const specifier of localImports(source)) {
      const importedPath = resolveLocalImport(filePath, specifier)
      if (importedPath) pending.push(importedPath)
    }
  }
  const hash = createHash('sha256')
  for (const [label, source] of [...sources].sort(([left], [right]) => left.localeCompare(right, 'en'))) {
    hash.update(label)
    hash.update('\u0000')
    hash.update(source)
    hash.update('\u0000')
  }
  const revision = `sha256-${hash.digest('hex')}`
  localRevisionCache.set(cacheKey, revision)
  return revision
}

function builtinRevision() {
  return moduleGraphRevision([
    'server/services/loop/heuristics/toolExecutor.js',
    'server/utils/toolSchemaCatalog.js',
  ])
}

function connectorRevision() {
  return moduleGraphRevision(['server/services/connectorTools.js'])
}

function mcpBridgeRevision() {
  return moduleGraphRevision([
    'server/mcp/mcpManager.js',
    'server/mcp/mcpToolRegistry.js',
  ])
}

function normalizedToolNames(toolSpecs) {
  return [...new Set((Array.isArray(toolSpecs) ? toolSpecs : [])
    .map((spec) => String(spec?.function?.name || '').trim())
    .filter(Boolean))].sort((left, right) => left.localeCompare(right, 'en'))
}

function mcpServerForRegistration(servers, registration, userId) {
  const source = String(registration?.source || '')
  return servers.find((server) => source === `${userId}:${server.id}`) || null
}

function mcpToolRevision({ bridgeRevision, name, server }) {
  return sha256(JSON.stringify({
    bridgeRevision,
    configurationGeneration: server.updatedAt,
    serverId: server.id,
    toolName: name,
    transport: server.transport,
  }))
}

/**
 * Return a secret-free, replay-stable identity for executable server tools.
 * MCP credentials, endpoints, commands and arguments are never selected from
 * storage; any config write is represented only by the updatedAt generation.
 */
export function resolveToolImplementationRevisions({ userId = null, toolSpecs = [] } = {}) {
  const names = normalizedToolNames(toolSpecs)
  const implementations = {
    version: TOOL_IMPLEMENTATION_REVISION_VERSION,
    builtinRevision: builtinRevision(),
    connectorRevision: null,
    mcpTools: [],
  }
  let mcpServers = null
  let bridgeRevision = null
  for (const name of names) {
    if (getBuiltinSpec(name)) continue
    const registration = getDynamicTool(name, { userId })
    if (registration?.origin === 'connector' || CONNECTOR_TOOL_NAME_SET.has(name)) {
      implementations.connectorRevision ||= connectorRevision()
      continue
    }
    if (registration?.origin !== 'mcp' && !name.startsWith('mcp__')) continue
    if (!userId || registration?.origin !== 'mcp') {
      throw revisionError(`MCP tool ${name} has no verifiable local registration`)
    }
    mcpServers ||= listEnabledMcpServerRevisionIdentities(userId)
    const server = mcpServerForRegistration(mcpServers, registration, userId)
    if (!server) throw revisionError(`MCP tool ${name} has no verifiable configuration generation`)
    bridgeRevision ||= mcpBridgeRevision()
    implementations.mcpTools.push({
      name,
      revision: mcpToolRevision({ bridgeRevision, name, server }),
    })
  }
  return implementations
}

export const _toolImplementationRevisionInternals = Object.freeze({
  localImports,
  moduleGraphRevision,
})
