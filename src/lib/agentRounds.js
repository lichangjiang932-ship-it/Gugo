/**
 * Pair the model's ReAct narrative with the tool calls the runtime actually made,
 * so the process reads as the loop it claims to be:
 *
 *   思考 → 行动 → (该次调用与它的结果) → 观察 → 思考 → …
 *
 * Why pairing is needed at all: the recorded events are not in that order. A
 * model that answers in the 【Thought】/【Action】/【Observation】 format usually
 * runs its tools first and writes the whole narrative afterwards, so the event
 * timeline is "tools, then one block of text" while the narrative describes
 * thought → action → observation. Rendering the two separately puts every call
 * at the top, which is exactly the complaint this exists to fix.
 *
 * Pairing is by order, and only when the counts agree: if the narrative names as
 * many actions as the runtime recorded, the k-th 【Action】 is that k-th call. If
 * they disagree, the correspondence is unknown and no pairing is returned — a
 * wrong pairing would attribute a real command to the wrong step, which is worse
 * than showing the two records side by side. Callers fall back in that case.
 *
 * Pure: no IO, no i18n, no React.
 */

export const AGENT_ROUND_KIND = Object.freeze({
  THOUGHT: 'thought',
  ACTION: 'action',
  OBSERVATION: 'observation',
  TOOL: 'tool',
})

/**
 * @param {{trajectory?: Array<{kind: string, text: string}>, toolCalls?: Array<object>}} input
 * @returns {{steps: Array<object>, leftoverCalls: Array<{call: object, index: number}>}|null}
 *   `null` when there is no narrative to build a loop from — a turn that only ran
 *   tools keeps the grouped tool timeline instead (查阅 · 2 搜索, 2 文件), which is
 *   the better reading when no round was described. Otherwise the steps pair the
 *   k-th action with the k-th recorded call, and any calls the narrative never
 *   mentioned (framework calls like setting deliverables) come back as leftovers
 *   so nothing the runtime did is dropped.
 */
export function buildAgentRounds({ trajectory, toolCalls } = {}) {
  // Blank entries are dropped before anything is counted: a step the reader never
  // sees must not consume a recorded call, or the pairing would silently shift by
  // one from that point on.
  const entries = (Array.isArray(trajectory) ? trajectory : [])
    .filter((entry) => String(entry?.text || '').trim())
  const calls = Array.isArray(toolCalls) ? toolCalls : []
  if (entries.length === 0) return null

  let cursor = 0
  const steps = []
  for (const entry of entries) {
    steps.push({ kind: entry.kind, text: entry.text })
    if (entry.kind !== AGENT_ROUND_KIND.ACTION) continue
    const call = calls[cursor]
    if (!call) continue
    cursor += 1
    steps.push({ kind: AGENT_ROUND_KIND.TOOL, call, index: cursor - 1 })
  }
  return {
    steps,
    leftoverCalls: calls.slice(cursor).map((call, offset) => ({ call, index: cursor + offset })),
  }
}

/**
 * Group the steps the way the timeline reads them: 「思考 / 行动 / 观察」 rows with
 * the tool row belonging to the action that asked for it, followed by any call
 * the narrative never mentioned.
 *
 * @param {Array<object>} steps from `buildAgentRounds`
 * @param {Array<{call: object, index: number}>} leftoverCalls unmentioned calls
 * @returns {Array<{kind: string, text?: string, tool?: {call: object, index: number}}>}
 */
export function toAgentRoundList(steps = [], leftoverCalls = []) {
  const list = []
  for (const step of Array.isArray(steps) ? steps : []) {
    if (!step) continue
    if (step.kind === AGENT_ROUND_KIND.TOOL) {
      // The tool row belongs to the action it followed, not to a block of its own.
      const previous = list[list.length - 1]
      if (previous && previous.kind === AGENT_ROUND_KIND.ACTION && !previous.tool) {
        list[list.length - 1] = { ...previous, tool: { call: step.call, index: step.index } }
        continue
      }
      list.push({ kind: AGENT_ROUND_KIND.TOOL, tool: { call: step.call, index: step.index } })
      continue
    }
    list.push({ kind: step.kind, text: step.text })
  }
  for (const leftover of Array.isArray(leftoverCalls) ? leftoverCalls : []) {
    if (!leftover?.call) continue
    list.push({
      kind: AGENT_ROUND_KIND.TOOL,
      tool: { call: leftover.call, index: leftover.index },
      leftover: true,
    })
  }
  return list
}
