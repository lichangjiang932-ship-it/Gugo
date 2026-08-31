import { PROJECT_SCOPE_TARGET } from './heuristics/constants.js'
import { normalizeMutationTarget } from './heuristics/mutationClassification.js'

const DIAGNOSTIC_PATH_PATTERN = /(?:[a-z]:[\\/]|\/|\.{1,2}[\\/])?(?:[a-z0-9_@()[\].-]+[\\/])*[a-z0-9_@()[\].-]+\.(?:[cm]?[jt]sx?|py|rs|go|java|kt|cs|c|cc|cpp|h|hpp|rb|php|vue|svelte|json|ya?ml|toml|xml|html?|css|scss)/giu
const PROJECT_WIDE_MUTATION_NAMES = new Set([
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'tsconfig.json',
  'jsconfig.json',
  'cargo.toml',
  'cargo.lock',
  'go.mod',
  'go.sum',
  'pyproject.toml',
  'requirements.txt',
])
const GENERIC_PATH_STEMS = new Set(['index', 'main', 'test', 'tests', 'spec', 'lint', 'build'])

function normalizePathList(value, limit = 16) {
  const paths = new Set()
  for (const candidate of Array.isArray(value) ? value : []) {
    const normalized = normalizeMutationTarget(candidate)
    if (!normalized) continue
    paths.add(normalized.slice(0, 2_000))
    if (paths.size >= limit) break
  }
  return [...paths]
}

export function diagnosticPaths(result) {
  const source = [result?.stderr, result?.stdout, result?.error]
    .map((value) => String(value || ''))
    .join('\n')
    .slice(0, 20_000)
  return normalizePathList(source.match(DIAGNOSTIC_PATH_PATTERN) || [])
}

function comparablePath(value) {
  const normalized = normalizeMutationTarget(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function absolutePathLike(value) {
  return /^(?:[a-z]:\/|\/)/iu.test(String(value || ''))
}

function canonicalPath(value, workspaceRoot = '') {
  const normalized = normalizeMutationTarget(value)
  if (!normalized || normalized === PROJECT_SCOPE_TARGET || absolutePathLike(normalized)) {
    return comparablePath(normalized)
  }
  const root = normalizeMutationTarget(workspaceRoot)
  if (!root) return comparablePath(normalized)
  return comparablePath(normalizeMutationTarget(`${root}/${normalized === '.' ? '' : normalized}`))
}

function sameOrInside(candidate, container) {
  if (!candidate || !container) return false
  return candidate === container || candidate.startsWith(`${container}/`)
}

function pathStem(value) {
  const filename = comparablePath(value).split('/').at(-1) || ''
  const stem = filename
    .replace(/\.[^.]+$/u, '')
    .replace(/(?:[._-](?:test|tests|spec|specs|lint))$/u, '')
  return stem.length >= 3 && !GENERIC_PATH_STEMS.has(stem) ? stem : ''
}

function projectWideMutationTarget(value) {
  const filename = comparablePath(value).split('/').at(-1) || ''
  return PROJECT_WIDE_MUTATION_NAMES.has(filename)
    || /^(?:tsconfig|vite\.config|vitest\.config|jest\.config|eslint\.config)(?:\.[^.]+)*$/u.test(filename)
}

function mutationTargetAffectsScope(target, scope, workspaceRoot = '') {
  const normalizedTarget = normalizeMutationTarget(target)
  if (!normalizedTarget) return false
  // Root dependency/configuration mutations can affect every nested package
  // verifier even though the file itself is outside that verifier's cwd.
  if (normalizedTarget === PROJECT_SCOPE_TARGET || projectWideMutationTarget(normalizedTarget)) return true
  const cwd = String(scope?.cwd || '.').trim().replace(/\\/gu, '/').replace(/\/+$/u, '') || '.'
  const normalizedCwd = process.platform === 'win32' ? cwd.toLowerCase() : cwd
  if (normalizedCwd === '.' && !workspaceRoot) return !absolutePathLike(normalizedTarget)
  return sameOrInside(
    canonicalPath(normalizedTarget, workspaceRoot),
    canonicalPath(normalizedCwd, workspaceRoot),
  )
}

function diagnosticPathMatchesMutation(diagnosticPath, mutationTarget, workspaceRoot = '') {
  if (mutationTarget === PROJECT_SCOPE_TARGET || projectWideMutationTarget(mutationTarget)) return true
  const canonicalDiagnostic = canonicalPath(diagnosticPath, workspaceRoot)
  const canonicalMutation = canonicalPath(mutationTarget, workspaceRoot)
  if (sameOrInside(canonicalDiagnostic, canonicalMutation)
    || sameOrInside(canonicalMutation, canonicalDiagnostic)) return true
  const diagnosticStem = pathStem(diagnosticPath)
  return Boolean(diagnosticStem && diagnosticStem === pathStem(mutationTarget))
}

export function relatedMutationTargets(
  scope,
  paths,
  mutationTargets,
  workspaceRoot = '',
  limit = 64,
) {
  const inScope = normalizePathList(mutationTargets, limit)
    .filter((target) => mutationTargetAffectsScope(target, scope, workspaceRoot))
  if (inScope.length === 0) return []
  if (!Array.isArray(paths) || paths.length === 0) return inScope
  return inScope.filter((target) => paths.some((diagnosticPath) => (
    diagnosticPathMatchesMutation(diagnosticPath, target, workspaceRoot)
  )))
}
