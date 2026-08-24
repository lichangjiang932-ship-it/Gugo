import path from 'node:path'
import {
  isCommandExecutionTool,
} from './capabilityChecks.js'
import {
  PROJECT_SCOPE_TARGET,
  SHELL_PROJECT_CHECK_COMMAND,
} from './constants.js'
import {
  clearWorkspaceScopedMutationTargets,
  isReadOnlyPowerShellVerificationCall,
  normalizeMutationTarget,
  powerShellCommandScript,
  targetsMatch,
} from './mutationClassification.js'

export function readResultCanVerifyMutation(result) {
  const extractionStatus = String(result?.extractionStatus || '').trim().toLowerCase()
  if (extractionStatus) {
    const target = String(result?.path || '').trim().toLowerCase()
    const officeResult = /\.(?:docx|pptx|xlsx)$/u.test(target)
      || /openxmlformats-officedocument/u.test(String(result?.mimeType || '').toLowerCase())
    return extractionStatus === 'text' && (!officeResult || result?.formatValidated === true)
  }
  return true
}

export function addVerificationTarget(targets, value) {
  const candidate = value && typeof value === 'object'
    ? value.path || value.file || value.filePath || value.filename
    : value
  const target = normalizeMutationTarget(candidate)
  if (target && target !== '/dev/null') targets.add(target.replace(/^(?:a|b)\//, ''))
}

export function diffVerificationTargets(call, result) {
  const diff = String(result?.diff || '').trim()
  if (!diff) return new Set()
  const targets = new Set()
  addVerificationTarget(targets, result?.path || call?.args?.path)
  for (const value of Array.isArray(result?.changedFiles) ? result.changedFiles : []) {
    addVerificationTarget(targets, value)
  }
  for (const value of Array.isArray(result?.changes) ? result.changes : []) {
    addVerificationTarget(targets, value)
  }
  for (const match of diff.matchAll(/^diff --git\s+(?:"?a\/)?(.+?)"?\s+(?:"?b\/)?(.+?)"?$/gm)) {
    addVerificationTarget(targets, match[2] || match[1])
  }
  for (const match of diff.matchAll(/^\+\+\+\s+(?:"?b\/)?(.+?)"?(?:\t.*)?$/gm)) {
    addVerificationTarget(targets, match[1])
  }
  return targets
}

export function powerShellVerificationTargets(call, result) {
  if (!isReadOnlyPowerShellVerificationCall(call)) return new Set()
  const script = powerShellCommandScript(call)
  const targets = new Set()
  if (!/\b(?:Get-Content|Select-String)\b/i.test(script)) return targets
  addVerificationTarget(targets, result?.path)
  // Existence/metadata and an unbound digest do not prove that the bytes are
  // the bytes produced by this turn. Binary outputs are cleared only by the
  // host-issued, identity-bound structure-validation receipt below.
  const pathArgument = /\b(?:Get-Content|Select-String)\b[^\r\n;|]{0,240}?(?:-(?:Literal)?Path\s+)(?:"([^"]+)"|'([^']+)'|([^\s;|)]+))/gi
  for (const match of script.matchAll(pathArgument)) {
    addVerificationTarget(targets, match[1] || match[2] || match[3])
  }
  const structuralBinaryExtensions = new Set([
    '.docx', '.pptx', '.xlsx', '.pdf', '.png', '.jpg', '.jpeg', '.webp',
  ])
  for (const target of [...targets]) {
    if (structuralBinaryExtensions.has(path.posix.extname(target.toLowerCase()))) targets.delete(target)
  }
  return targets
}

export function listDirectoryVerificationTargets(call, result) {
  if (result?.ok !== true) return new Set()
  const directory = normalizeMutationTarget(result?.path || call?.args?.path)
  if (!directory) return new Set()
  const targets = new Set()
  for (const entry of Array.isArray(result?.entries) ? result.entries : []) {
    const rawEntry = entry && typeof entry === 'object'
      ? entry.path || entry.name
      : entry
    const normalizedEntry = normalizeMutationTarget(rawEntry)
    if (!normalizedEntry || normalizedEntry === '.' || normalizedEntry === '..') continue
    const target = /^(?:[a-z]:\/|\/)/i.test(normalizedEntry)
      ? normalizedEntry
      : normalizeMutationTarget(`${directory}/${normalizedEntry}`)
    if (target) targets.add(target)
  }
  return targets
}

export function clearVerifiedDeletionTargets(pendingTargets, call, result) {
  if (!pendingTargets.size || call?.name !== 'list_directory') return false
  // Absence is evidence only when the executor explicitly confirms that the
  // parent listing is complete. A limited/truncated listing cannot prove that
  // an omitted target was deleted.
  if (result?.ok !== true || result?.truncated !== false || !Array.isArray(result?.entries)) {
    return false
  }
  const directory = normalizeMutationTarget(result?.path || call?.args?.path)
  if (!directory) return false
  const listedTargets = listDirectoryVerificationTargets(call, result)
  const directoryCandidates = new Set([
    directory,
    normalizeMutationTarget(call?.args?.path),
  ].filter(Boolean))
  let cleared = false
  for (const pending of [...pendingTargets]) {
    const normalized = normalizeMutationTarget(pending)
    const separator = normalized.lastIndexOf('/')
    if (!normalized || separator === normalized.length - 1) continue
    const parent = separator < 0
      ? '.'
      : separator === 0
        ? '/'
        : normalized.slice(0, separator)
    if (![...directoryCandidates].some((candidate) => targetsMatch(parent, candidate))) continue
    if ([...listedTargets].some((listed) => targetsMatch(normalized, listed))) continue
    pendingTargets.delete(pending)
    cleared = true
  }
  return cleared
}

export function clearExplicitTargetsMatchingEvidence(pendingTargets, evidenceTargets) {
  if (!evidenceTargets.size) return false
  let cleared = false
  for (const pending of [...pendingTargets]) {
    if (pending === PROJECT_SCOPE_TARGET) continue
    if ([...evidenceTargets].some((evidence) => targetsMatch(pending, evidence))) {
      pendingTargets.delete(pending)
      cleared = true
    }
  }
  return cleared
}

export function clearTargetsMatchingEvidence(pendingTargets, evidenceTargets) {
  if (!evidenceTargets.size) return false
  let cleared = false
  if (pendingTargets.delete(PROJECT_SCOPE_TARGET)) cleared = true
  for (const pending of [...pendingTargets]) {
    if ([...evidenceTargets].some((evidence) => targetsMatch(pending, evidence))) {
      pendingTargets.delete(pending)
      cleared = true
    }
  }
  return cleared
}

const STRUCTURAL_ARTIFACT_FORMATS = new Set([
  'docx',
  'pptx',
  'xlsx',
  'pdf',
  'image',
])

/**
 * Clear only the concrete file targets covered by host-issued binary artifact
 * validation receipts. The workspace sentinel and deletion targets are
 * intentionally out of scope: publishing one valid file cannot verify an
 * unrelated mutation or an entire project.
 */
export function clearArtifactValidatedMutationTargets(pendingTargets, receipts, binding = {}) {
  if (!pendingTargets.size || !Array.isArray(receipts) || receipts.length === 0) return false
  const expectedUserId = String(binding.userId || '').trim()
  const expectedSessionId = String(binding.sessionId || '').trim()
  const expectedTurnId = String(binding.turnId || '').trim()
  const expectedJobId = String(binding.jobId || '').trim()
  const expectedStepId = String(binding.stepId || '').trim()
  const chatBinding = Boolean(expectedSessionId || expectedTurnId)
  if (!expectedUserId
    || (chatBinding && (!expectedSessionId || !expectedTurnId))
    || (!chatBinding && !expectedJobId)) return false
  const evidence = new Set()
  for (const receipt of receipts) {
    if (!receipt || typeof receipt !== 'object'
      || receipt.verified !== true
      || receipt.verifier !== 'bounded_structure_parser'
      || receipt.verifierVersion !== 1
      || !String(receipt.artifactId || '').trim()
      || String(receipt.userId || '').trim() !== expectedUserId
      || (chatBinding && String(receipt.sessionId || '').trim() !== expectedSessionId)
      || (chatBinding && String(receipt.turnId || '').trim() !== expectedTurnId)
      || (!chatBinding && String(receipt.jobId || '').trim() !== expectedJobId)
      || (!chatBinding && expectedStepId && String(receipt.stepId || '').trim() !== expectedStepId)
      || !STRUCTURAL_ARTIFACT_FORMATS.has(String(receipt.format || '').trim().toLowerCase())
      || !/^[a-f0-9]{64}$/u.test(String(receipt.sha256 || ''))
      || !Number.isSafeInteger(receipt.byteLength)
      || receipt.byteLength <= 0) continue
    const sourcePath = String(receipt.sourcePath || '').trim()
    const artifactPath = String(receipt.artifactPath || '').trim()
    if (!sourcePath || !artifactPath || !path.isAbsolute(sourcePath) || !path.isAbsolute(artifactPath)) continue
    addVerificationTarget(evidence, receipt.path)
    addVerificationTarget(evidence, receipt.declaredPath)
    addVerificationTarget(evidence, sourcePath)
  }
  return clearExplicitTargetsMatchingEvidence(pendingTargets, evidence)
}

export function clearVerifiedMutationTargets(pendingTargets, call, result) {
  if (!pendingTargets.size) return false
  if (call?.name === 'list_directory') {
    const evidence = listDirectoryVerificationTargets(call, result)
    if (result?.ok === true) {
      addVerificationTarget(evidence, result?.path || call?.args?.path)
    }
    return clearExplicitTargetsMatchingEvidence(
      pendingTargets,
      evidence,
    )
  }
  if (call?.name === 'git_diff') {
    return clearTargetsMatchingEvidence(pendingTargets, diffVerificationTargets(call, result))
  }
  if (call?.name === 'run_project_check') {
    return clearWorkspaceScopedMutationTargets(pendingTargets)
  }
  if (isCommandExecutionTool(call)) {
    const command = String(call?.args?.command || '')
    if (/\bgit\s+diff\b/i.test(command)) {
      return clearTargetsMatchingEvidence(pendingTargets, diffVerificationTargets(call, {
        ...result,
        diff: result?.diff || result?.stdout,
      }))
    }
    if (SHELL_PROJECT_CHECK_COMMAND.test(command)) {
      return clearWorkspaceScopedMutationTargets(pendingTargets)
    }
    const powerShellEvidence = powerShellVerificationTargets(call, result)
    if (powerShellEvidence.size > 0) {
      return clearExplicitTargetsMatchingEvidence(pendingTargets, powerShellEvidence)
    }
  }
  if (call?.name === 'read_file') {
    if (!readResultCanVerifyMutation(result)) return false
    const evidence = new Set()
    addVerificationTarget(evidence, result?.path)
    addVerificationTarget(evidence, call?.args?.path)
    return clearExplicitTargetsMatchingEvidence(pendingTargets, evidence)
  }
  const evidence = new Set()
  addVerificationTarget(evidence, result?.path)
  if (call?.name === 'image_info') {
    addVerificationTarget(evidence, call?.args?.path)
  } else if (call?.name === 'media_probe') {
    addVerificationTarget(evidence, call?.args?.input_path)
  } else if (call?.name === 'pdf_info' || call?.name === 'pdf_text') {
    addVerificationTarget(evidence, call?.args?.path || call?.args?.input)
  } else if (call?.name === 'archive_list') {
    addVerificationTarget(evidence, result?.input)
    addVerificationTarget(evidence, call?.args?.input)
  } else {
    return false
  }
  return clearExplicitTargetsMatchingEvidence(pendingTargets, evidence)
}
