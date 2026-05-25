/**
 * 任务级工具预算(M3.5)。
 *
 * runToolsLoop 已经有 maxIters=6,但每 iter 可以请求 N 个 tool calls,
 * 加上 Agent 工具能 spawn 子代理(子代理又有自己的 8 iter),
 * 一个失控 job 实际可以炸到几百个工具调用 → token 烧爆.
 *
 * 本模块给 job 一个累积预算:
 *   - maxTotalCalls(默认 80):整个 job 所有 step + 所有子代理总和工具调用数
 *   - maxWallMs(默认 10 分钟):job 总挂钟时间
 *   - 任一超限 → 后续 executeTool 直接拒绝返回 { ok:false, error:'budget exceeded' }
 *
 * 由 jobRuntime 在 job 启动时 createJobBudget,挂在 job 上;
 * runToolsLoop/subagentToolsLoop 在每次 executeTool 前调 consume,超了就停.
 */

const DEFAULT_MAX_CALLS = 80
const DEFAULT_MAX_WALL_MS = 10 * 60 * 1000

// ★ Lens-2:用 WeakMap 而不是 job.__budget,模型/工具碰不到、不能 delete 绕过
const BUDGET_BY_JOB = new WeakMap()

export function attachJobBudget(job, opts) {
  if (!job || typeof job !== 'object') return null
  let b = BUDGET_BY_JOB.get(job)
  if (!b) { b = createJobBudget(opts); BUDGET_BY_JOB.set(job, b) }
  return b
}

export function getJobBudget(job) {
  if (!job || typeof job !== 'object') return null
  return BUDGET_BY_JOB.get(job) || null
}

export function createJobBudget({
  maxTotalCalls = DEFAULT_MAX_CALLS,
  maxWallMs = DEFAULT_MAX_WALL_MS,
  now = () => Date.now(),
} = {}) {
  const startedAt = now()
  let used = 0
  return {
    consume(cost = 1) {
      used += cost
      const elapsed = now() - startedAt
      if (used > maxTotalCalls) {
        return { ok: false, reason: `tool call budget exceeded (${used}/${maxTotalCalls})` }
      }
      if (elapsed > maxWallMs) {
        return { ok: false, reason: `wall-clock budget exceeded (${elapsed}ms / ${maxWallMs}ms)` }
      }
      return { ok: true, used, remaining: maxTotalCalls - used, elapsed }
    },
    snapshot() {
      return { used, maxTotalCalls, elapsed: now() - startedAt, maxWallMs }
    },
  }
}
