/**
 * Goal-plan prompt injection and the single turn-level entry point that both
 * the loop (tool availability) and the prompt compiler (context block) use.
 *
 * The block is rendered from persisted state at turn start and then frozen for
 * the turn: it is appended after the stable skill/instruction blocks and after
 * memory, so a plan change never reorders a cached prefix. `prepareTurnPromptContext`
 * keeps it in the volatile tail by construction.
 */
import { GOAL_TOOL_SPECS, findActiveGoalPlan } from '../utils/goalTools.js'

const MAX_STEPS_IN_PROMPT = 32
const MAX_ACCEPTANCE_IN_PROMPT = 4

function renderAcceptance(item) {
  if (typeof item === 'string') return item.trim()
  if (!item || typeof item !== 'object') return ''
  if (item.kind === 'command') return `command ${item.command || (item.tools || []).join('/') || 'execution'}${item.cwd ? ` in ${item.cwd}` : ''}; successful final exit`
  if (item.kind === 'file') return `written file ${item.path || '(path required)'}${item.sha256 ? ` sha256=${item.sha256}` : ''}`
  if (item.kind === 'artifact') return `artifact ${item.artifactId || item.type || 'required'}`
  if (item.kind === 'verification') return 'host task verification passed'
  if (item.kind === 'manual') return 'human confirmation required through the human interface'
  return item.kind === 'tool' ? 'successful tool execution' : 'invalid acceptance; request a plan correction'
}

function stepLine(step) {
  const mark = step.evidenceVerified ? '✓' : '·'
  const evidence = step.evidence
    ? ` [evidence: turn ${step.evidence.turnId}${step.evidence.toolCallId ? ` / tool ${step.evidence.toolCallId}` : ''}]`
    : ''
  const acceptance = (step.acceptance || [])
    .slice(0, MAX_ACCEPTANCE_IN_PROMPT)
    .map(renderAcceptance)
    .filter(Boolean)
  const acceptanceText = acceptance.length > 0 ? ` (acceptance: ${acceptance.join(' | ')})` : ''
  return `- ${mark} ${step.ordinal}. [${step.status}] ${step.title}${acceptanceText}${evidence}`
}

/**
 * Pure renderer. Returns `null` when there is nothing to inject, so a session
 * without a plan produces byte-identical context to before this feature.
 */
export function buildGoalPlanPromptBlock(plan) {
  if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) return null
  const ordered = plan.steps.slice().sort((left, right) => left.ordinal - right.ordinal)
  const shown = ordered.slice(0, MAX_STEPS_IN_PROMPT)
  const steps = shown.map(stepLine)
  const hidden = ordered.length - shown.length
  if (hidden > 0) {
    // Never drop steps silently: a truncated plan must say so, because the
    // model cannot mark done what it cannot see.
    steps.push(`- … ${hidden} more step(s) not shown; call goal_plan_status for the full list`)
  }
  const done = ordered.filter((step) => step.status === 'done').length
  const skipped = ordered.filter((step) => step.status === 'skipped').length
  const next = ordered.find((step) => ['pending', 'in_progress'].includes(step.status))
  const blocked = ordered.filter((step) => step.status === 'blocked')
  const lines = [
    '# Active Goal Plan (host-persisted)',
    `Objective: ${plan.objective}`,
    `Plan: ${plan.id}  revision: ${plan.revision}  status: ${plan.status}`,
    `Steps (${done}/${ordered.length} done${skipped > 0 ? `, ${skipped} skipped` : ''}):`,
    ...steps,
    plan.status === 'awaiting_approval'
      ? 'This plan is not approved yet. Do not start work against it; the user must approve it first.'
      : next
        ? `Next actionable step: ${next.ordinal}. ${next.title}`
        : blocked.length
          ? 'Remaining work is blocked. Propose a justified replan or ask for the required human decision.'
          : 'Every step is done or skipped; nothing is left to execute.',
    'Keep step status current with goal_step_update. A step is only done with host-verified evidence; do not report a step as done in prose.',
  ]
  return lines.join('\n')
}

/**
 * Turn-level goal context. One dependency for both consumers so tool
 * availability and injected context can never disagree about which plan is
 * active.
 *
 * @returns {{active: boolean, planId: string|null, toolSpecs: object[], promptBlock: string|null}}
 */
export function goalToolContextForTurn({ userId = null, sessionId = null, requireAuthoritative = false } = {}) {
  const empty = { active: false, planId: null, toolSpecs: [], promptBlock: null }
  if (!userId || !sessionId) return empty
  let plan
  try {
    plan = findActiveGoalPlan({ userId, sessionId })
  } catch (error) {
    if (requireAuthoritative) throw error
    // Goal context is advisory: a storage hiccup must never block a turn.
    return empty
  }
  if (!plan) return empty
  if (requireAuthoritative) return { active: true, planId: plan.id, revision: plan.revision, status: plan.status }
  return {
    active: true,
    planId: plan.id,
    toolSpecs: GOAL_TOOL_SPECS,
    promptBlock: buildGoalPlanPromptBlock(plan),
  }
}
