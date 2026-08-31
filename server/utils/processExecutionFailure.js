const INFRASTRUCTURE_FAILURE_CODES = new Set([
  'PROCESS_TREE_CLEANUP_FAILED',
  'PROCESS_ISOLATION_FAILED',
  'PROCESS_START_FAILED',
  'SHELL_SESSION_BOUNDARY_VIOLATION',
  'SHELL_SESSION_CRASHED',
])
const TOOLCHAIN_UNAVAILABLE_EXIT_CODES = new Set([126, 127, 9009])

const INFRASTRUCTURE_FAILURE_FIELDS = Object.freeze({
  failureKind: 'infrastructure',
  systemFailure: true,
})

export function infrastructureFailureFields(code) {
  return { code, ...INFRASTRUCTURE_FAILURE_FIELDS }
}

function verificationToolchainUnavailable(result) {
  if (result?.ok !== false) return false
  const diagnostic = `${result?.stderr || ''}\n${result?.error || ''}`.slice(0, 4_096)
  const strongDiagnostic = /(?:^|\r?\n)(?:(?:\/bin\/)?(?:ba|da|z)?sh|cmd(?:\.exe)?|powershell)(?::\s*\d+)?\s*:\s*[^\r\n]*(?:command\s+)?not found\b|\bis not recognized as an internal or external command\b|不是内部或外部命令|\bCommandNotFoundException\b|\bThe term\s+[^\r\n]+\s+is not recognized\b|无法将[^\r\n]+识别为|\bPython was not found\b|\bNo module named\s+['"]?(?:pytest|unittest|ruff|flake8|pylint|mypy|pyright)\b|\bNo \.NET SDKs were found\b|\bJAVA_HOME is not (?:set|defined correctly)\b|\bMissing script:\s*['"]?(?:test|lint|build|check|typecheck)\b/iu
  if (strongDiagnostic.test(diagnostic)) return true
  const npmScriptLines = String(result?.stdout || '')
    .split(/\r?\n/gu)
    .map((line) => line.match(/^>\s+(.+)$/u)?.[1]?.trim())
    .filter(Boolean)
  const npmScriptCommand = npmScriptLines.length >= 2 ? npmScriptLines[1] : ''
  const npmScriptRunner = npmScriptCommand.match(/^(?:"([^"]+)"|'([^']+)'|([^\s]+))/u)
  const runner = npmScriptRunner?.[1] || npmScriptRunner?.[2] || npmScriptRunner?.[3] || ''
  const corruptedWindowsDiagnostic = process.platform === 'win32'
    && Number(result?.exitCode) === 1
    && runner.length > 0
    && diagnostic.includes(runner)
    && /\uFFFD/u.test(diagnostic)
  if (corruptedWindowsDiagnostic) return true
  const exitCode = Number(result?.exitCode)
  return TOOLCHAIN_UNAVAILABLE_EXIT_CODES.has(exitCode)
    && /\b(?:No such file or directory|Permission denied|not found)\b/iu.test(diagnostic)
}

export function projectVerificationFields(result = {}) {
  const code = String(result?.code || '').trim().toUpperCase()
  const explicitInfrastructureCode = INFRASTRUCTURE_FAILURE_CODES.has(code) ? code : ''
  const exitCode = result?.exitCode
  const toolchainUnavailable = verificationToolchainUnavailable(result)
  const explicitInfrastructureFailure = toolchainUnavailable
    || result?.systemFailure === true
    || result?.failureKind === 'infrastructure'
    || result?.verificationVerdict === 'indeterminate'
    || (Object.hasOwn(result || {}, 'passed') && result.passed === null)
    || result?.timedOut === true
    || result?.cancelled === true
    || result?.aborted === true
    || result?.processStartFailed === true
    || result?.processIsolationFailed === true
    || result?.processTreeCleanupFailed === true
    || result?.sessionBoundaryViolation === true
    || result?.requiresUserVerification === true
    || INFRASTRUCTURE_FAILURE_CODES.has(code)

  if (explicitInfrastructureFailure) {
    return {
      ...(explicitInfrastructureCode
        ? { code: explicitInfrastructureCode }
        : toolchainUnavailable ? { code: 'VERIFICATION_TOOLCHAIN_UNAVAILABLE' } : {}),
      passed: null,
      verificationVerdict: 'indeterminate',
      ...INFRASTRUCTURE_FAILURE_FIELDS,
    }
  }
  if (result?.verificationVerdict === 'failed'
    || result?.failureKind === 'project'
    || result?.passed === false
    || (Number.isInteger(exitCode) && exitCode !== 0)) {
    return {
      passed: false,
      verificationVerdict: 'failed',
      failureKind: 'project',
      systemFailure: false,
    }
  }
  if (result?.ok === false && (!Number.isInteger(exitCode) || exitCode === -1)) {
    return {
      passed: null,
      verificationVerdict: 'indeterminate',
      ...INFRASTRUCTURE_FAILURE_FIELDS,
    }
  }
  if (result?.verificationVerdict === 'passed'
    || result?.passed === true
    || (result?.ok === true && (exitCode == null || exitCode === 0))) {
    return {
      passed: true,
      verificationVerdict: 'passed',
      failureKind: null,
      systemFailure: false,
    }
  }
  return {
    passed: null,
    verificationVerdict: 'indeterminate',
    ...INFRASTRUCTURE_FAILURE_FIELDS,
  }
}

export function processExecutionNotStartedResult({
  controlPipe = false,
  aborted = false,
} = {}) {
  return {
    stdout: '',
    stderr: '',
    code: null,
    signal: null,
    timedOut: false,
    killed: false,
    processStartFailed: false,
    processStartError: null,
    processIsolationFailed: false,
    processIsolationError: null,
    processTreeCleanupFailed: false,
    truncated: false,
    aborted: aborted === true,
    totalOutputBytes: 0,
    ...(controlPipe === true
      ? {
          control: Buffer.alloc(0),
          controlError: null,
          controlTruncated: false,
          controlTotalBytes: 0,
        }
      : {}),
  }
}

export function processExecutionBoundaryFailure(result, {
  cwd,
  executionMetadata = {},
  verificationFields = {},
} = {}) {
  const interrupted = result?.aborted === true || result?.timedOut === true
  const isolationFailed = !interrupted && result?.processIsolationFailed === true
  const startFailed = !interrupted && result?.processStartFailed === true
  const cleanupFailed = result?.processTreeCleanupFailed === true
  if (!isolationFailed && !startFailed && !cleanupFailed) return null

  const code = cleanupFailed
    ? 'PROCESS_TREE_CLEANUP_FAILED'
    : isolationFailed ? 'PROCESS_ISOLATION_FAILED' : 'PROCESS_START_FAILED'
  const detail = isolationFailed
    ? result.processIsolationError
    : result.processStartError
  const fallback = code

  return {
    ok: false,
    code,
    verificationVerdict: 'indeterminate',
    ...INFRASTRUCTURE_FAILURE_FIELDS,
    ...(Number.isInteger(result?.code) ? { exitCode: result.code } : {}),
    ...(result?.signal ? { signal: result.signal } : {}),
    ...(isolationFailed ? {
      processIsolationFailed: true,
      processIsolationError: result.processIsolationError || null,
    } : {}),
    ...(startFailed ? {
      processStartFailed: true,
      processStartError: result.processStartError || null,
    } : {}),
    ...(cleanupFailed ? {
      processTreeCleanupFailed: true,
      ...(result.aborted ? { cancelled: true } : {}),
      ...(result.timedOut ? { timedOut: true } : {}),
      ...(result.truncated ? { truncated: true } : {}),
      hintCode: 'PROCESS_TREE_CLEANUP_REVIEW_REQUIRED',
    } : {}),
    error: cleanupFailed ? fallback : (result.error || detail || fallback),
    stdout: result.stdout,
    stderr: result.stderr,
    cwd,
    ...executionMetadata,
    ...verificationFields,
  }
}
