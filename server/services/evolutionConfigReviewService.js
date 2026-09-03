import { buildEvolutionConfigApprovalReview } from './evolutionConfigChangeService.js'
import {
  evaluateEvolutionConfigReplay,
  runEvolutionConfigReplay,
} from './evolutionConfigReplayService.js'

export function reviewEvolutionConfigCandidate({
  userId,
  candidateId,
  cwd = process.cwd(),
  env = process.env,
  hostEnv = process.env,
  now = Date.now(),
} = {}) {
  const replay = runEvolutionConfigReplay({ userId, candidateId, cwd, env, hostEnv, now })
  const evaluation = evaluateEvolutionConfigReplay({ userId, replayId: replay.id, now })
  const approvalReview = buildEvolutionConfigApprovalReview({
    userId,
    evaluationId: evaluation.id,
  })
  const canApprove = approvalReview.eligibility.canApprove === true
  return Object.freeze({
    schemaVersion: 1,
    mode: 'automatic_deterministic_audit',
    state: canApprove ? 'awaiting_explicit_approval' : 'not_eligible',
    nextAction: canApprove ? 'request_explicit_approval' : 'revise_candidate',
    candidateId: approvalReview.candidate.id,
    replay,
    evaluation,
    approvalReview,
    controls: Object.freeze({
      approvalRequired: true,
      applyConfirmationRequired: true,
      automaticApproval: false,
      automaticApply: false,
      permissionExpansionAllowed: false,
      canaryAllowed: false,
      rollbackAvailableAfterExplicitApply: true,
    }),
  })
}
