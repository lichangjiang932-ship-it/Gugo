/**
 * Starts side-effect-free tool calls as soon as a complete tool call arrives
 * from the model stream. The final tool_calls event later awaits the same
 * promise, so model streaming and tool latency overlap without double-running.
 */
export class StreamingToolExecutor {
  constructor({ isSafe, before, execute, onStart } = {}) {
    this.isSafe = typeof isSafe === 'function' ? isSafe : () => false
    this.before = typeof before === 'function' ? before : () => ({ ok: true })
    this.execute = typeof execute === 'function' ? execute : async () => ({ ok: false })
    this.onStart = typeof onStart === 'function' ? onStart : () => {}
    this.executions = new Map()
  }

  get(callId) {
    return this.executions.get(callId) || null
  }

  begin(call, { eager = false } = {}) {
    if (!call?.id) return null
    const existing = this.executions.get(call.id)
    if (existing) return existing
    if (eager && !this.isSafe(call)) return null

    if (call.invalid || !call.name) {
      const execution = {
        guardDecision: { ok: true },
        promise: Promise.resolve({
          ok: false,
          content: JSON.stringify({
            code: 'invalid_tool_arguments',
            error: '工具调用缺少名称，无法执行。',
            retryable: true,
            hint: '请重新给出完整的 function.name 和 arguments。',
          }),
        }),
      }
      this.executions.set(call.id, execution)
      return execution
    }

    this.onStart(call)
    const guardDecision = this.before(call)
    const promise = guardDecision.ok
      ? Promise.resolve(this.execute(call)).catch((error) => ({
          ok: false,
          content: JSON.stringify({
            code: 'tool_execution_failed',
            error: error?.message || String(error),
            retryable: true,
          }),
        }))
      : Promise.resolve({
          ok: false,
          content: JSON.stringify({
            code: guardDecision.code || 'repeated_tool_call',
            error: guardDecision.reason,
            retryable: false,
            hint: '停止重复调用,改用已有结果收尾或换一种方法。',
          }),
        })

    const execution = { guardDecision, promise }
    // A provider can disconnect after an eager call starts. Keep the promise
    // observed even if the normal tool_calls event never arrives.
    promise.catch(() => {})
    this.executions.set(call.id, execution)
    return execution
  }
}
