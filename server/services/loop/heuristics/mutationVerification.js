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
  if (extractionStatus) return extractionStatus === 'text'
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
  addVerificationTarget(targets, result?.path)
  const pathArgument = /\b(?:Get-Content|Get-FileHash|Get-Item|Select-String)\b[^\r\n;|]{0,240}?(?:-(?:Literal)?Path\s+)(?:"([^"]+)"|'([^']+)'|([^\s;|)]+))/gi
  for (const match of script.matchAll(pathArgument)) {
    addVerificationTarget(targets, match[1] || match[2] || match[3])
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
