import { createHash } from 'node:crypto'

import { redactSensitiveText } from '../../utils/toolCallHarness.js'
import { normalizeMutationTarget } from './heuristics/mutationClassification.js'
import { relatedMutationTargets } from './taskVerificationAttribution.js'
import { compactVerificationDiagnostic } from './taskVerificationResult.js'
import { MAX_TASK_VERIFICATION_FAILURES } from './taskVerificationRepairPresentation.js'
import {
  normalizeCheckKind,
  normalizeScopePath,
} from './taskVerificationCheckScope.js'

export const MAX_PENDING_TASK_VERIFICATIONS = 64
export const MAX_TASK_VERIFICATION_CANDIDATES = 64
export const MAX_TASK_VERIFICATION_INDETERMINATES = 64
export const MAX_TASK_VERIFICATION_MUTATION_TARGETS = 64

export const FAILURE_PENDING_REASON = 'verification_failed'
export const PRE_MUTATION_FAILURE_PENDING_REASON = 'failure_before_mutation'
export const STALE_SUCCESS_PENDING_REASON = 'mutation_after_success'

export function normalizeBatchId(value) {
  return String(value || '').trim().slice(0, 2_000)
}

export function normalizeEpoch(value) {
  const epoch = Math.floor(Number(value) || 0)
  return Number.isSafeInteger(epoch) && epoch > 0 ? epoch : 0
}

export function normalizePathList(value, limit = 16) {
  const paths = new Set()
  for (const candidate of Array.isArray(value) ? value : []) {
    const normalized = normalizeMutationTarget(candidate)
    if (!normalized) continue
    paths.add(normalized.slice(0, 2_000))
    if (paths.size >= limit) break
  }
  return [...paths]
}

function normalizeCoverage(value) {
  return value === 'targeted' ? 'targeted' : 'cwd'
}

function boundedIdentityText(value, maxLength = 1_000) {
  const text = redactSensitiveText(String(value || '').trim())
  if (text.length <= maxLength) return text
  const digest = createHash('sha256').update(text).digest('hex')
  return `${text.slice(0, Math.max(0, maxLength - digest.length - 1))}#${digest}`
}

export function normalizeScopeDescriptor(value, fallbackKind = '') {
  const legacy = String(value?.scope || '').split('\u0000')
  const kind = normalizeCheckKind(value?.kind || fallbackKind || legacy[0])
  if (!kind) return null
  const cwd = boundedIdentityText(normalizeScopePath(value?.cwd || legacy[1] || '.'), 1_000)
  const commandScope = boundedIdentityText(
    value?.commandScope || legacy.slice(2).join('\u0000'),
    1_000,
  )
  const verifierFamily = boundedIdentityText(
    value?.verifierFamily || commandScope || `kind:${kind}`,
    1_000,
  )
  return {
    kind,
    cwd,
    commandScope,
    verifierFamily,
    coverage: normalizeCoverage(value?.coverage),
    targetPaths: normalizePathList(value?.targetPaths),
    scopeLabel: boundedIdentityText(value?.scopeLabel || `${kind}@${cwd}`, 300),
    scope: `${kind}\u0000${cwd}\u0000${commandScope}`,
  }
}

export function normalizeFailure(value, fallbackKind = '') {
  const descriptor = normalizeScopeDescriptor(value, fallbackKind)
  if (!descriptor) return null
  const reason = [
    FAILURE_PENDING_REASON,
    PRE_MUTATION_FAILURE_PENDING_REASON,
    STALE_SUCCESS_PENDING_REASON,
  ].includes(value?.reason)
    ? value.reason
    : FAILURE_PENDING_REASON
  const defaultFailures = reason === FAILURE_PENDING_REASON ? 1 : 0
  return {
    ...descriptor,
    failures: Math.min(
      MAX_TASK_VERIFICATION_FAILURES,
      Math.max(0, Math.floor(Number(value?.failures) || defaultFailures)),
    ),
    reason,
    requiredEpoch: normalizeEpoch(value?.requiredEpoch || value?.mutationEpoch),
    diagnosticPaths: normalizePathList(value?.diagnosticPaths),
    mutationTargets: normalizePathList(value?.mutationTargets),
    tool: String(value?.tool || '').slice(0, 120),
    code: String(value?.code || 'task_verification_failed').slice(0, 160),
    message: compactVerificationDiagnostic(
      value?.message,
      reason === STALE_SUCCESS_PENDING_REASON
        ? 'The check passed before a later related mutation and must be rerun.'
        : 'The verification command returned a failing result.',
    ),
    lastFailureBatchId: normalizeBatchId(value?.lastFailureBatchId),
  }
}

export function normalizeCandidate(value) {
  const normalized = normalizeFailure({
    ...value,
    reason: PRE_MUTATION_FAILURE_PENDING_REASON,
    failures: 0,
  }, value?.kind)
  if (!normalized) return null
  return {
    ...normalized,
    observedEpoch: normalizeEpoch(value?.observedEpoch),
  }
}

export function normalizeVerified(value) {
  const descriptor = normalizeScopeDescriptor(value)
  if (!descriptor) return null
  return {
    ...descriptor,
    verifiedEpoch: normalizeEpoch(value?.verifiedEpoch),
  }
}

export function normalizeIndeterminate(value) {
  const descriptor = normalizeScopeDescriptor(value)
  if (!descriptor) return null
  return {
    ...descriptor,
    requiredEpoch: normalizeEpoch(value?.requiredEpoch || value?.mutationEpoch),
    mutationTargets: normalizePathList(value?.mutationTargets),
    tool: String(value?.tool || '').slice(0, 120),
    code: String(value?.code || 'VERIFICATION_INDETERMINATE').slice(0, 160),
    message: compactVerificationDiagnostic(
      value?.message,
      'The verification environment did not produce a conclusive result.',
    ),
  }
}

function restoreEntryMap(value, normalizer, limit) {
  const entries = new Map()
  for (const entry of (Array.isArray(value) ? value : []).slice(-limit)) {
    const normalized = normalizer(entry)
    if (normalized) entries.set(normalized.scope, normalized)
  }
  return entries
}

function restoreMutationTargets(value) {
  const targets = new Map()
  for (const entry of (Array.isArray(value) ? value : [])
    .slice(-MAX_TASK_VERIFICATION_MUTATION_TARGETS)) {
    const target = normalizeMutationTarget(entry?.target || entry)
    if (!target) continue
    targets.set(target, normalizeEpoch(entry?.epoch))
  }
  return targets
}

export function syncLastIndeterminate(state) {
  if (!state || !(state.indeterminate instanceof Map)) return null
  state.lastIndeterminate = [...state.indeterminate.values()].at(-1) || null
  return state.lastIndeterminate
}

export function markVerificationOverflow(state) {
  if (!state) return
  state.verificationOverflowed = true
}

function absolutePathLike(value) {
  return /^(?:[a-z]:\/|\/)/iu.test(String(value || ''))
}

function canonicalScopeCwd(value, workspaceRoot = '') {
  const cwd = normalizeScopePath(value)
  if (absolutePathLike(cwd)) return cwd
  const root = normalizeScopePath(workspaceRoot)
  if (!workspaceRoot || !absolutePathLike(root)) return cwd
  return normalizeScopePath(cwd === '.' ? root : `${root}/${cwd}`)
}

function cwdScopeCovers(coveringCwd, coveredCwd, workspaceRoot = '') {
  const covering = canonicalScopeCwd(coveringCwd, workspaceRoot)
  const covered = canonicalScopeCwd(coveredCwd, workspaceRoot)
  if (covering === '.') return covered === '.' || !absolutePathLike(covered)
  return covered === covering || covered.startsWith(`${covering}/`)
}

export function verificationScopeCovers(attempt, recorded, workspaceRoot = '') {
  if (attempt.kind !== recorded.kind) return false
  if (attempt.verifierFamily !== recorded.verifierFamily) return false
  if (attempt.coverage === 'targeted') return attempt.scope === recorded.scope
  return cwdScopeCovers(attempt.cwd, recorded.cwd, workspaceRoot)
}

export function relatedVerificationScopes(scopes, mutationTargets, workspaceRoot) {
  return scopes.map((scope) => ({
    ...scope,
    mutationTargets: relatedMutationTargets(
      scope,
      scope.coverage === 'targeted' ? scope.targetPaths : [],
      mutationTargets,
      workspaceRoot,
    ),
  })).filter((scope) => scope.mutationTargets.length > 0)
}

export function restoreTaskVerificationRepair(value = {}) {
  const pending = restoreEntryMap(value?.pending, normalizeFailure, MAX_PENDING_TASK_VERIFICATIONS)
  const candidates = restoreEntryMap(
    value?.candidates,
    normalizeCandidate,
    MAX_TASK_VERIFICATION_CANDIDATES,
  )
  const verified = restoreEntryMap(
    value?.verified,
    normalizeVerified,
    MAX_PENDING_TASK_VERIFICATIONS,
  )
  const legacyIndeterminate = normalizeIndeterminate(value?.lastIndeterminate)
  const indeterminate = restoreEntryMap(
    Array.isArray(value?.indeterminate)
      ? value.indeterminate
      : legacyIndeterminate ? [legacyIndeterminate] : [],
    normalizeIndeterminate,
    MAX_TASK_VERIFICATION_INDETERMINATES,
  )
  const lastIndeterminate = [...indeterminate.values()].at(-1) || null
  const mutationTargets = restoreMutationTargets(value?.mutationTargets)
  const mutationEpoch = Math.max(
    normalizeEpoch(value?.mutationEpoch),
    ...[...mutationTargets.values()],
    ...[...pending.values()].map((entry) => entry.requiredEpoch),
    ...[...verified.values()].map((entry) => entry.verifiedEpoch),
    ...[...indeterminate.values()].map((entry) => normalizeEpoch(entry?.requiredEpoch)),
  )
  return {
    pending,
    candidates,
    verified,
    indeterminate,
    lastIndeterminate,
    verificationOverflowed: value?.verificationOverflowed === true,
    mutationEpoch,
    mutationTargets,
    consecutiveFailures: Math.min(
      MAX_TASK_VERIFICATION_FAILURES,
      Math.max(0, Math.floor(Number(value?.consecutiveFailures) || 0)),
    ),
    lastFailureBatchId: normalizeBatchId(value?.lastFailureBatchId),
  }
}

export function serializeTaskVerificationRepair(value = {}) {
  return {
    pending: [...(value.pending instanceof Map ? value.pending.values() : [])]
      .slice(-MAX_PENDING_TASK_VERIFICATIONS)
      .map((entry) => ({ ...entry })),
    candidates: [...(value.candidates instanceof Map ? value.candidates.values() : [])]
      .slice(-MAX_TASK_VERIFICATION_CANDIDATES)
      .map((entry) => ({ ...entry })),
    verified: [...(value.verified instanceof Map ? value.verified.values() : [])]
      .slice(-MAX_PENDING_TASK_VERIFICATIONS)
      .map((entry) => ({ ...entry })),
    indeterminate: [...(value.indeterminate instanceof Map
      ? value.indeterminate.values()
      : value.lastIndeterminate ? [value.lastIndeterminate] : [])]
      .slice(-MAX_TASK_VERIFICATION_INDETERMINATES)
      .map((entry) => normalizeIndeterminate(entry))
      .filter(Boolean),
    // Retain the legacy projection for old checkpoints and diagnostic tools;
    // the Map above is authoritative.
    lastIndeterminate: normalizeIndeterminate(
      value.indeterminate instanceof Map
        ? [...value.indeterminate.values()].at(-1)
        : value?.lastIndeterminate,
    ),
    verificationOverflowed: value?.verificationOverflowed === true,
    mutationEpoch: normalizeEpoch(value.mutationEpoch),
    mutationTargets: [...(value.mutationTargets instanceof Map ? value.mutationTargets : [])]
      .slice(-MAX_TASK_VERIFICATION_MUTATION_TARGETS)
      .map(([target, epoch]) => ({ target, epoch: normalizeEpoch(epoch) })),
    consecutiveFailures: Math.min(
      MAX_TASK_VERIFICATION_FAILURES,
      Math.max(0, Math.floor(Number(value?.consecutiveFailures) || 0)),
    ),
    lastFailureBatchId: normalizeBatchId(value?.lastFailureBatchId),
  }
}
