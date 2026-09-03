import { callBackgroundModel } from '../adapters/modelProxy.js'
import { ensureSafetySystemMessages } from './promptCompiler.js'
import { evaluateTaskAcceptance, parseTaskEvaluation } from './jobWorkflow.js'
import { evaluateTaskVerificationAcceptance } from './jobTaskAcceptance.js'

const MAX_REVIEW_TEXT_CHARS = 24_000
const MAX_REVIEW_EVIDENCE_CHARS = 12_000

function clean(value, max = 512) {
  return String(value || '').trim().slice(0, max)
}

function enabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase())
}

function reviewerMetadata({ independent, mode, reviewerModel, workerModel, error = null }) {
  return {
    independent,
    mode,
    reviewerModel: clean(reviewerModel) || null,
    workerModel: clean(workerModel) || null,
    ...(error ? { error: clean(error, 1_000) } : {}),
  }
}

function withReviewer(acceptance, reviewer) {
  return { ...acceptance, reviewer: Object.freeze(reviewer) }
}

function blockedAcceptance(summary, issue, reviewer) {
  return withReviewer({
    verdict: 'blocked',
    summary,
    issues: [issue],
    evidence: [],
    source: 'independent_reviewer',
  }, reviewer)
}

function buildReviewerMessages({ job, step, text, evidence, artifactIds, workerModel }) {
  const acceptanceCriteria = Array.isArray(step?.input?.acceptance) ? step.input.acceptance : []
  const completedSteps = (Array.isArray(job?.steps) ? job.steps : [])
    .filter((candidate) => candidate?.id !== step?.id && candidate?.status === 'completed')
    .slice(-12)
    .map((candidate) => ({
      id: candidate.id,
      kind: candidate.kind,
      title: candidate.title,
      summary: clean(candidate.output?.summary || candidate.output?.text, 1_500),
      artifactIds: Array.isArray(candidate.output?.artifactIds) ? candidate.output.artifactIds.slice(0, 30) : [],
    }))
  return ensureSafetySystemMessages([
    {
      role: 'system',
      content: [
        'You are an independent terminal task reviewer. You did not perform the work and must not trust the worker self-evaluation.',
        'Judge only the supplied objective, acceptance criteria, completed-step facts, artifacts, and concrete verification evidence.',
        'A worker claim is not evidence. Missing, ambiguous, or contradictory evidence cannot receive pass.',
        'Use fixable only when another bounded repair attempt can address the issue; use blocked for environment/external failures; use needs_user only for required user input or authorization.',
        'Return exactly one <task_evaluation> JSON marker and no other text.',
        '<task_evaluation>{"verdict":"pass|fixable|blocked|needs_user","summary":"decision","issues":["issue"],"evidence":["specific evidence"]}</task_evaluation>',
      ].join(' '),
    },
    {
      role: 'user',
      content: JSON.stringify({
        objective: clean(job?.prompt, 8_000),
        acceptanceCriteria: acceptanceCriteria.slice(0, 50),
        workerModel: clean(workerModel) || null,
        completedSteps,
        artifactIds: (Array.isArray(artifactIds) ? artifactIds : []).slice(0, 100),
        workerVerification: clean(text, MAX_REVIEW_TEXT_CHARS),
        evidence: (Array.isArray(evidence) ? evidence : [])
          .map((item) => clean(item, MAX_REVIEW_EVIDENCE_CHARS))
          .filter(Boolean)
          .slice(0, 50),
      }),
    },
  ])
}

export function createTaskReviewer({
  reviewerModelName = process.env.JOB_REVIEWER_MODEL_NAME,
  requireIndependent = enabled(process.env.JOB_REQUIRE_INDEPENDENT_REVIEWER),
  runReviewerModel = ({ messages, signal, userId, modelName, modelEnv }) => callBackgroundModel({
    messages,
    signal,
    userId: modelEnv ? null : userId,
    usageOwnerId: userId,
    modelName,
    ...(modelEnv ? { env: modelEnv } : {}),
  }),
  fallbackEvaluator = evaluateTaskAcceptance,
} = {}) {
  const configuredReviewerModel = clean(reviewerModelName)

  return async function reviewTask(input = {}) {
    const workerModel = clean(input.workerModelName || input.job?.modelName)
    const hostVerification = evaluateTaskVerificationAcceptance(input)
    if (hostVerification) return hostVerification

    const hasDistinctReviewer = configuredReviewerModel
      && workerModel
      && configuredReviewerModel !== workerModel

    if (!hasDistinctReviewer) {
      const reason = !configuredReviewerModel
        ? 'reviewer_not_configured'
        : !workerModel
          ? 'worker_model_unknown'
          : 'reviewer_matches_worker'
      const reviewer = reviewerMetadata({
        independent: false,
        mode: reason,
        reviewerModel: configuredReviewerModel,
        workerModel,
      })
      if (requireIndependent) {
        return blockedAcceptance(
          '任务要求独立 Reviewer，但没有配置与 worker 不同的审查模型',
          reason,
          reviewer,
        )
      }
      return withReviewer(await fallbackEvaluator(input), reviewer)
    }

    const reviewer = reviewerMetadata({
      independent: true,
      mode: 'distinct_model_review',
      reviewerModel: configuredReviewerModel,
      workerModel,
    })
    try {
      const response = await runReviewerModel({
        job: input.job,
        step: input.step,
        userId: input.job?.userId,
        signal: input.signal,
        modelName: configuredReviewerModel,
        modelEnv: input.modelEnv || null,
        messages: buildReviewerMessages({
          ...input,
          workerModel,
        }),
      })
      const acceptance = parseTaskEvaluation(String(response || ''))
      if (!acceptance) {
        return blockedAcceptance(
          '独立 Reviewer 未返回有效的结构化裁决',
          'missing_or_invalid_task_evaluation',
          reviewer,
        )
      }
      return withReviewer({ ...acceptance, source: 'independent_reviewer' }, reviewer)
    } catch (error) {
      if (error?.name === 'AbortError') throw error
      return blockedAcceptance(
        '独立 Reviewer 调用失败，已阻止任务被标记为完成',
        clean(error?.message || error, 1_000) || 'reviewer_call_failed',
        reviewerMetadata({
          independent: true,
          mode: 'reviewer_error',
          reviewerModel: configuredReviewerModel,
          workerModel,
          error: error?.message || error,
        }),
      )
    }
  }
}
