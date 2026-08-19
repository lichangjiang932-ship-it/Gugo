/**
 * Backward-compatible facade for the shared tool-loop runtime.
 *
 * New runtime consumers should import from `./loop/index.js`. Heuristic helper
 * exports remain here so existing integrations do not need a flag-day change.
 */
import {
  attachVisionFeedback,
  resolveVisionFeedbackMaxBytes,
  visionFeedbackMime,
} from './toolLoopHeuristics.js'

export {
  SERVER_TOOL_SPECS,
  buildJobToolIdempotencyKey,
  buildSubagentRequest,
  inheritedJobSkillIds,
  persistLocalToolArtifacts,
  scopeTextToolCallIds,
  selectJobToolSpecs,
  selectToolSpecs,
} from './toolLoopHeuristics.js'

export { runToolLoop, runToolsLoop } from './loop/index.js'

export const _testing = {
  attachVisionFeedback,
  visionFeedbackMime,
  resolveVisionFeedbackMaxBytes,
}
