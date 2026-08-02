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

// 提高迭代上限后,这里才是真正的收敛点(和成本线性相关)。
//
// ★ 200 → 2000 并可配。200 次调用对「读完一个中等项目再动手改」偏紧 ——
// 光探索就可能几十次,真正改代码又是几十次,还要验证。碰到上限
// 用户看到的就是「做到一半没后续」。用 JOB_MAX_TOOL_CALLS 可覆盖。
const DEFAULT_MAX_CALLS = (() => {
  const raw = Number(process.env.JOB_MAX_TOOL_CALLS)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 2000
})()

// ★ 墙钟从 60 分钟提到 6 小时并可配。
//
// 注意这个墙钟**已经不含模型延迟**了(见下面 trackModelMs)——
// 它只统计工具真正执行的时间。6 小时的「纯工具执行时间」意味着
// 真的有东西卡死了,而不是「任务比较大」。
// 设 0 = 完全不限时间(只靠调用次数和用户手动取消收敛)。
const DEFAULT_MAX_WALL_MS = (() => {
  const raw = Number(process.env.JOB_MAX_WALL_MS)
  if (Number.isFinite(raw) && raw >= 0) return Math.floor(raw)
  return 6 * 60 * 60 * 1000
})()

function envLimit(name, fallback) {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback
}

const DEFAULT_MAX_MODEL_CALLS = envLimit('JOB_MAX_MODEL_CALLS', 100)
const DEFAULT_MAX_MODEL_TOKENS = envLimit('JOB_MAX_MODEL_TOKENS', 200_000)
const DEFAULT_MAX_COST_USD = envLimit('JOB_MAX_COST_USD', 5)

// ★ Lens-2:用 WeakMap 而不是 job.__budget,模型/工具碰不到、不能 delete 绕过
//
// ⚠ 键必须是**稳定的对象**。jobRuntime 每个 tick 都会 getJobWithChildren(job.id)
// 拿一个全新的 job 对象,用它当键的话每 tick 都是一份新预算 —— 累积语义完全失效。
// 所以这里按 job.id 索引,WeakMap 只用于没有 id 的场景。
const BUDGET_BY_JOB = new WeakMap()
const BUDGET_BY_ID = new Map()

export function attachJobBudget(job, opts) {
  if (!job || typeof job !== 'object') return null
  const id = job.id ? String(job.id) : ''
  if (id) {
    let byId = BUDGET_BY_ID.get(id)
    if (!byId) { byId = createJobBudget(opts); BUDGET_BY_ID.set(id, byId) }
    return byId
  }
  let b = BUDGET_BY_JOB.get(job)
  if (!b) { b = createJobBudget(opts); BUDGET_BY_JOB.set(job, b) }
  return b
}

export function getJobBudget(job) {
  if (!job || typeof job !== 'object') return null
  const id = job.id ? String(job.id) : ''
  if (id && BUDGET_BY_ID.has(id)) return BUDGET_BY_ID.get(id)
  return BUDGET_BY_JOB.get(job) || null
}

/** job 终结时清掉,避免 BUDGET_BY_ID 无限增长。 */
export function releaseJobBudget(jobId) {
  if (jobId) BUDGET_BY_ID.delete(String(jobId))
}

export function createJobBudget({
  maxTotalCalls = DEFAULT_MAX_CALLS,
  maxWallMs = DEFAULT_MAX_WALL_MS,
  maxModelCalls = DEFAULT_MAX_MODEL_CALLS,
  maxModelTokens = DEFAULT_MAX_MODEL_TOKENS,
  maxCostUsd = DEFAULT_MAX_COST_USD,
  initialUsed = 0,
  initialElapsedMs = 0,
  initialModelMs = 0,
  initialModelCalls = 0,
  initialModelTokens = 0,
  initialCostUsd = 0,
  now = () => Date.now(),
} = {}) {
  const startedAt = now() - Math.max(0, Number(initialElapsedMs) || 0)
  let used = Math.max(0, Number(initialUsed) || 0)
  // 花在等模型上的时间。从墙钟里扣掉 —— 见 trackModelMs。
  let modelMs = Math.max(0, Number(initialModelMs) || 0)
  let modelCalls = Math.max(0, Number(initialModelCalls) || 0)
  let modelTokens = Math.max(0, Number(initialModelTokens) || 0)
  let costUsd = Math.max(0, Number(initialCostUsd) || 0)

  const modelLimitStatus = () => {
    if (maxModelCalls > 0 && modelCalls > maxModelCalls) {
      return { ok: false, reason: `model call budget exceeded (${modelCalls}/${maxModelCalls})` }
    }
    if (maxModelTokens > 0 && modelTokens > maxModelTokens) {
      return { ok: false, reason: `model token budget exceeded (${modelTokens}/${maxModelTokens})` }
    }
    if (maxCostUsd > 0 && costUsd > maxCostUsd) {
      return { ok: false, reason: `model cost budget exceeded ($${costUsd.toFixed(4)}/$${Number(maxCostUsd).toFixed(2)})` }
    }
    return { ok: true }
  }

  const workingElapsed = () => Math.max(0, now() - startedAt - modelMs)

  return {
    /**
     * ★ 把「等模型」的时间从墙钟预算里扣掉。
     *
     * 墙钟预算的本意是「别让一个 job 无限占着 runtime」,针对的是工具执行时间。
     * 但原实现把模型延迟也算进去了,于是**模型越慢,能做的事越少** ——
     * 这个方向完全是反的:本地模型慢是常态,不是失控信号。
     * 一个 40s/轮的本地模型跑 30 轮就被判「超预算」,然后返回空文本。
     */
    trackModelMs(ms) {
      const value = Number(ms)
      if (Number.isFinite(value) && value > 0) modelMs += value
    },
    consumeModelCall() {
      modelCalls += 1
      return { ...modelLimitStatus(), modelCalls, remaining: Math.max(0, maxModelCalls - modelCalls) }
    },
    trackModelUsage(usage = {}, reportedCostUsd = 0) {
      const promptTokens = Math.max(0, Number(usage?.promptTokens) || 0)
      const completionTokens = Math.max(0, Number(usage?.completionTokens) || 0)
      modelTokens += promptTokens + completionTokens
      const nextCost = Number(reportedCostUsd)
      if (Number.isFinite(nextCost) && nextCost > 0) costUsd += nextCost
      return { ...modelLimitStatus(), modelTokens, costUsd }
    },
    consume(cost = 1) {
      used += cost
      const elapsed = workingElapsed()
      if (used > maxTotalCalls) {
        return { ok: false, reason: `tool call budget exceeded (${used}/${maxTotalCalls})` }
      }
      // maxWallMs 为 0 = 不限时间(只靠调用次数和用户取消收敛)
      if (maxWallMs > 0 && elapsed > maxWallMs) {
        return { ok: false, reason: `wall-clock budget exceeded (${elapsed}ms / ${maxWallMs}ms)` }
      }
      return { ok: true, used, remaining: maxTotalCalls - used, elapsed }
    },
    snapshot() {
      return {
        used,
        maxTotalCalls,
        elapsed: workingElapsed(),
        maxWallMs,
        modelMs,
        modelCalls,
        maxModelCalls,
        modelTokens,
        maxModelTokens,
        costUsd,
        maxCostUsd,
      }
    },
  }
}
