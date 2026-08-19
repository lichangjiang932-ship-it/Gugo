import {
  isCommandExecutionTool,
} from './capabilityChecks.js'
import {
  PROJECT_SCOPE_TARGET,
} from './constants.js'
import {
  inlinePythonCode,
  normalizeMutationTarget,
  shellTargetWithCwd,
} from './mutationClassification.js'

export function looksLikeDeletionCommand(command) {
  const source = unwrapStaticWindowsCommand(command)
  return /(?:^|[;&|\r\n])\s*(?:rm|unlink|rmdir|del|erase|rd|remove-item)(?:\.exe)?\b/i.test(source)
    || /^\s*(?:powershell|pwsh)(?:\.exe)?\b[\s\S]*\bremove-item\b/i.test(source)
}

export function unwrapStaticWindowsCommand(command) {
  const source = String(command || '').trim()
  const wrapper = source.match(/^cmd(?:\.exe)?\s+(?:(?:\/[dqs])\s+)*\/c\s+([\s\S]+)$/i)
  if (!wrapper) return source
  const body = String(wrapper[1] || '').trim()
  return body.length >= 2 && body.startsWith('"') && body.endsWith('"')
    ? body.slice(1, -1).trim()
    : body
}

export function tokenizeStaticDeletionCommand(command) {
  const source = unwrapStaticWindowsCommand(command)
    .replace(/\s+2\s*>\s*nul\s*$/i, '')
    .trim()
  // Compensation is safe only when this is one literal delete operation with
  // no chaining, redirection, variable expansion, or shell escaping.
  if (!source || /[&|;<>\r\n\x60^]/.test(source)) return null
  const tokens = []
  let token = ''
  let quote = ''
  for (const character of source) {
    if (quote) {
      if (character === quote) quote = ''
      else token += character
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (/\s/.test(character)) {
      if (token) {
        tokens.push(token)
        token = ''
      }
      continue
    }
    token += character
  }
  if (quote) return null
  if (token) tokens.push(token)
  return tokens
}

export function isAllowedWindowsDeletionSwitch(commandName, token) {
  if (!token.startsWith('/')) return false
  if (['rd', 'rmdir'].includes(commandName)) return /^\/[sq]$/i.test(token)
  return /^\/(?:[fpqs]|a(?::[rhsa-]+)?)$/i.test(token)
}

export function isStaticDeletionTarget(value) {
  const target = String(value || '').trim()
  if (!target || target === '.' || target === '/' || /^[a-z]:[\\/]?$/i.test(target)) return false
  if (/[%!$*?[\]{}~,]/.test(target)) return false
  if (/(?:^|[\\/])\.\.(?:$|[\\/])/.test(target)) return false
  return true
}

export function staticWindowsDeletionTargets(call, result = null) {
  if (!isCommandExecutionTool(call)) return null
  const tokens = tokenizeStaticDeletionCommand(call?.args?.command)
  if (!tokens?.length) return null
  const commandName = String(tokens.shift() || '').toLowerCase().replace(/\.exe$/, '')
  if (!['del', 'erase', 'rd', 'rmdir'].includes(commandName)) return null

  const rawTargets = []
  for (const token of tokens) {
    if (token.startsWith('/')) {
      if (!isAllowedWindowsDeletionSwitch(commandName, token)) return null
      continue
    }
    if (!isStaticDeletionTarget(token)) return null
    rawTargets.push(token)
  }
  if (rawTargets.length === 0) return null

  const cwd = call?.args?.cwd || result?.cwd
  const targets = new Set(rawTargets.map((target) => shellTargetWithCwd(target, cwd)).filter(Boolean))
  return targets.size === rawTargets.length ? targets : null
}

export function isAllowedUnixDeletionSwitch(commandName, token) {
  if (commandName === 'rm') {
    return /^-[dfirRv]+$/.test(token)
      || ['--dir', '--force', '--interactive', '--recursive', '--verbose'].includes(token)
  }
  if (commandName === 'unlink') return token === '-f' || token === '--force'
  if (commandName === 'rmdir') {
    return /^-[pv]+$/.test(token)
      || ['--ignore-fail-on-non-empty', '--parents', '--verbose'].includes(token)
  }
  return false
}

export function staticUnixDeletionTargets(call, result = null) {
  if (!isCommandExecutionTool(call)) return null
  const tokens = tokenizeStaticDeletionCommand(call?.args?.command)
  if (!tokens?.length) return null
  const commandName = String(tokens.shift() || '').toLowerCase().replace(/\.exe$/, '')
  if (!['rm', 'unlink', 'rmdir'].includes(commandName)) return null

  const rawTargets = []
  let optionsEnded = false
  for (const token of tokens) {
    if (!optionsEnded && token === '--') {
      optionsEnded = true
      continue
    }
    if (!optionsEnded && token.startsWith('-')) {
      if (!isAllowedUnixDeletionSwitch(commandName, token)) return null
      continue
    }
    if (!isStaticDeletionTarget(token)) return null
    rawTargets.push(token)
  }
  if (rawTargets.length === 0) return null

  const cwd = call?.args?.cwd || result?.cwd
  const targets = new Set(rawTargets.map((target) => shellTargetWithCwd(target, cwd)).filter(Boolean))
  return targets.size === rawTargets.length ? targets : null
}

export function parseStaticPowerShellRemoveItem(tokens, cwd) {
  const remaining = [...tokens]
  const commandName = String(remaining.shift() || '').toLowerCase().replace(/\.exe$/, '')
  if (commandName !== 'remove-item') return null

  let rawTarget = ''
  while (remaining.length > 0) {
    const token = String(remaining.shift() || '')
    const normalized = token.toLowerCase()
    if (normalized === '-force' || normalized === '-recurse') continue
    if (normalized !== '-literalpath' || rawTarget || remaining.length === 0) return null
    const candidate = String(remaining.shift() || '')
    if (!isStaticDeletionTarget(candidate)) return null
    rawTarget = candidate
  }
  if (!rawTarget) return null
  const target = shellTargetWithCwd(rawTarget, cwd)
  return target ? new Set([target]) : null
}

export function staticPowerShellDeletionTargets(call, result = null) {
  if (!isCommandExecutionTool(call)) return null
  const tokens = tokenizeStaticDeletionCommand(call?.args?.command)
  if (!tokens?.length) return null
  const commandName = String(tokens[0] || '').toLowerCase().replace(/\.exe$/, '')
  const cwd = call?.args?.cwd || result?.cwd
  if (commandName === 'remove-item') return parseStaticPowerShellRemoveItem(tokens, cwd)
  if (!['powershell', 'pwsh'].includes(commandName)) return null

  tokens.shift()
  while (tokens.length > 0) {
    const option = String(tokens.shift() || '').toLowerCase()
    if (['-encodedcommand', '-enc', '-e'].includes(option)) return null
    if (['-noprofile', '-noninteractive', '-nologo'].includes(option)) continue
    if (!['-command', '-c'].includes(option) || tokens.length === 0) return null
    const commandTokens = tokens.length === 1
      ? tokenizeStaticDeletionCommand(tokens[0])
      : tokens
    return commandTokens?.length
      ? parseStaticPowerShellRemoveItem(commandTokens, cwd)
      : null
  }
  return null
}

export function staticDeletionTargets(call, result = null) {
  for (const parser of [
    staticWindowsDeletionTargets,
    staticUnixDeletionTargets,
    staticPowerShellDeletionTargets,
  ]) {
    const targets = parser(call, result)
    if (targets?.size) return targets
  }
  return null
}

export function extractInlinePythonMutationTargets(call) {
  const code = inlinePythonCode(call)
  if (!code) return new Set()
  const targets = new Set()
  const add = (value) => {
    const target = normalizeMutationTarget(value)
    if (target) targets.add(target)
  }
  const writeMode = (value) => /[wax+]/i.test(String(value || ''))
  const patterns = [
    /\bopen\s*\(\s*(?:file\s*=\s*)?[rRuUbB]{0,2}'([^'\r\n]+)'\s*,\s*(?:mode\s*=\s*)?[rRuUbB]{0,2}'([^'\r\n]+)'/g,
    /\bopen\s*\(\s*(?:file\s*=\s*)?[rRuUbB]{0,2}"([^"\r\n]+)"\s*,\s*(?:mode\s*=\s*)?[rRuUbB]{0,2}"([^"\r\n]+)"/g,
    /\b(?:pathlib\.)?Path\s*\(\s*[rRuUbB]{0,2}'([^'\r\n]+)'\s*\)\s*\.open\s*\(\s*(?:mode\s*=\s*)?[rRuUbB]{0,2}'([^'\r\n]+)'/g,
    /\b(?:pathlib\.)?Path\s*\(\s*[rRuUbB]{0,2}"([^"\r\n]+)"\s*\)\s*\.open\s*\(\s*(?:mode\s*=\s*)?[rRuUbB]{0,2}"([^"\r\n]+)"/g,
  ]
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      if (writeMode(match[2])) add(match[1])
    }
  }
  const directWriters = [
    /\b(?:pathlib\.)?Path\s*\(\s*[rRuUbB]{0,2}'([^'\r\n]+)'\s*\)\s*\.(?:write_text|write_bytes|touch)\s*\(/g,
    /\b(?:pathlib\.)?Path\s*\(\s*[rRuUbB]{0,2}"([^"\r\n]+)"\s*\)\s*\.(?:write_text|write_bytes|touch)\s*\(/g,
  ]
  for (const pattern of directWriters) {
    for (const match of code.matchAll(pattern)) add(match[1])
  }
  return targets
}

export function extractShellMutationTargets(call, cwd = call?.args?.cwd) {
  const command = String(call?.args?.command || '')
  const targets = new Set()
  const add = (value) => {
    const target = shellTargetWithCwd(value, cwd)
    if (target) targets.add(target)
  }
  const redirection = /\d?>{1,2}\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|"']+))/g
  for (const match of command.matchAll(redirection)) add(match[1] || match[2] || match[3])
  const pathArgument = /\b(?:Set-Content|Add-Content|Out-File|New-Item|Remove-Item)\b[^\r\n;|]{0,160}?(?:-(?:Literal)?Path\s+)(?:"([^"]+)"|'([^']+)'|([^\s;|]+))/gi
  for (const match of command.matchAll(pathArgument)) add(match[1] || match[2] || match[3])
  const simpleWriter = /(?:^|[;&|]\s*|\s)(?:touch|mkdir|rm|unlink|tee)\s+(?:-[^\s]+\s+)*(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/gi
  for (const match of command.matchAll(simpleWriter)) add(match[1] || match[2] || match[3])
  const windowsDeleter = /(?:^|[;&|]\s*|\s)(?:del|erase|rd|rmdir)\s+(?:\/[A-Za-z?]+(?::[^\s]+)?\s+)*(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/gi
  for (const match of command.matchAll(windowsDeleter)) {
    const candidate = match[1] || match[2] || match[3]
    // Dynamic, wildcard, and parent-traversal deletes are intentionally left
    // unknown so extractMutationTargets falls back to <workspace>.
    if (/[%$*?]/.test(candidate) || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(candidate)) continue
    add(candidate)
  }
  for (const target of extractInlinePythonMutationTargets(call)) add(target)
  return targets
}

export function extractMutationTargets(call, result) {
  const targets = new Set()
  const shellCwd = isCommandExecutionTool(call)
    ? result?.cwd || call?.args?.cwd
    : null
  const canonicalExecutorPaths = new Set(
    (Array.isArray(result?.verifiedOutputs) ? result.verifiedOutputs : [])
      .map((output) => normalizeMutationTarget(output?.path))
      .filter(Boolean),
  )
  const normalizedShellCwd = normalizeMutationTarget(shellCwd)
  const add = (value, { reportedByExecutor = false } = {}) => {
    const normalizedValue = normalizeMutationTarget(value)
    const alreadyResolvedAgainstRelativeCwd = normalizedShellCwd
      && normalizedShellCwd !== '.'
      && !/^(?:[a-z]:\/|\/)/i.test(normalizedShellCwd)
      && (normalizedValue === normalizedShellCwd
        || normalizedValue.startsWith(`${normalizedShellCwd}/`))
    const target = reportedByExecutor
      && isCommandExecutionTool(call)
      && !canonicalExecutorPaths.has(normalizedValue)
      && !alreadyResolvedAgainstRelativeCwd
      ? shellTargetWithCwd(value, shellCwd)
      : normalizedValue
    if (target) targets.add(target)
  }
  // Executors and pre-tool hooks may rewrite a requested path. Prefer the
  // canonical path reported by the successful result; call arguments are only
  // a fallback when the executor cannot report what it actually changed.
  add(result?.path, { reportedByExecutor: true })
  add(result?.output_path, { reportedByExecutor: true })
  add(result?.output, { reportedByExecutor: true })
  add(result?.outputDir, { reportedByExecutor: true })
  for (const output of Array.isArray(result?.outputs) ? result.outputs : []) {
    add(output?.path, { reportedByExecutor: true })
  }
  for (const mapping of Array.isArray(result?.renamed) ? result.renamed : []) {
    if (mapping?.unchanged !== true) add(mapping?.to, { reportedByExecutor: true })
  }
  if (call?.name === 'archive_extract') {
    for (const entry of Array.isArray(result?.entries) ? result.entries : []) {
      add(entry?.outputPath, { reportedByExecutor: true })
    }
  }
  const hasAuthoritativeChangedPaths = Array.isArray(result?.changedPaths)
  for (const path of hasAuthoritativeChangedPaths ? result.changedPaths : []) {
    add(path, { reportedByExecutor: true })
  }
  for (const change of Array.isArray(result?.changes) ? result.changes : []) {
    add(change?.path, { reportedByExecutor: true })
  }
  // expected_outputs verification deliberately returns changedPaths, including
  // an empty list when nothing changed. In that case the executor's evidence is
  // authoritative: do not turn unchanged/missing declarations into mutations.
  if (targets.size > 0 || hasAuthoritativeChangedPaths) return targets
  if (['write_file', 'edit_file'].includes(call?.name)) add(call?.args?.path)
  if (call?.name === 'multi_edit') {
    add(call?.args?.path)
    for (const edit of Array.isArray(call?.args?.edits) ? call.args.edits : []) {
      add(edit?.path || edit?.file_path || edit?.filePath)
    }
  }
  if (call?.name === 'apply_patch') {
    const patch = String(call?.args?.patch || '')
    for (const match of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File:\s*(.+)$/gm)) add(match[1])
  }
  if (isCommandExecutionTool(call)) {
    if (looksLikeDeletionCommand(call?.args?.command)) {
      const deletionTargets = staticDeletionTargets(call, result)
      if (!deletionTargets?.size) targets.add(PROJECT_SCOPE_TARGET)
      else for (const target of deletionTargets) add(target)
      return targets
    }
    for (const target of Array.isArray(call?.args?.expected_outputs) ? call.args.expected_outputs : []) {
      add(shellTargetWithCwd(target, call?.args?.cwd))
    }
    for (const target of extractShellMutationTargets(call, shellCwd)) add(target)
  }
  if (targets.size === 0) targets.add(PROJECT_SCOPE_TARGET)
  return targets
}
