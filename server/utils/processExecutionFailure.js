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
  const fallback = cleanupFailed
    ? '命令已停止，但无法确认所有子进程都已退出'
    : isolationFailed
      ? `命令未执行：进程隔离建立失败（${detail || '未知错误'}）`
      : `命令启动失败：${detail || '未知错误'}`

  return {
    ok: false,
    code,
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
      hint: '请检查仍在运行的子进程；在确认清理完成前不要重试会修改同一目录的命令。',
    } : {}),
    error: cleanupFailed ? fallback : (result.error || fallback),
    stdout: result.stdout,
    stderr: result.stderr,
    cwd,
    ...executionMetadata,
    ...verificationFields,
  }
}
