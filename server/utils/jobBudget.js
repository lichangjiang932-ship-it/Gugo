import { normalizeOptionalUsageNumber } from '../../shared/modelUsage.js'

export const MODEL_BUDGET_LIMIT_TYPES = Object.freeze({
  MODEL_CALLS: 'model_calls',
  MODEL_TOKENS: 'model_tokens',
})
export const RETIRED_DOLLAR_BUDGET_ERROR_CODE = 'JOB_BUDGET_DOLLAR_GATE_RETIRED'

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
function envLimit(env, name, fallback) {
  const raw = Number(env?.[name])
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback
}

export function resolveJobBudgetDefaults(env = process.env) {
  const rawToolCalls = Number(env?.JOB_MAX_TOOL_CALLS)
  const rawWallMs = Number(env?.JOB_MAX_WALL_MS)
  return {
    maxTotalCalls: Number.isFinite(rawToolCalls) && rawToolCalls > 0
      ? Math.floor(rawToolCalls)
      : 2000,
    maxWallMs: Number.isFinite(rawWallMs) && rawWallMs >= 0
      ? Math.floor(rawWallMs)
      : 6 * 60 * 60 * 1000,
    maxModelCalls: envLimit(env, 'JOB_MAX_MODEL_CALLS', 2000),
    maxModelTokens: envLimit(env, 'JOB_MAX_MODEL_TOKENS', 0),
  }
}

const DEFAULTS = resolveJobBudgetDefaults()
const DEFAULT_MAX_CALLS = DEFAULTS.maxTotalCalls

// ★ 墙钟从 60 分钟提到 6 小时并可配。
//
// 注意这个墙钟**已经不含模型延迟**了(见下面 trackModelMs)——
// 它只统计工具真正执行的时间。6 小时的「纯工具执行时间」意味着
// 真的有东西卡死了,而不是「任务比较大」。
// 设 0 = 完全不限时间(只靠调用次数和用户手动取消收敛)。
const DEFAULT_MAX_WALL_MS = DEFAULTS.maxWallMs

// Model budgets are opt-in technical guardrails, not normal-work limits. The previous
// 100-call / 200k-token defaults stopped long agent runs mid-task even though
// the tool loop itself intentionally allows 2000 iterations.
const DEFAULT_MAX_MODEL_CALLS = DEFAULTS.maxModelCalls
const DEFAULT_MAX_MODEL_TOKENS = DEFAULTS.maxModelTokens

// ★ Lens-2:用 WeakMap 而不是 job.__budget,模型/工具碰不到、不能 delete 绕过
//
// ⚠ 键必须是**稳定的对象**。jobRuntime 每个 tick 都会 getJobWithChildren(job.id)
// 拿一个全新的 job 对象,用它当键的话每 tick 都是一份新预算 —— 累积语义完全失效。
// 所以这里按稳定的 (origin, userId, id) 复合作用域索引,WeakMap 只用于没有
// id 的场景。单独使用 id 会让不同用户的同名任务、或 chat turn 与后台 job
// 共享计数器，且任意一方终结时会误删另一方的索引。
const BUDGET_BY_JOB = new WeakMap()
const BUDGET_BY_ID = new Map()

function scopedBudgetKey(job) {
  if (!job || typeof job !== 'object') return ''
  const id = job.id == null ? '' : String(job.id)
  if (!id) return ''
  const origin = job.origin == null || job.origin === '' ? 'job' : String(job.origin)
  const userId = job.userId == null ? '' : String(job.userId)
  return JSON.stringify([origin, userId, id])
}

export function attachJobBudget(job, opts) {
  if (!job || typeof job !== 'object') return null
  const key = scopedBudgetKey(job)
  if (key) {
    let byId = BUDGET_BY_ID.get(key)
    if (!byId) { byId = createJobBudget(opts); BUDGET_BY_ID.set(key, byId) }
    return byId
  }
  let b = BUDGET_BY_JOB.get(job)
  if (!b) { b = createJobBudget(opts); BUDGET_BY_JOB.set(job, b) }
  return b
}

export function getJobBudget(job) {
  if (!job || typeof job !== 'object') return null
  const key = scopedBudgetKey(job)
  if (key && BUDGET_BY_ID.has(key)) return BUDGET_BY_ID.get(key)
  return BUDGET_BY_JOB.get(job) || null
}

/** job 终结时比较并清掉所有者持有的预算,避免旧清理误删同作用域新实例。 */
export function releaseJobBudget(jobOrId, expectedBudget, scope = {}) {
  const job = jobOrId && typeof jobOrId === 'object'
    ? jobOrId
    : { ...scope, id: jobOrId }
  const key = scopedBudgetKey(job)
  if (!key || !expectedBudget || BUDGET_BY_ID.get(key) !== expectedBudget) return false
  return BUDGET_BY_ID.delete(key)
}

function modelBudgetError(reason, partialModelResult, budgetStatus = null) {
  const error = new Error(reason || 'model budget exceeded')
  error.code = 'MODEL_BUDGET_EXCEEDED'
  if (budgetStatus?.budgetLimitType) error.budgetLimitType = budgetStatus.budgetLimitType
  if (Array.isArray(budgetStatus?.budgetLimitTypes)) {
    error.budgetLimitTypes = [...budgetStatus.budgetLimitTypes]
  }
  if (partialModelResult !== undefined) error.partialModelResult = partialModelResult
  return error
}

function mustStopForModelBudget(status, allowOverBudget) {
  return status?.ok === false && !allowOverBudget
}

/** Account for one real provider request recovered from an in-flight checkpoint. */
export function recordRecoveredModelResult(budget, result, {
  allowOverBudget = false,
} = {}) {
  // A recovered response proves the provider call already happened. Account
  // for it even when it crosses a configured limit, then surface the limit as
  // a terminal error carrying the authoritative partial result.
  const callStatus = budget?.consumeModelCall?.({ allowOverBudget: true }) || { ok: true }
  const usageStatus = budget?.trackModelUsage?.(result?.usage, result?.costUsd) || { ok: true }
  const exceededStatuses = [callStatus, usageStatus].filter((status) => status?.ok === false)
  const exceeded = exceededStatuses[0]
  if (exceeded && !allowOverBudget) {
    throw modelBudgetError(
      exceeded.reason,
      result,
      exceeded,
    )
  }
  return result
}

/** Account for one real provider request, including context-recovery retries. */
export async function runWithModelBudget(budget, run, {
  allowOverBudget = false,
  now = () => Date.now(),
} = {}) {
  if (typeof run !== 'function') throw new Error('run is required')
  const callStatus = budget?.consumeModelCall?.({ allowOverBudget }) || { ok: true }
  if (mustStopForModelBudget(callStatus, allowOverBudget)) {
    throw modelBudgetError(callStatus.reason, undefined, callStatus)
  }
  const startedAt = now()
  let result
  try {
    result = await run()
  } finally {
    budget?.trackModelMs?.(Math.max(0, now() - startedAt))
  }
  const usageStatus = budget?.trackModelUsage?.(result?.usage, result?.costUsd) || { ok: true }
  if (mustStopForModelBudget(usageStatus, allowOverBudget)) {
    throw modelBudgetError(usageStatus.reason, result, usageStatus)
  }
  return result
}

function normalizeJobBudgetOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('job budget options must be an object')
  }
  if (Object.hasOwn(options, 'maxCostUsd')) {
    const error = new Error(
      'maxCostUsd is retired; Provider cost estimates are local telemetry and cannot gate BYOK requests',
    )
    error.code = RETIRED_DOLLAR_BUDGET_ERROR_CODE
    error.statusCode = 400
    throw error
  }
  return {
    maxTotalCalls: options.maxTotalCalls ?? DEFAULT_MAX_CALLS,
    maxWallMs: options.maxWallMs ?? DEFAULT_MAX_WALL_MS,
    maxModelCalls: options.maxModelCalls ?? DEFAULT_MAX_MODEL_CALLS,
    maxModelTokens: options.maxModelTokens ?? DEFAULT_MAX_MODEL_TOKENS,
    initialUsed: options.initialUsed ?? 0,
    initialElapsedMs: options.initialElapsedMs ?? 0,
    initialModelMs: options.initialModelMs ?? 0,
    initialModelCalls: options.initialModelCalls ?? 0,
    initialModelTokens: options.initialModelTokens ?? 0,
    initialCostUsd: options.initialCostUsd,
    initialCostEvidenceComplete: options.initialCostEvidenceComplete,
    now: options.now ?? (() => Date.now()),
  }
}

function restoredCostEvidenceIsComplete({
  initialCostEvidenceComplete,
  restoredCostUsd,
  hasHistoricalModelUsage,
  initialCostUsd,
}) {
  if (initialCostEvidenceComplete === false) return false
  if (initialCostEvidenceComplete === true) {
    return restoredCostUsd !== null || (!hasHistoricalModelUsage && initialCostUsd === undefined)
  }
  return !hasHistoricalModelUsage
    && (initialCostUsd === undefined || restoredCostUsd !== null)
}

export function createJobBudget(options = {}) {
  const {
    maxTotalCalls, maxWallMs, maxModelCalls, maxModelTokens,
    initialUsed, initialElapsedMs, initialModelMs, initialModelCalls,
    initialModelTokens, initialCostUsd, initialCostEvidenceComplete, now,
  } = normalizeJobBudgetOptions(options)
  const initialWorkingMs = Math.max(0, Number(initialElapsedMs) || 0)
  let used = Math.max(0, Number(initialUsed) || 0)
  // 花在等模型上的时间。从墙钟里扣掉 —— 见 trackModelMs。
  let modelMs = Math.max(0, Number(initialModelMs) || 0)
  // `initialElapsedMs` comes from snapshot().elapsed and therefore already
  // excludes model wait time. Rewind both counters so restoring a checkpoint
  // does not subtract the historical model time a second time.
  const startedAt = now() - initialWorkingMs - modelMs
  let modelCalls = Math.max(0, Number(initialModelCalls) || 0)
  let modelTokens = Math.max(0, Number(initialModelTokens) || 0)
  const restoredCostUsd = normalizeOptionalUsageNumber(initialCostUsd)
  let costUsd = restoredCostUsd ?? 0
  const hasHistoricalModelUsage = modelCalls > 0 || modelTokens > 0
  // A fresh budget has complete empty evidence. A restored budget only has
  // complete evidence when the checkpoint explicitly says so and carries a
  // valid cumulative value (zero is valid). Older checkpoints predate the
  // evidence marker, so their historical zero cannot be distinguished from
  // the old "unknown => 0" fallback and must remain unknown.
  let costEvidenceComplete = restoredCostEvidenceIsComplete({
    initialCostEvidenceComplete,
    restoredCostUsd,
    hasHistoricalModelUsage,
    initialCostUsd,
  })

  const exposedCostUsd = () => (costEvidenceComplete ? costUsd : null)

  const modelLimitStatus = () => {
    const exceeded = []
    if (maxModelCalls > 0 && modelCalls > maxModelCalls) {
      exceeded.push({
        budgetLimitType: MODEL_BUDGET_LIMIT_TYPES.MODEL_CALLS,
        reason: `model call budget exceeded (${modelCalls}/${maxModelCalls})`,
      })
    }
    if (maxModelTokens > 0 && modelTokens > maxModelTokens) {
      exceeded.push({
        budgetLimitType: MODEL_BUDGET_LIMIT_TYPES.MODEL_TOKENS,
        reason: `model token budget exceeded (${modelTokens}/${maxModelTokens})`,
      })
    }
    if (exceeded.length > 0) {
      return {
        ok: false,
        reason: exceeded[0].reason,
        budgetLimitType: exceeded[0].budgetLimitType,
        budgetLimitTypes: exceeded.map((item) => item.budgetLimitType),
      }
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
    consumeModelCall({ allowOverBudget = false } = {}) {
      const current = modelLimitStatus()
      // `allowOverBudget` permits one deliberate wrap-up beyond call/token limits.
      if (!current.ok && !allowOverBudget) {
        return { ...current, modelCalls, remaining: Math.max(0, maxModelCalls - modelCalls) }
      }
      if (!allowOverBudget && maxModelCalls > 0 && modelCalls >= maxModelCalls) {
        return {
          ok: false,
          reason: `model call budget exceeded (${modelCalls}/${maxModelCalls})`,
          budgetLimitType: MODEL_BUDGET_LIMIT_TYPES.MODEL_CALLS,
          budgetLimitTypes: [MODEL_BUDGET_LIMIT_TYPES.MODEL_CALLS],
          modelCalls,
          remaining: 0,
        }
      }
      modelCalls += 1
      return { ...modelLimitStatus(), modelCalls, remaining: Math.max(0, maxModelCalls - modelCalls) }
    },
    trackModelUsage(usage = {}, reportedCostUsd) {
      const promptTokens = Math.max(0, Number(usage?.promptTokens) || 0)
      const completionTokens = Math.max(0, Number(usage?.completionTokens) || 0)
      // Cached prompt tokens are historical context that the provider reused;
      // counting the full prompt again on every agent iteration makes a long
      // tool loop exhaust its token guardrail even when almost all input was a
      // cache hit. Provider cost remains telemetry only.
      const cacheHitTokens = Math.min(
        promptTokens,
        Math.max(0, Number(usage?.cacheHitTokens) || 0),
      )
      modelTokens += Math.max(0, promptTokens - cacheHitTokens) + completionTokens
      const nextCost = normalizeOptionalUsageNumber(reportedCostUsd)
      if (nextCost === null) costEvidenceComplete = false
      else costUsd += nextCost
      const limitStatus = modelLimitStatus()
      return { ...limitStatus, modelTokens, costUsd: exposedCostUsd() }
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
        costUsd: exposedCostUsd(),
        costEvidenceComplete,
        // Legacy checkpoint field. It is always zero because Gugo never gates
        // BYOK requests on a dollar estimate.
        maxCostUsd: 0,
      }
    },
  }
}
