/**
 * 死循环 advisory 护栏 —— 检测「同一工具 + 相同参数」的连续重复调用。
 *
 * 与 deepseek-harness 的 repeat-tool-guard 同思路：一个模型卡在循环里会反复发出
 * 字节级相同的工具调用（重读同一个文件、重跑同一条 grep、重装同一个依赖），
 * 即使每次都「成功」也不产生任何新信息 —— 只烧 token / 时间 / 钱。
 *
 * 现有 noProgress / failureRecovery / executionConvergence 只拦「失败」和
 * 「只探索不产出」，漏掉了「成功但重复」这一档。本模块补上它：
 *
 *   - 计数的键是 (工具名, 规范化参数)，规范化做递归 key 排序 + JSON.stringify，
 *     参数键顺序不同不干扰判定；相同键连续出现才累计，出现不同调用即重置。
 *   - exclude 里的记账类工具**透明**：既不累计也不打断链条
 *     （grep X → manage_todos → grep X 仍算两次连续 grep X）。
 *   - 只给 advisory 提醒（注入 system 提示），从不拦截/改写调用 ——
 *     模型自己决定换策略还是收尾。
 *
 * 纯函数、无 IO、无副作用，符合 utils/ 红线。
 */

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) out[key] = stable(value[key])
    return out
  }
  return value
}

function canonicalKey(name, args) {
  return JSON.stringify([String(name || ''), stable(args ?? {})])
}

const DEFAULT_EXCLUDE = new Set([
  'manage_todos',
  'reflect',
  'request_clarification',
  'request_directory',
  'sleep_until',
])

export function createRepeatCallGuard({
  thresholds = [3, 5, 8],
  exclude = DEFAULT_EXCLUDE,
  argumentsPreviewChars = 500,
} = {}) {
  const safeThresholds = [...new Set(thresholds)]
    .filter((value) => Number.isInteger(value) && value >= 2)
    .sort((left, right) => left - right)
  let current = null
  const fired = new Set()

  const preview = (args) => {
    let text
    try {
      text = JSON.stringify(args ?? {})
    } catch {
      text = String(args ?? '')
    }
    return text.length > argumentsPreviewChars ? `${text.slice(0, argumentsPreviewChars)}…` : text
  }

  const contentFor = (tool, count, argsText, first) => {
    if (first) {
      return [
        'You are about to repeat the same tool call again.',
        `Analyze the previous result of ${tool} before retrying. If it did not advance the task, change course instead of repeating identical arguments.`,
      ].join(' ')
    }
    return [
      `The same tool call (${tool}) has now been issued ${count} times with identical arguments and produced no new information.`,
      `Arguments: ${argsText}`,
      'Stop repeating it. Choose a materially different action, verify the concrete state instead of re-issuing the call, or report one specific blocker.',
    ].join(' ')
  }

  return {
    /**
     * 记录一次工具调用。命中阈值时返回一条可直接注入的提醒，否则返回 null。
     * exclude 里的工具对链条透明（既不累计也不重置）。
     */
    record(name, args) {
      const tool = String(name || '').trim()
      if (!tool || exclude.has(tool)) return null
      const key = canonicalKey(tool, args)
      if (current?.key === key) current.count += 1
      else current = { key, count: 1 }
      if (!safeThresholds.includes(current.count)) return null
      const firedKey = `${key}\u0000${current.count}`
      if (fired.has(firedKey)) return null
      fired.add(firedKey)
      return {
        tool,
        count: current.count,
        first: current.count === safeThresholds[0],
        content: contentFor(tool, current.count, preview(args), current.count === safeThresholds[0]),
      }
    },
    /** 用户干预（steering / 新输入）后重置，跨干预的重复不算死循环。 */
    reset() {
      current = null
      fired.clear()
    },
  }
}
