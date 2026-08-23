/** Install per-iteration failure observation and reflection prompt handlers. */
export function installToolFailureRecovery(s, iteration) {
  const {
    FAILURE_RECOVERY_MARKER,
    FAILURE_RECOVERY_THRESHOLD,
    isCommandExecutionTool,
    isSubstantiveToolCall,
    isSuccessfulToolResult,
    restoreFailureRecovery,
    shouldReflectOnFailure,
    toolNameFromSpec,
  } = s.d

  iteration.observeFailureRecovery = (call, result) => {
    if (isSuccessfulToolResult(result)) {
      if (isSubstantiveToolCall(call)) {
        s.failureRecovery = restoreFailureRecovery()
        s.pendingFailureRecoveryPrompt = false
      }
      return
    }
    if (!shouldReflectOnFailure(result)) return
    const tool = String(call?.name || '').trim()
    if (!tool) return
    if (s.failureRecovery.tool !== tool) {
      s.failureRecovery = { tool, count: 0, reflected: false, attempts: [] }
    }
    s.failureRecovery.count += 1
    s.failureRecovery.attempts.push({
      tool,
      code: String(result?.code || 'tool_execution_failed').slice(0, 160),
      message: [
        String(result?.error || 'Tool execution failed.'),
        result?.hint ? `Hint: ${String(result.hint)}` : '',
      ].filter(Boolean).join(' ').slice(0, 800),
    })
    s.failureRecovery.attempts = s.failureRecovery.attempts.slice(-FAILURE_RECOVERY_THRESHOLD)
    if (s.failureRecovery.count >= FAILURE_RECOVERY_THRESHOLD && !s.failureRecovery.reflected) {
      s.pendingFailureRecoveryPrompt = true
    }
  }

  iteration.appendFailureRecoveryPrompt = () => {
    if (!s.pendingFailureRecoveryPrompt || s.failureRecovery.reflected) return false
    const tried = s.failureRecovery.attempts.map((attempt, index) => (
      `${index + 1}. ${attempt.tool} failed with ${attempt.code}: ${attempt.message}`
    ))
    s.convo.push({
      role: 'system',
      content: [
        FAILURE_RECOVERY_MARKER,
        `The same tool (${s.failureRecovery.tool}) has failed ${s.failureRecovery.count} consecutive times.`,
        'Analyze the failure before making another call. Do not repeat the same method or merely vary guessed arguments.',
        'State internally what was tried, identify the likely cause from the concrete errors below, then choose a materially different strategy or report one specific blocker.',
        ...(process.platform === 'win32'
          && isCommandExecutionTool(s.failureRecovery.tool)
          && s.activeToolSpecs.some((spec) => toolNameFromSpec(spec) === 'write_file')
          ? [`For long or multiline Python on Windows, the required different strategy is: create a UTF-8 .py file with write_file, run it with ${s.failureRecovery.tool}, then verify the declared final outputs. Do not retry another long python -c command or a Unix-only pipeline.`]
          : []),
        ...tried,
      ].join('\n'),
    })
    s.failureRecovery.reflected = true
    s.pendingFailureRecoveryPrompt = false
    return true
  }
}
