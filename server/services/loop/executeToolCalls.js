import { observeLoopEvent } from './eventIsolation.js'

function assertToolCall(call) {
  if (!call || typeof call !== 'object' || Array.isArray(call)) {
    throw new TypeError('Loop tool call must be an object')
  }
  if (!String(call.name || '').trim()) {
    throw new TypeError('Loop tool call must have a name')
  }
  return call
}

export const TOOL_HOOK_RESULT = Symbol('loop.toolHookResult')

/** Register the existing process hook service as a loop event consumer. */
export function installToolHookBridge({
  loopEvents,
  dispatchHooks,
  enabled = true,
  job = null,
  step = null,
} = {}) {
  if (!loopEvents || typeof loopEvents.on !== 'function') return () => {}
  if (typeof dispatchHooks !== 'function') throw new TypeError('dispatchHooks must be a function')

  const offPre = loopEvents.on('pre-tool', async (call) => {
    if (!enabled || !job?.userId) return call
    if (call.checkpointStatus === 'awaiting_approval' || call.checkpointStatus === 'executing') {
      return call
    }
    const hook = await dispatchHooks({
      userId: job.userId,
      event: 'pre_tool_use',
      tool: call.name,
      args: call.args,
      sessionId: job.id || null,
      requestId: step?.id || null,
    })
    return {
      ...call,
      ...(hook?.replacementArgs && typeof hook.replacementArgs === 'object'
        ? { args: hook.replacementArgs }
        : {}),
      [TOOL_HOOK_RESULT]: hook,
    }
  })
  const offPost = loopEvents.on('post-tool', async ({ call, result }) => {
    if (!enabled || !job?.userId) return
    try {
      await dispatchHooks({
        userId: job.userId,
        event: 'post_tool_use',
        tool: call.name,
        args: { input: call.args, output: result },
        sessionId: job.id || null,
        requestId: step?.id || null,
      })
    } catch {
      // The tool outcome is already final; observer failures cannot replay it.
    }
  })

  return () => {
    offPre()
    offPost()
  }
}

function clonePreToolCall(call) {
  try {
    return structuredClone(call)
  } catch (cause) {
    const error = new TypeError('Loop tool call must be cloneable data before pre-tool dispatch', { cause })
    error.code = 'LOOP_PRE_TOOL_CALL_INVALID'
    throw error
  }
}

/** Allow plugins to replace args without taking ownership of call identity or checkpoints. */
export async function runPreTool({ loopEvents, call, context = {} } = {}) {
  const initial = assertToolCall(call)
  if (!loopEvents || typeof loopEvents.waterfall !== 'function') return initial
  const prepared = assertToolCall(await loopEvents.waterfall(
    'pre-tool',
    clonePreToolCall(initial),
    context,
  ))
  return {
    ...initial,
    args: prepared.args,
    ...(Object.hasOwn(prepared, TOOL_HOOK_RESULT)
      ? { [TOOL_HOOK_RESULT]: prepared[TOOL_HOOK_RESULT] }
      : {}),
  }
}

/** Observe an isolated immutable snapshot of the final tool outcome. */
export async function runPostTool({ loopEvents, call, result, context = {} } = {}) {
  return observeLoopEvent({
    loopEvents,
    event: 'post-tool',
    value: { call: assertToolCall(call), result },
    context,
  })
}

/**
 * Small embeddable executor used by tests and alternate loop hosts. The main
 * runtime uses the same pre/post helpers around its approval-aware executor.
 */
export async function executeToolCall({
  loopEvents = null,
  call,
  executeTool,
  beforeTool = null,
  context = {},
} = {}) {
  if (typeof executeTool !== 'function') throw new TypeError('executeTool must be a function')
  const prepared = await runPreTool({ loopEvents, call, context })
  if (typeof beforeTool === 'function') {
    await beforeTool({ call: prepared, kind: 'tool' })
  }
  let result
  try {
    result = await executeTool(prepared)
  } catch (error) {
    result = { ok: false, error }
    await runPostTool({ loopEvents, call: prepared, result, context })
    throw error
  }
  await runPostTool({ loopEvents, call: prepared, result, context })
  return { call: prepared, result }
}
