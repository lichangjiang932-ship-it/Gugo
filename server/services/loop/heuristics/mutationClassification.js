import {
  CONNECTOR_WRITE_TOOL_NAMES,
} from '../../connectorTools.js'
import {
  getToolMetadata,
} from '../../toolRegistry.js'
import {
  isFileArtifactTool,
} from '../../artifactIntent.js'
import {
  isSubstantiveToolCall,
} from '../../../utils/toolCallHarness.js'
import {
  isCommandExecutionTool,
} from './commandCapabilities.js'
import {
  LOCAL_MUTATION_TOOLS,
  PDF_LAYOUT_VALIDATOR_COMMAND,
  POWERSHELL_MUTATION_COMMAND,
  POWERSHELL_READ_ONLY_COMMAND,
  PROJECT_SCOPE_TARGET,
  PYTHON_INLINE_READ_EVIDENCE,
  SHELL_VERIFICATION_COMMAND,
  VERIFICATION_TOOLS,
} from './constants.js'
import {
  hasInlinePythonMutation,
} from './pythonMutationAnalysis.js'

export function inlinePythonCode(call) {
  if (!isCommandExecutionTool(call)) return ''
  if (Array.isArray(call?.args?.expected_outputs) && call.args.expected_outputs.length > 0) return ''
  const source = String(call?.args?.command || '').trim()
  const match = source.match(/^(?:(?:"[^"]*(?:python(?:3)?|py)(?:\.exe)?")|(?:[^\s"]*[\\/])?(?:python(?:3)?|py)(?:\.exe)?)(?:\s+(?!-c\b)-[^\s]+)*\s+-c\s+([\s\S]+)$/i)
  if (!match) return ''
  const rawCode = String(match[1] || '').trim()
  const quote = rawCode[0]
  if (!['"', "'"].includes(quote) || rawCode.at(-1) !== quote) return ''
  return rawCode.slice(1, -1)
}

export function isReadOnlyPythonVerificationCall(call) {
  const code = inlinePythonCode(call)
  return Boolean(code)
    && PYTHON_INLINE_READ_EVIDENCE.test(code)
    && !hasInlinePythonMutation(code)
}

export function powerShellCommandScript(call) {
  if (!isCommandExecutionTool(call)) return ''
  const command = String(call?.args?.command || '').trim()
  if (!/^\s*(?:powershell|pwsh)(?:\.exe)?\b/i.test(command)) return ''
  const commandFlag = command.match(/(?:^|\s)-(?:command|c)\s+([\s\S]+)$/i)
  if (!commandFlag) return ''
  let script = String(commandFlag[1] || '').trim()
  if ((script.startsWith('"') && script.endsWith('"'))
    || (script.startsWith("'") && script.endsWith("'"))) {
    script = script.slice(1, -1).trim()
  }
  return script
}

export function isReadOnlyPowerShellVerificationCall(call) {
  const script = powerShellCommandScript(call)
  if (!script
    || /[;<>`]|&&|\|\||\$\(/.test(script)
    || POWERSHELL_MUTATION_COMMAND.test(script)) {
    return false
  }
  const pipeline = script.split('|').map((part) => part.trim()).filter(Boolean)
  if (!pipeline.length || !/^\(?\s*(?:Get-Content|Get-FileHash|Get-ChildItem|Get-Item|Test-Path|Select-String|Compare-Object)\b/i.test(pipeline[0])) {
    return false
  }
  return pipeline.slice(1).every((part) => (
    /^(?:Format-(?:Table|List|Wide)|Select-Object|Sort-Object|Measure-Object)\b/i.test(part)
  )) && POWERSHELL_READ_ONLY_COMMAND.test(script)
}

export function windowsCmdScript(call) {
  if (!isCommandExecutionTool(call)) return ''
  const command = String(call?.args?.command || '').trim()
  const wrapped = command.match(/^cmd(?:\.exe)?\s+(?:(?:\/[dqs])\s+)*\/c\s+([\s\S]+)$/i)
  if (!wrapped) return ''
  let script = String(wrapped[1] || '').trim()
  if ((script.startsWith('"') && script.endsWith('"'))
    || (script.startsWith("'") && script.endsWith("'"))) {
    script = script.slice(1, -1).trim()
  }
  return script
}

export function isReadOnlyWindowsCmdVerificationCall(call) {
  const script = windowsCmdScript(call)
  if (!script) return false
  // Only null-device / descriptor redirects are harmless. Any remaining
  // redirect, pipe, separator, or escape keeps the conservative mutation path.
  const withoutSafeRedirects = script
    .replace(/\d?>&\d+/g, ' ')
    .replace(/\d?>{1,2}\s*(?:"(?:\\\\\.\\)?nul:?"|'(?:\\\\\.\\)?nul:?'|(?:\\\\\.\\)?nul:?)(?=$|\s)/gi, ' ')
    .trim()
  if (!withoutSafeRedirects
    || /[<>|;\r\n^\x60]/.test(withoutSafeRedirects)
    || /\$\(|%[^%]+%|![^!]+!/.test(withoutSafeRedirects)) return false
  const commands = withoutSafeRedirects.split(/\s*&&\s*/).map((part) => part.trim()).filter(Boolean)
  if (!commands.length || commands.some((part) => /&/.test(part))) return false
  let inspectionObserved = false
  for (const command of commands) {
    if (/^cd(?:\s+\/d)?(?:\s+.+)?$/i.test(command)) continue
    if (/^(?:dir|where|type|findstr)(?:\s|$)/i.test(command)) {
      inspectionObserved = true
      continue
    }
    return false
  }
  return inspectionObserved
}

export function isLocalMutationCall(call) {
  if (LOCAL_MUTATION_TOOLS.has(call?.name)) {
    return !(['apply_patch', 'patch_file'].includes(call?.name) && call?.args?.dry_run === true)
  }
  if (!isCommandExecutionTool(call) || isVerificationCall(call)) return false
  return getToolMetadata(call.name, { args: call.args }).isReadOnly !== true
}

export function isVerificationCall(call) {
  if (VERIFICATION_TOOLS.has(call?.name)) return true
  if (!isCommandExecutionTool(call)) return false
  // Declared outputs make the command a mutation contract even when the same
  // shell line also runs tests/lint/build. The executor snapshots and verifies
  // these outputs, so classifying the whole call as read-only would discard the
  // real changedPaths and incorrectly report that no execution occurred.
  if (Array.isArray(call?.args?.expected_outputs) && call.args.expected_outputs.length > 0) {
    return false
  }
  const command = String(call?.args?.command || '')
  return SHELL_VERIFICATION_COMMAND.test(command)
    || PDF_LAYOUT_VALIDATOR_COMMAND.test(command)
    || isReadOnlyPythonVerificationCall(call)
    || isReadOnlyPowerShellVerificationCall(call)
    || isReadOnlyWindowsCmdVerificationCall(call)
    || getToolMetadata(call.name, { args: call.args }).isReadOnly === true
}

export function isMutationExecutionCall(call, artifactId = null) {
  if (!isSubstantiveToolCall(call)) return false
  if (artifactId || isFileArtifactTool(call?.name) || CONNECTOR_WRITE_TOOL_NAMES.includes(call?.name)) return true
  if (LOCAL_MUTATION_TOOLS.has(call?.name)) return isLocalMutationCall(call)
  if (isCommandExecutionTool(call)) return isLocalMutationCall(call)
  const metadata = getToolMetadata(call?.name, { args: call?.args })
  // Dynamic MCP/plugin writes normally use riskClass=external and do not
  // appear in the built-in connector-name list. A successful one is concrete
  // mutation evidence; ignoring it makes the completion guard ask the model
  // to create/send the same external object again.
  return metadata.isReadOnly === false
}

export function isNullMutationTarget(value, platform = process.platform) {
  const candidate = String(value || '').replace(/^["']+|["']+$/g, '').trim()
  if (/^(?:nul:?|\\\\\.\\nul:?|\/dev\/null|\$null)$/i.test(candidate)) return true
  if (platform !== 'win32') return false
  const filename = candidate.replace(/\\/g, '/').split('/').at(-1) || ''
  return /^nul(?::|\..*)?$/i.test(filename)
}

export function normalizeMutationTarget(rawTarget, { platform = process.platform } = {}) {
  let target = String(rawTarget || '').trim()
  if (!target) return ''
  if ((target.startsWith('"') && target.endsWith('"'))
    || (target.startsWith("'") && target.endsWith("'"))) {
    target = target.slice(1, -1).trim()
  }
  if (!target || target.startsWith('-') || target.startsWith('&')) return ''
  // ★ Windows/Unix 空设备是重定向目标,不是真实产出。
  //   `>nul`(cmd) / `>$null`(PowerShell) / `>/dev/null`(sh) 一旦被当成
  //   pending mutation target,就永远无法被读回/差异验证清除 ——
  //   最终会误报 post_mutation_verification_missing,让一个已完成的任务
  //   以「验证缺失」结尾。空设备一律不跟踪。
  if (isNullMutationTarget(target, platform)) return ''
  target = target.replace(/\\/g, '/').replace(/\/+/g, '/')
  while (target.startsWith('./')) target = target.slice(2)
  if (target.length > 1) target = target.replace(/\/$/, '')
  return target
}

export function targetsMatch(left, right) {
  const a = normalizeMutationTarget(left)
  const b = normalizeMutationTarget(right)
  if (!a || !b) return false
  const normalizeCase = (value) => process.platform === 'win32' ? value.toLowerCase() : value
  const comparableA = normalizeCase(a)
  const comparableB = normalizeCase(b)
  if (comparableA === comparableB) return true
  const aAbsolute = /^(?:[a-z]:\/|\/)/i.test(a)
  const bAbsolute = /^(?:[a-z]:\/|\/)/i.test(b)
  if (aAbsolute === bAbsolute) return false
  const absolute = aAbsolute ? comparableA : comparableB
  const relative = aAbsolute ? b : a
  const workspaceRoot = normalizeMutationTarget(
    process.env.WORKSPACE_ROOT?.trim() || process.cwd(),
  )
  if (!workspaceRoot) return false
  const resolvedRelative = normalizeMutationTarget(
    relative === '.' ? workspaceRoot : `${workspaceRoot}/${relative}`,
  )
  return absolute === normalizeCase(resolvedRelative)
}

export function clearWorkspaceScopedMutationTargets(pendingTargets) {
  let cleared = false
  for (const pending of [...pendingTargets]) {
    if (pending === PROJECT_SCOPE_TARGET) {
      pendingTargets.delete(pending)
      cleared = true
      continue
    }
    const normalized = normalizeMutationTarget(pending)
    if (!normalized) continue
    // Project checks validate project-relative source state. An absolute target
    // may be a separately authorized artifact (PDF/PNG/etc.), even when it
    // happens to sit below WORKSPACE_ROOT, so it still needs target-specific
    // read/list/diff evidence before completion.
    if (/^(?:[a-z]:\/|\/)/i.test(normalized)) continue
    pendingTargets.delete(pending)
    cleared = true
  }
  return cleared
}

export function shellTargetWithCwd(target, cwd) {
  const normalized = normalizeMutationTarget(target)
  if (!normalized || /^(?:[a-z]:\/|\/)/i.test(normalized)) return normalized
  const normalizedCwd = normalizeMutationTarget(cwd)
  if (!normalizedCwd || normalizedCwd === '.') return normalized
  return normalizeMutationTarget(`${normalizedCwd}/${normalized}`)
}
