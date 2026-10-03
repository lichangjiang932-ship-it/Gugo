/**
 * Offer the goal-plan tools to the loop for this turn.
 *
 * The tools are appended after every other tool because they are the most
 * volatile part of the block (they exist only for sessions with an active
 * plan), so their presence only extends the provider tool block instead of
 * reordering a cached prefix for sessions that already had one. The prompt
 * block is injected separately by `prepareTurnPromptContext`; both read the
 * same `goalToolContextForTurn` source, and the tool set is what the loop
 * actually executes against.
 */
export function initializeGoalToolVisibility(s) {
  const { goalToolContextForTurn, toolNameFromSpec } = s.d
  if (typeof goalToolContextForTurn !== 'function' || !Array.isArray(s.activeToolSpecs)) return
  let context
  try {
    context = goalToolContextForTurn({
      userId: s.job?.userId || null,
      sessionId: s.job?.sessionId || null,
    })
  } catch {
    // Goal visibility is advisory; a lookup failure must not block the turn.
    return
  }
  if (!context?.active || !Array.isArray(context.toolSpecs) || context.toolSpecs.length === 0) return
  const present = new Set(s.activeToolSpecs.map(toolNameFromSpec).filter(Boolean))
  for (const spec of context.toolSpecs) {
    const name = toolNameFromSpec(spec)
    if (!name || present.has(name)) continue
    // Marked dynamic on purpose: these appear mid-session (when a plan is
    // created or approved), so they must append to the provider tool block
    // instead of being sorted into the middle of the base set. Pushing a copy
    // also keeps the shared GOAL_TOOL_SPECS constant immutable.
    s.activeToolSpecs.push({ ...spec, __gugoDynamicTool: true })
    present.add(name)
  }
}
