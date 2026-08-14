/**
 * 服务端工具回调循环(server-side tools loop)。
 * 让后台任务的模型像 ChatSplit 前端一样会"自主调用"工具生成 pptx/docx/xlsx/html。
 *
 * 设计:
 *   - tool spec 与前端 src/lib/tools/index.js 对齐,但 executor 在服务端跑
 *   - 直接调 server/artifactGen.js 的 createPptx/Docx/Xlsx 生成 buffer + url
 *   - 每次工具调用产物立刻 appendJobArtifact 进 jobStore(归属 job.userId)
 *   - 循环最多 maxIters 轮,防失控
 */
import { isLoopPauseResult } from '../utils/agenticTools.js'
import { getToolMetadata } from './toolRegistry.js'
import { createToolAbortScope } from '../utils/toolCancellation.js'
import { attachJobBudget, getJobBudget, createJobBudget, runWithModelBudget } from '../utils/jobBudget.js'
import { formatDeniedToolResult, requestApproval, resumePersistedApproval } from './approvalGate.js'
import { writeToolAudit } from '../utils/audit.js'
import { isContextLengthError } from '../adapters/modelProxy.js'
import { callModelWithContextRecovery } from './contextCompactionRuntime.js'
import { ensureSafetySystemMessages } from './promptCompiler.js'
import { allowedArtifactTools, isFileArtifactTool, parseSkillIdFromPrompt } from './artifactIntent.js'
import { restoreDirectoryAuthorizationToolSpecs } from './turnToolSpecs.js'
import { createSubagentApprovalContext, rememberApprovedSubagentCall } from './subagentRuntime.js'
import { buildAssistantToolCallsMessage, buildToolResultMessage, buildToolResultMessages, createToolLoopGuard, executeToolWithRetry, isSubstantiveToolCall, mapWithConcurrency, normalizeToolError, normalizeToolResult, normalizeToolCalls, resolveToolResultMaxChars, validateToolCall } from '../utils/toolCallHarness.js'
import { extractTextToolCalls } from '../utils/textToolCalls.js'
import { dispatchHooks } from './hooksService.js'
import { replaceRuntimeCapabilityBlock } from './runtimeCapabilities.js'
import { hasMutationExecutionIntent, isTextDeliverableRequest, shouldRequireExecution } from '../utils/executionIntent.js'
import { observeToolCalls, recordToolProgress, restoreToolProgress, serializeToolProgress, toolProgressPayload } from '../utils/toolProgress.js'
import { listTurnArtifacts } from './turnArtifactStore.js'

import { withLogContext } from '../utils/logger.js'
import { createRepeatCallGuard } from '../utils/repeatCallGuard.js'

const DELIVERABLE_SELECTION_GUARD_MARKER = '[FINAL DELIVERABLE SELECTION REQUIRED]'
const MAX_DELIVERABLE_SELECTION_RETRIES = 2

function normalizeArtifactIdList(ids) {
  return [...new Set((Array.isArray(ids) ? ids : [])
    .map((id) => String(id || '').trim())
    .filter(Boolean))]
}

function sameArtifactIdList(left, right) {
  const a = normalizeArtifactIdList(left)
  const b = normalizeArtifactIdList(right)
  return a.length === b.length && a.every((id) => b.includes(id))
}

import {
  COMMAND_EXECUTION_TOOL_NAMES,
  MAX_ITERS,
  JOB_READ_CONCURRENCY,
  ARTIFACT_DELIVERY_GUARD_MARKER,
  MAX_ARTIFACT_DELIVERY_RETRIES,
  EXECUTION_EVIDENCE_GUARD_MARKER,
  EXECUTION_REASONING_RECOVERY_MARKER,
  DIRECTORY_RESUME_GUARD_MARKER,
  AVAILABLE_TOOL_CAPABILITIES_MARKER,
  POST_MUTATION_VERIFICATION_GUARD_MARKER,
  PDF_LAYOUT_EXECUTION_CONTRACT_MARKER,
  PDF_LAYOUT_VERIFICATION_GUARD_MARKER,
  PDF_LAYOUT_VERIFICATION_OK,
  MAX_EXECUTION_EVIDENCE_RETRIES,
  MAX_EXECUTION_REASONING_RETRIES,
  MAX_DIRECTORY_RESUME_RETRIES,
  MAX_MUTATION_VERIFICATION_RETRIES,
  MAX_PDF_LAYOUT_VERIFICATION_RETRIES,
  VERIFIED_DIRECTORY_RESOLUTION,
  DIRECTORY_AUTHORIZATION_WAIT_CLAIM,
  EXPLICIT_LOCAL_DIRECTORY_CONTEXT,
  MANAGED_ATTACHMENT_MARKER,
  PROJECT_SCOPE_TARGET,
  VERIFICATION_TOOLS,
  SCHEDULED_WAIT_INTENT,
  FILE_WRITE_TOOL_NAMES,
  FAILURE_RECOVERY_MARKER,
  FAILURE_RECOVERY_THRESHOLD,
  EXECUTION_CONVERGENCE_MARKER,
  REPEAT_CALL_GUARD_MARKER,
  EXECUTION_CONVERGENCE_ROUND_THRESHOLD,
  MAX_INSTALL_ATTEMPT_SIGNATURES,
  toolNameFromSpec,
  isCommandExecutionTool,
  hasCommandExecutionTool,
  commandExecutionToolLabel,
  contradictedCapabilityClarification,
  isSuccessfulToolResult,
  requestedPdfSectionLabel,
  shouldRequirePdfLayoutVerification,
  buildPdfLayoutExecutionContract,
  isSuccessfulPdfLayoutVerification,
  restoreFailureRecovery,
  serializeFailureRecovery,
  installAttemptSignature,
  isProbeLikeCall,
  isExplorationOnlyCall,
  restoreExecutionConvergence,
  serializeExecutionConvergence,
  isProductiveExecutionOutcome,
  shouldReflectOnFailure,
  progressChangesFor,
  isLocalMutationCall,
  isVerificationCall,
  isMutationExecutionCall,
  normalizeMutationTarget,
  targetsMatch,
  looksLikeDeletionCommand,
  staticDeletionTargets,
  extractMutationTargets,
  clearVerifiedDeletionTargets,
  clearVerifiedMutationTargets,
  artifactDeliveryError,
  persistLocalToolArtifactsAsync,
  DIRECTORY_REVIEW_GUARD_MARKER,
  LIVE_STEERING_GUARD_MARKER,
  DIRECTORY_REVIEW_INTENT,
  buildRepresentativeReadCalls,
  successfulReadFileInMessages,
  resolveVisionFeedbackMaxBytes,
  visionFeedbackMime,
  attachVisionFeedback,
  executeServerTool,
  supportsIdempotentResume,
  SERVER_TOOL_SPECS,
  selectJobToolSpecs,
  selectToolSpecs,
  persistLocalToolArtifacts,
  buildSubagentRequest,
  buildJobToolIdempotencyKey,
  scopeTextToolCallIds,
} from './toolLoopHeuristics.js'

export {
  SERVER_TOOL_SPECS, selectJobToolSpecs, selectToolSpecs, persistLocalToolArtifacts, buildSubagentRequest, buildJobToolIdempotencyKey, scopeTextToolCallIds,
}

export async function runToolsLoop({
  job,
  step,
  messages,
  runModel,
  signal,
  maxIters = MAX_ITERS,
  executeTool = executeServerTool,
  onApprovalPending = null,
  onApprovalResolved = null,
  claimSteering = null,
  acknowledgeSteering = null,
  releaseSteering = null,
  beforeFinalCompletion = null,
  loadCheckpoint = null,
  saveCheckpoint = null,
  contextWindow = undefined,
  toolSpecs = undefined,
  fallbackToolSpecs = SERVER_TOOL_SPECS,
  skillId = undefined,
  approvalOrigin = 'job',
  approvalSessionId = null,
  approvalMode = null,
  runtimeBudget = null,
  approvalContext = null,
  requestToolApproval = requestApproval,
  enableToolHooks = true,
  onModelPhase = null,
  onModelDelta = null,
  onReasoningDelta = null,
  onProgress = null,
  onToolCall = null,
  onToolStarted = null,
  onToolCompleted = null,
  executionGuardMode = 'standard',
  intentMode = 'auto',
  toolRetryMaxAttempts = 3,
  toolRetryBaseDelayMs = 120,
}) {
  // 文件产物工具按本次任务意图裁剪。同一份 spec 既喂给模型,也用于 validateToolCall ——
  // 这样"模型看不到"和"调了也会被拒"是同一个事实,不会两边漂移。
  //
  // 意图文本取 job.prompt + 最后一条 user 消息:jobRuntime 走的是 job.prompt,
  // 但直接调 runToolsLoop(子任务、测试、未来的其他入口)只有 messages,
  // 只看 job.prompt 会把用户明写的「整理成 Word 文档」误判成无产物需求。
  // 不能扫描完整历史:旧轮次请求过 PPT 后,普通后续轮会永久携带 create_pptx
  // schema,既增加 token,也会诱导模型继续生成已经结束的产物。
  const currentUserMessage = (Array.isArray(messages) ? messages : [])
    .findLast((message) => message?.role === 'user' && typeof message.content === 'string')
  const intentText = [
    job?.prompt || '',
    currentUserMessage?.content || '',
  ].join('\n')
  const hasManagedAttachments = job?.hasManagedAttachments === true
    || (Array.isArray(job?.managedAttachments) && job.managedAttachments.length > 0)
    || MANAGED_ATTACHMENT_MARKER.test(intentText)
  const explicitSkillId = skillId
    || parseSkillIdFromPrompt(currentUserMessage?.content || '')
    || parseSkillIdFromPrompt(job?.prompt || '')
  const artifactAuthorizationText = String(
    job?.userPrompt || currentUserMessage?.content || job?.prompt || '',
  )
  const authorizedArtifactTools = allowedArtifactTools(artifactAuthorizationText, {
    skillId: explicitSkillId || skillId,
  })
  // Planning and verification consume an existing deliverable. They must not
  // manufacture another one merely because the original prompt names a format.
  const artifactDeliveryStep = !['plan', 'verify', 'finalize'].includes(String(step?.kind || ''))
  const stepArtifactTools = artifactDeliveryStep ? authorizedArtifactTools : new Set()
  const selectedToolSpecs = selectJobToolSpecs({
    prompt: intentText,
    userPrompt: artifactAuthorizationText,
    previousUserPrompt: String(job?.previousUserPrompt || ''),
    skillId: explicitSkillId || skillId,
    specs: Array.isArray(toolSpecs) ? toolSpecs : SERVER_TOOL_SPECS,
    origin: job?.origin,
    intentMode,
    userId: job?.userId || null,
  })
  const restored = typeof loadCheckpoint === 'function' ? await loadCheckpoint() : null
  const restoredState = restored?.state && typeof restored.state === 'object'
    ? restored.state
    : restored && typeof restored === 'object'
      ? restored
      : null
  const directoryAuthorizationResolution = restoredState?.directoryAuthorizationResolution
    && typeof restoredState.directoryAuthorizationResolution === 'object'
    ? restoredState.directoryAuthorizationResolution
    : null
  const skillArtifactTools = explicitSkillId
    ? allowedArtifactTools('', { skillId: explicitSkillId })
    : new Set()
  // A slash artifact skill is the delivery contract for this run. Keep the
  // completion guard on that one generator; content words such as "report"
  // must not silently add DOCX to a /webpage job. Without an artifact skill,
  // explicit multi-file requests still require every requested generator.
  const requestedArtifactTools = skillArtifactTools.size > 0
    ? skillArtifactTools
    : authorizedArtifactTools
  const selectedToolNames = new Set(selectedToolSpecs.map((spec) => spec?.function?.name).filter(Boolean))
  const expectedArtifactTools = new Set(
    [...requestedArtifactTools].filter((name) => selectedToolNames.has(name)),
  )
  // Verify/finalize/plan steps inherit the original job prompt, so they still
  // mention the requested format. Their job is to inspect or summarize the
  // artifact already produced by execute/batch_item, not manufacture a second
  // copy. Chat and delivery steps keep the strict persisted-file contract.
  const requiresPersistedArtifact = expectedArtifactTools.size > 0 && artifactDeliveryStep
  // A standalone Gugo artifact is written to the managed artifact store. It
  // never needs access to an arbitrary user folder. Hiding request_directory
  // here prevents a model from pausing /webpage or Office generation for an
  // unrelated filesystem permission. Explicit local-path delivery still keeps
  // the directory request tool available.
  let activeToolSpecs = restoreDirectoryAuthorizationToolSpecs(
    selectedToolSpecs.filter((spec) => {
      const name = spec?.function?.name
      return !isFileArtifactTool(name) || stepArtifactTools.has(name)
    }),
    directoryAuthorizationResolution,
    fallbackToolSpecs,
  )
  if (requiresPersistedArtifact && !EXPLICIT_LOCAL_DIRECTORY_CONTEXT.test(intentText)) {
    activeToolSpecs = activeToolSpecs.filter((spec) => spec?.function?.name !== 'request_directory')
  }
  if (hasManagedAttachments) {
    // Managed attachments never need a local-directory grant. Keep explicitly
    // configured connector/browser tools available, though: the user may
    // legitimately ask to compare an attachment with Drive or a web page.
    activeToolSpecs = activeToolSpecs.filter((spec) => spec?.function?.name !== 'request_directory')
  }
  // Job 的 verify/finalize 步骤会自行生成一条 user 消息，其中天然包含
  // “运行测试、修正、验证”等动作词。完成门禁必须判断用户的原始目标，
  // 不能把内核自己写出的验证提示再次识别成一项新的执行请求。
  // Chat `job.prompt` contains runtime-generated local-access instructions.
  // They mention write/create/modify even when the user's actual follow-up is
  // verification-only, so prefer the raw user prompt as intent evidence.
  const generatedWorkflowStep = ['plan', 'verify', 'finalize']
    .includes(String(step?.kind || ''))
  const executionIntentText = String(
    job?.userPrompt
      || (generatedWorkflowStep ? job?.prompt : currentUserMessage?.content)
      || job?.prompt
      || '',
  )
  // Planning explorers inspect the same user prompt as the later executor. A
  // request such as "fix the project" therefore still contains mutation
  // intent, but the explorer is deliberately read-only and should be allowed
  // to finish with findings after its reads. Keep the opt-out explicit at the
  // trusted planning call site; every other caller remains fail-closed on the
  // standard execution/evidence contract.
  const enforceExecutionIntent = executionGuardMode !== 'read_only_exploration'
  const directExecutionRequested = enforceExecutionIntent && shouldRequireExecution({
    intentMode,
    text: executionIntentText,
  })
  // ★ 纯文本交付(生成周报/写文案/做总结,没有文件路径)不写文件,
  // 文字本身就是交付物。这类请求既不算 mutation 任务,也不要求工具执行证据 ——
  // 否则纯文本任务永远以 execution_evidence_missing 收尾。
  const textDeliverableOnly = isTextDeliverableRequest(executionIntentText)
  const mutationExecutionRequested = !textDeliverableOnly && (
    requiresPersistedArtifact
    || (directExecutionRequested && hasMutationExecutionIntent(executionIntentText)))
  const executionConvergenceEnabled = enforceExecutionIntent && mutationExecutionRequested
  let requiresPdfLayoutVerification = mutationExecutionRequested
    && shouldRequirePdfLayoutVerification(executionIntentText)
    && hasCommandExecutionTool(activeToolSpecs)
  // Explicit execution is a contract, not a hint. Keep this requirement even
  // when routing produced no usable tool; otherwise prose such as "done" would
  // be accepted precisely when the harness cannot perform the requested work.
  const requiresExecutionEvidence = directExecutionRequested && !textDeliverableOnly
  let availableVerificationToolNames = activeToolSpecs
    .map(toolNameFromSpec)
    .filter((name) => VERIFICATION_TOOLS.has(name) || isCommandExecutionTool(name))
  const representativeReadCalls = buildRepresentativeReadCalls(job?.prompt, job?.id)
  const requiresRepresentativeRead = job?.origin === 'chat'
    && DIRECTORY_REVIEW_INTENT.test(String(job?.userPrompt || ''))
    && activeToolSpecs.some((spec) => spec?.function?.name === 'read_file')
    && representativeReadCalls.length > 0
  const recoverySessionId = job?.origin === 'chat' && job?.sessionId
    ? String(job.sessionId)
    : job?.id && step?.id
      ? `job:${job.id}:${step.id}`
      : null
  // Automatic tool rounds must never wait for extra map/reduce model calls
  // merely to prepare their next request. Explicit compaction can still request
  // a semantic summary; automatic recovery uses the deterministic archive.
  const semanticSummary = false
  let convo = ensureSafetySystemMessages(
    Array.isArray(restoredState?.messages) ? [...restoredState.messages] : [...messages],
  )
  convo = replaceRuntimeCapabilityBlock(convo, {
    toolSpecs: activeToolSpecs,
    approvalMode,
  })
  const hasRuntimeMarker = (marker) => convo.some((message) => (
    message?.role === 'system' && String(message?.content || '').includes(marker)
  ))
  let representativeReadsInjected = Boolean(restoredState?.completionGuards?.representativeReadsInjected)
    || convo.some((message) => message?.role === 'system' && String(message?.content || '').includes(DIRECTORY_REVIEW_GUARD_MARKER))
  let hasSuccessfulRepresentativeRead = successfulReadFileInMessages(convo)
  const artifactIds = normalizeArtifactIdList(restoredState?.artifactIds)
  let deliveryArtifactSelectionExplicit = Object.hasOwn(restoredState || {}, 'deliveryArtifactIds')
  let deliveryArtifactIds = deliveryArtifactSelectionExplicit
    ? normalizeArtifactIdList(restoredState.deliveryArtifactIds)
    : []
  const restoredSelectionArtifactIds = restoredState?.completionGuards?.deliveryArtifactSelectionArtifactIds
  let deliveryArtifactSelectionArtifactIds = deliveryArtifactSelectionExplicit
    ? normalizeArtifactIdList(Array.isArray(restoredSelectionArtifactIds)
        ? restoredSelectionArtifactIds
        : artifactIds)
    : []
  if (deliveryArtifactSelectionExplicit
    && Array.isArray(restoredSelectionArtifactIds)
    && !sameArtifactIdList(deliveryArtifactSelectionArtifactIds, artifactIds)) {
    deliveryArtifactSelectionExplicit = false
    deliveryArtifactIds = []
    deliveryArtifactSelectionArtifactIds = []
  }
  let deliverableSelectionRetries = Math.max(
    0,
    Number(restoredState?.completionGuards?.deliverableSelectionRetries) || 0,
  )
  const hasCurrentDeliverableSelection = () => deliveryArtifactSelectionExplicit
    && sameArtifactIdList(deliveryArtifactSelectionArtifactIds, artifactIds)
  const deliverySelectionFields = () => {
    if (hasCurrentDeliverableSelection()) {
      return { deliveryArtifactIds: [...deliveryArtifactIds] }
    }
    // Once a chat turn has artifacts, an absent field is ambiguous to older
    // checkpoint consumers and can revive a stale selection after a crash.
    // Persist an explicit empty delivery while selection is pending/invalid;
    // completionGuards still distinguishes that state from an intentional
    // set_deliverables({ artifact_ids: [] }) selection on resume.
    if (job?.origin === 'chat' && artifactIds.length > 0) {
      return { deliveryArtifactIds: [] }
    }
    return {}
  }
  const invalidateDeliverableSelection = () => {
    deliveryArtifactSelectionExplicit = false
    deliveryArtifactIds = []
    deliveryArtifactSelectionArtifactIds = []
    deliverableSelectionRetries = 0
  }
  const recordArtifactIds = (ids) => {
    let added = false
    for (const id of normalizeArtifactIdList(ids)) {
      if (artifactIds.includes(id)) continue
      artifactIds.push(id)
      added = true
    }
    if (added && deliveryArtifactSelectionExplicit) invalidateDeliverableSelection()
    return added
  }
  const needsDeliverableSelection = () => job?.origin === 'chat'
    && artifactIds.length > 0
    && !hasCurrentDeliverableSelection()
  const suppressUnselectedArtifacts = () => {
    if (!needsDeliverableSelection()) return
    deliveryArtifactIds = []
    deliveryArtifactSelectionArtifactIds = [...artifactIds]
    deliveryArtifactSelectionExplicit = true
  }
  const selectDeliverables = (args = {}) => {
    if (job?.origin !== 'chat' || !job?.userId || !job?.sessionId || !job?.id) {
      return {
        ok: false,
        code: 'deliverable_scope_unavailable',
        error: 'Final deliverables can only be selected for a persisted chat turn.',
        retryable: false,
      }
    }
    const requested = args.artifact_ids
    if (!Array.isArray(requested)
      || requested.some((id) => typeof id !== 'string' || !id || id.trim() !== id)
      || new Set(requested).size !== requested.length) {
      return {
        ok: false,
        code: 'invalid_deliverable_artifact_ids',
        error: 'artifact_ids must contain unique, non-empty artifact ID strings without surrounding whitespace.',
        retryable: false,
      }
    }
    const ownedIds = new Set(listTurnArtifacts({
      userId: job.userId,
      sessionId: job.sessionId,
      turnId: job.id,
    }).map((artifact) => artifact.id))
    const invalidArtifactIds = requested.filter((id) => !ownedIds.has(id))
    if (invalidArtifactIds.length > 0) {
      return {
        ok: false,
        code: 'deliverable_artifact_scope_mismatch',
        error: 'Every deliverable artifact ID must belong to the current user, session, and turn.',
        invalidArtifactIds,
        retryable: false,
      }
    }
    deliveryArtifactIds = [...requested]
    deliveryArtifactSelectionArtifactIds = [...artifactIds]
    deliveryArtifactSelectionExplicit = true
    deliverableSelectionRetries = 0
    return {
      ok: true,
      deliveryArtifactIds: [...deliveryArtifactIds],
      selected: deliveryArtifactIds.length,
      replaced: true,
    }
  }
  let artifactDeliveryRetries = Math.max(0, Number(restoredState?.completionGuards?.artifactDeliveryRetries) || 0)
  const deliveredArtifactTools = new Set(
    Array.isArray(restoredState?.completionGuards?.deliveredArtifactTools)
      ? restoredState.completionGuards.deliveredArtifactTools.filter((name) => expectedArtifactTools.has(name))
      : [],
  )
  const inheritedArtifactEvidence = ['verify', 'finalize'].includes(String(step?.kind || ''))
    && Array.isArray(job?.steps)
    && job.steps.some((priorStep) => (
      priorStep?.id !== step?.id
      && priorStep?.status === 'completed'
      && Array.isArray(priorStep?.output?.artifactIds)
      && priorStep.output.artifactIds.length > 0
    ))
  let executionEvidenceObserved = Boolean(restoredState?.completionGuards?.executionEvidenceObserved)
    || deliveredArtifactTools.size > 0
    || inheritedArtifactEvidence
  let mutationExecutionObserved = Boolean(restoredState?.completionGuards?.mutationExecutionObserved)
    || deliveredArtifactTools.size > 0
    || inheritedArtifactEvidence
  let executionEvidenceRetries = Math.max(
    0,
    Number(restoredState?.completionGuards?.executionEvidenceRetries) || 0,
  )
  let executionReasoningRetries = Math.max(
    0,
    Number(restoredState?.completionGuards?.executionReasoningRetries) || 0,
  )
  let directoryResumeRetries = Math.max(
    0,
    Number(restoredState?.completionGuards?.directoryResumeRetries) || 0,
  )
  const hasVerifiedDirectoryResolution = directoryAuthorizationResolution?.type === 'directory_authorization'
    && directoryAuthorizationResolution?.approved === true
    || convo.some((message) => (
      message?.role === 'system'
        && VERIFIED_DIRECTORY_RESOLUTION.test(String(message?.content || ''))
    ))
  const restoredMutationTargets = Array.isArray(restoredState?.completionGuards?.pendingMutationTargets)
    ? restoredState.completionGuards.pendingMutationTargets
    : restoredState?.completionGuards?.pendingMutationVerification
      ? [PROJECT_SCOPE_TARGET]
      : []
  const pendingMutationTargets = new Set(
    restoredMutationTargets.map(normalizeMutationTarget).filter(Boolean),
  )
  const pendingDeletionTargets = new Set(
    (Array.isArray(restoredState?.completionGuards?.pendingDeletionTargets)
      ? restoredState.completionGuards.pendingDeletionTargets
      : [])
      .map(normalizeMutationTarget)
      .filter(Boolean),
  )
  const hasPendingMutationVerification = () => (
    pendingMutationTargets.size > 0 || pendingDeletionTargets.size > 0
  )
  let mutationVerificationRetries = Math.max(
    0,
    Number(restoredState?.completionGuards?.mutationVerificationRetries) || 0,
  )
  let pdfLayoutVerificationObserved = Boolean(
    restoredState?.completionGuards?.pdfLayoutVerificationObserved,
  )
  let pdfLayoutVerificationRetries = Math.max(
    0,
    Number(restoredState?.completionGuards?.pdfLayoutVerificationRetries) || 0,
  )
  let executionConvergence = restoreExecutionConvergence(
    restoredState?.completionGuards?.executionConvergence,
  )
  if (hasManagedAttachments && !hasRuntimeMarker('[MANAGED ATTACHMENT EXECUTION CONTRACT]')) {
    const attachmentUris = (Array.isArray(job?.managedAttachments) ? job.managedAttachments : [])
      .map((item) => String(item?.uri || '').trim())
      .filter(Boolean)
      .slice(0, 16)
    convo.push({
      role: 'system',
      content: [
        '[MANAGED ATTACHMENT EXECUTION CONTRACT]',
        'The attached files are already uploaded into Gugo-managed storage and require no directory permission or cloud connector.',
        attachmentUris.length ? `Use read_file with these exact URIs when file contents are needed: ${attachmentUris.join(', ')}.` : 'Use the attachment:// URI shown in the user message with read_file when file contents are needed.',
        'Do not search Dropbox, Google Drive, OneDrive, or browser apps to locate these files. Prefer the supplied extracted PDF/text content when it is already present.',
      ].join(' '),
    })
  }
  if ((directExecutionRequested || requiresPersistedArtifact)
    && !hasRuntimeMarker(AVAILABLE_TOOL_CAPABILITIES_MARKER)) {
    const activeToolNames = activeToolSpecs.map(toolNameFromSpec).filter(Boolean)
    const activeCommandToolNames = activeToolNames.filter((name) => isCommandExecutionTool(name))
    const activeCommandToolLabel = activeCommandToolNames.join('/')
    const capabilityNotes = []
    if (activeCommandToolNames.length > 0) {
      capabilityNotes.push(`${activeCommandToolLabel} can run commands and installed Python/Node scripts in an authorized workspace or local directory`)
    }
    if (process.platform === 'win32'
      && activeCommandToolNames.length > 0
      && activeToolNames.includes('write_file')) {
      capabilityNotes.push(`on Windows, ${activeCommandToolLabel} uses cmd.exe; for multiline or long Python such as PDF/image generation, write a UTF-8 .py file with write_file and then run that file instead of embedding the program in python -c, and do not use Unix-only tail/grep/sed/awk pipelines`)
    }
    const writableTools = activeToolNames.filter((name) => FILE_WRITE_TOOL_NAMES.has(name))
    if (writableTools.length > 0) {
      capabilityNotes.push(`${writableTools.join('/')} can create or modify authorized files`)
    }
    const artifactTools = activeToolNames.filter((name) => isFileArtifactTool(name))
    if (artifactTools.length > 0) {
      capabilityNotes.push(`${artifactTools.join('/')} can create persisted downloadable artifacts`)
    }
    convo.push({
      role: 'system',
      content: [
        AVAILABLE_TOOL_CAPABILITIES_MARKER,
        `The callable tools for this turn are: ${activeToolNames.join(', ') || '(none)'}.`,
        capabilityNotes.length > 0 ? `${capabilityNotes.join('; ')}.` : '',
        'Treat this runtime-provided list as authoritative. A malformed argument or one failed tool call does not mean that the tool is unavailable.',
        'Do not call request_clarification merely to claim that a listed capability is missing; correct the arguments or use another listed tool and continue.',
      ].filter(Boolean).join(' '),
    })
  }
  if ((directExecutionRequested || requiresPersistedArtifact)
    && !hasRuntimeMarker('[DIRECT EXECUTION REQUIRED]')) {
    convo.push({
      role: 'system',
      content: [
        '[DIRECT EXECUTION REQUIRED]',
        'The user asked for concrete work, not instructions for doing it later.',
        'Use the available tools now, follow the supplied steps, create or modify the requested deliverable, and verify the result before answering.',
        'Do not merely print a script or tell the user to run commands unless execution is genuinely blocked by a missing permission or indispensable user input.',
        'Keep internal deliberation brief; report the completed result or one concise, specific blocker.',
      ].join(' '),
    })
  }
  if (requiresPdfLayoutVerification
    && !hasRuntimeMarker(PDF_LAYOUT_EXECUTION_CONTRACT_MARKER)) {
    convo.push({
      role: 'system',
      content: buildPdfLayoutExecutionContract(executionIntentText),
    })
  }
  const missingArtifactTools = () => [...expectedArtifactTools].filter((name) => !deliveredArtifactTools.has(name))
  const hasRequiredArtifacts = () => !requiresPersistedArtifact || missingArtifactTools().length === 0
  const hasRequiredExecutionEvidence = () => !requiresExecutionEvidence
    || (mutationExecutionRequested ? mutationExecutionObserved : executionEvidenceObserved)
  const assertRequiredArtifacts = () => {
    if (!requiresPersistedArtifact) return
    const missing = missingArtifactTools()
    if (missing.length > 0) throw artifactDeliveryError(missing)
  }
  let recovery = restoredState?.recovery?.archiveId
    ? { archiveId: String(restoredState.recovery.archiveId) }
    : null
  const appliedSteeringIds = new Set(
    Array.isArray(restoredState?.appliedSteeringIds)
      ? restoredState.appliedSteeringIds.map((id) => String(id || '').trim()).filter(Boolean)
      : [],
  )
  let finalText = ''
  let finalCheckpointPersisted = false
  let iter = Math.max(0, Number(restoredState?.iterations) || 0)
  // `iterations` is cumulative so resumed tool-call ids and idempotency keys
  // stay stable. An explicit retry records a new window start in the durable
  // checkpoint, giving that retry a fresh maxIters allowance without replaying
  // completed calls. Ordinary process/approval resumes keep the old window.
  const iterationWindowStart = Math.min(
    iter,
    Math.max(0, Number(restoredState?.iterationWindowStart) || 0),
  )
  const iterationWindowSize = Math.max(1, Math.floor(Number(maxIters) || MAX_ITERS))
  maxIters = iterationWindowStart + iterationWindowSize
  let modelBudgetExceededAfterResponse = null
  let checkpointCalls = Array.isArray(restoredState?.toolCalls)
    ? restoredState.toolCalls.map((call) => ({
        ...call,
        idempotencyKey: call.idempotencyKey || buildJobToolIdempotencyKey({
          jobId: job?.id,
          stepId: step?.id,
          toolCallId: call.id,
        }),
      }))
    : null
  const progressState = restoreToolProgress(restoredState?.progress)
  observeToolCalls(progressState, checkpointCalls)
  for (const call of checkpointCalls || []) {
    if (call?.checkpointStatus !== 'completed') continue
    const result = normalizeToolResult(call.checkpointResult)
    const progressChanges = progressChangesFor(call, result)
    recordToolProgress(progressState, {
      call,
      succeeded: isSuccessfulToolResult(result),
      ...progressChanges,
    })
  }
  let failureRecovery = restoreFailureRecovery(restoredState?.failureRecovery)
  let pendingFailureRecoveryPrompt = failureRecovery.count >= FAILURE_RECOVERY_THRESHOLD
    && !failureRecovery.reflected
  const repeatCallGuard = createRepeatCallGuard()
  let pendingRepeatCallReminder = null

  const emitToolProgress = async (phase, iteration = iter + 1) => {
    if (typeof onProgress !== 'function') return
    await onProgress(toolProgressPayload(progressState, { iteration, phase }))
  }

  // An interrupted final is durable UI evidence, not a completed model turn.
  // Explicit resume must continue from the checkpointed tool results instead
  // of replaying the interruption text as if it were the final answer.
  const restoredFinalIsInterrupted = restoredState?.final?.interrupted === true
  const restoredFinalIsTerminal = Boolean(
    restoredState?.final?.incomplete
    || restoredState?.final?.paused
    || restoredState?.final?.budgetExceeded
    || restoredState?.final?.noProgress,
  )
  if (restoredState?.final?.text != null
    && String(restoredState.final.text).trim()
    && !restoredFinalIsInterrupted
    && (restoredFinalIsTerminal || (
       hasRequiredArtifacts()
       && hasRequiredExecutionEvidence()
       && !hasPendingMutationVerification()
       && (!requiresPdfLayoutVerification || pdfLayoutVerificationObserved)
    ))) {
    return {
      ...restoredState.final,
      text: String(restoredState.final.text),
      artifactIds,
      ...deliverySelectionFields(),
      iterations: Math.max(1, Number(restoredState.final.iterations) || iter || 1),
      resumed: true,
      recovery,
    }
  }

  let injectRepresentativeReadsBeforeModel = requiresRepresentativeRead
    && !hasSuccessfulRepresentativeRead
    && !representativeReadsInjected
    && !checkpointCalls?.length

  const persistTurn = async ({ final = null } = {}) => {
    if (typeof saveCheckpoint !== 'function') return
    const saved = await saveCheckpoint({
      messages: convo,
      toolCalls: checkpointCalls || [],
      artifactIds,
      ...deliverySelectionFields(),
      appliedSteeringIds: [...appliedSteeringIds],
      iterations: iter,
      iterationWindowStart,
      budget: budget.snapshot?.() || null,
      recovery,
      progress: serializeToolProgress(progressState),
      failureRecovery: serializeFailureRecovery(failureRecovery),
      loopGuard: loopGuard.snapshot(),
      ...(directoryAuthorizationResolution ? { directoryAuthorizationResolution } : {}),
      completionGuards: {
        representativeReadsInjected,
        artifactDeliveryRetries,
        deliveredArtifactTools: [...deliveredArtifactTools],
        deliverableSelectionRetries,
        deliveryArtifactSelectionArtifactIds: [...deliveryArtifactSelectionArtifactIds],
        executionEvidenceObserved,
        mutationExecutionObserved,
        executionEvidenceRetries,
        executionReasoningRetries,
        directoryResumeRetries,
        pendingMutationVerification: hasPendingMutationVerification(),
        pendingMutationTargets: [...pendingMutationTargets],
        pendingDeletionTargets: [...pendingDeletionTargets],
        mutationVerificationRetries,
        pdfLayoutVerificationObserved,
        pdfLayoutVerificationRetries,
        executionConvergence: serializeExecutionConvergence(executionConvergence),
      },
      final,
    })
    if (saved === false || saved === null) throw new Error('Failed to persist job turn checkpoint')
  }
  const freshSteeringMessages = (messages = []) => {
    const seen = new Set(appliedSteeringIds)
    return (Array.isArray(messages) ? messages : []).filter((steering) => {
      const id = String(steering?.id || '').trim()
      if (id && seen.has(id)) return false
      if (id) seen.add(id)
      return true
    })
  }
  const appendSteeringMessages = (messages = []) => {
    if (!messages.length) return 0
    // 用户干预改变了上下文,跨干预的重复调用不算死循环。
    repeatCallGuard.reset()
    pendingRepeatCallReminder = null
    if (!hasRuntimeMarker(LIVE_STEERING_GUARD_MARKER)) {
      convo.push({
        role: 'system',
        content: `${LIVE_STEERING_GUARD_MARKER} The user sent steering updates while this task was running. Apply them now; newer user direction takes precedence.`,
      })
    }
    for (const steering of messages) {
      // Preserve the user text verbatim. Do not summarize steering before the model sees it.
      const id = String(steering?.id || '').trim()
      if (id) appliedSteeringIds.add(id)
      convo.push({ role: 'user', content: steering.content })
    }
    return messages.length
  }
  const persistAndAcknowledgeSteering = async (leaseId) => {
    try {
      // The checkpoint is durable proof that every claimed steering id was
      // applied. Never ACK the lease before that proof exists.
      await persistTurn()
      if (leaseId && typeof acknowledgeSteering === 'function') {
        await acknowledgeSteering(leaseId)
      }
    } catch (error) {
      if (leaseId && typeof releaseSteering === 'function') {
        await releaseSteering(leaseId)
      }
      throw error
    }
  }
  const completionGateAllowsFinish = async (details) => {
    if (typeof beforeFinalCompletion !== 'function') return true
    const result = await beforeFinalCompletion(details)
    return typeof result === 'boolean' ? result : result?.closed !== false
  }
  const prepareCompletionForSteering = async ({
    text = '',
    steeringLeaseId = null,
    incomplete = false,
    reason = null,
  } = {}) => {
    if (typeof beforeFinalCompletion !== 'function') {
      return { closed: true, prepared: false }
    }
    try {
      if (steeringLeaseId) {
        if (text) convo.push({ role: 'assistant', content: text })
        // The checkpoint is the durable proof that every claimed steering id
        // was applied to this candidate result. ACK only after that proof
        // exists; then atomically close the inbox.
        await persistTurn()
        if (typeof acknowledgeSteering === 'function') {
          await acknowledgeSteering(steeringLeaseId)
        }
      }
      const closed = await completionGateAllowsFinish({ text, incomplete, reason })
      if (!closed) {
        // With no claimed lease there is nothing to ACK, so avoid an extra
        // checkpoint on the overwhelmingly common uncontended completion.
        // Persist the discarded candidate only when a racing update actually
        // kept the inbox open; the next model round can then see that context.
        if (!steeringLeaseId) {
          if (text) convo.push({ role: 'assistant', content: text })
          await persistTurn()
        }
        if (iter + 1 >= maxIters) maxIters = iter + 2
      }
      return { closed, prepared: Boolean(steeringLeaseId) || !closed }
    } catch (error) {
      if (steeringLeaseId && typeof releaseSteering === 'function') {
        await releaseSteering(steeringLeaseId)
      }
      throw error
    }
  }
  const finishIncomplete = async ({ text, reason, steeringLeaseId = null }) => {
    finalText = text
    const completion = await prepareCompletionForSteering({
      text: finalText,
      steeringLeaseId,
      incomplete: true,
      reason,
    })
    if (!completion.closed) return { deferredForSteering: true }
    suppressUnselectedArtifacts()
    if (!completion.prepared) convo.push({ role: 'assistant', content: finalText })
    try {
      await persistTurn({
        final: {
          text: finalText,
          iterations: iter + 1,
          incomplete: true,
          reason,
        },
      })
      finalCheckpointPersisted = true
      if (!completion.prepared && steeringLeaseId && typeof acknowledgeSteering === 'function') {
        await acknowledgeSteering(steeringLeaseId)
      }
    } catch (error) {
      if (steeringLeaseId && typeof releaseSteering === 'function') {
        await releaseSteering(steeringLeaseId)
      }
      throw error
    }
    return {
      text: finalText,
      artifactIds,
      ...deliverySelectionFields(),
      iterations: iter + 1,
      incomplete: true,
      reason,
      recovery,
    }
  }
  const finishTerminalResult = async (result, {
    steeringLeaseId = null,
    finalMetadata = {},
    appendTextToConversation = true,
  } = {}) => {
    const text = String(result?.text || '')
    const completion = await prepareCompletionForSteering({
      text,
      steeringLeaseId,
      incomplete: result?.incomplete === true,
      reason: result?.reason || null,
    })
    if (!completion.closed) return null
    if (result?.incomplete === true || result?.paused === true || result?.interrupted === true) {
      suppressUnselectedArtifacts()
    }
    if (!completion.prepared && text && appendTextToConversation) {
      convo.push({ role: 'assistant', content: text })
    }
    await persistTurn({
      final: {
        text,
        iterations: Math.max(1, Number(result?.iterations) || iter + 1),
        incomplete: result?.incomplete === true,
        reason: result?.reason || null,
        ...finalMetadata,
      },
    })
    finalCheckpointPersisted = Boolean(text.trim())
    return { ...result, ...deliverySelectionFields() }
  }
  // ★ M3.5 + Lens-2 fix:任务级预算用 WeakMap 持有,模型/工具碰不到 job 的属性也无法绕过。
  const restoredBudget = restoredState?.budget && typeof restoredState.budget === 'object'
    ? {
        maxTotalCalls: restoredState.budget.maxTotalCalls,
        maxWallMs: restoredState.budget.maxWallMs,
        maxModelCalls: restoredState.budget.maxModelCalls,
        maxModelTokens: restoredState.budget.maxModelTokens,
        maxCostUsd: restoredState.budget.maxCostUsd,
        initialUsed: restoredState.budget.used,
        initialElapsedMs: restoredState.budget.elapsed,
        initialModelMs: restoredState.budget.modelMs,
        initialModelCalls: restoredState.budget.modelCalls,
        initialModelTokens: restoredState.budget.modelTokens,
        initialCostUsd: restoredState.budget.costUsd,
      }
    : undefined
  const budget = runtimeBudget || (job
    ? (getJobBudget(job) || attachJobBudget(job, restoredBudget))
    : createJobBudget(restoredBudget))
  const subagentApprovalContext = approvalContext || createSubagentApprovalContext()
  // Exact duplicate signatures keep their separate fuse. Calls that change
  // arguments get graded strategy advisories and a much higher recovery budget.
  const loopGuard = createToolLoopGuard({
    maxRepeatedCalls: 2,
    maxConsecutiveErrors: 20,
    maxSameToolFailures: 20,
    initialState: restoredState?.loopGuard,
  })
  const rememberInstallAttempt = (signature) => {
    if (!signature) return
    executionConvergence.installAttempts = executionConvergence.installAttempts
      .filter((item) => item !== signature)
    executionConvergence.installAttempts.push(signature)
    executionConvergence.installAttempts = executionConvergence.installAttempts
      .slice(-MAX_INSTALL_ATTEMPT_SIGNATURES)
  }
  const convergenceBlockFor = (call) => {
    if (!executionConvergenceEnabled || !executionConvergence.interventionActive) return null
    if (isProbeLikeCall(call)) {
      return {
        ok: false,
        code: 'execution_convergence_probe_blocked',
        error: 'The call was blocked because this execution task already spent several rounds on environment or inspection probes without producing the requested output.',
        retryable: false,
        blockedKind: 'probe',
        hint: 'Stop creating or running inspection scripts. Execute the requested mutation or artifact generation now, then verify its actual output.',
      }
    }
    const installSignature = installAttemptSignature(call)
    if (installSignature && executionConvergence.installAttempts.includes(installSignature)) {
      return {
        ok: false,
        code: 'execution_convergence_install_blocked',
        error: `The repeated dependency installation (${installSignature}) was blocked after the task failed to converge.`,
        retryable: false,
        blockedKind: 'repeated_install',
        hint: 'Use the dependency state already observed and execute the requested output-producing command. Only report a blocker when a concrete execution error proves the dependency is unusable.',
      }
    }
    return null
  }

  for (; iter < maxIters; iter += 1) {
    if (signal?.aborted) {
      const error = new Error('Turn cancelled')
      error.name = 'AbortError'
      throw error
    }
    let steeringLeaseId = null
    let toolCalls
    let modelMutationBatchScheduled = false

    if (injectRepresentativeReadsBeforeModel) {
      representativeReadsInjected = true
      injectRepresentativeReadsBeforeModel = false
      convo.push({
        role: 'system',
        content: [
          DIRECTORY_REVIEW_GUARD_MARKER,
          'A directory listing is discovery evidence only.',
          'The runtime is reading representative documentation, configuration, and entrypoint files through the authorized read_file tool before the first model call.',
          'Base the answer on the returned file contents and report any concrete read errors truthfully.',
        ].join(' '),
      })
      checkpointCalls = normalizeToolCalls(representativeReadCalls, {
        toolSpecs: activeToolSpecs,
      }).map((call) => ({
        ...call,
        idempotencyKey: buildJobToolIdempotencyKey({
          jobId: job?.id,
          stepId: step?.id,
          toolCallId: call.id,
        }),
        checkpointStatus: 'pending',
        checkpointApprovalId: null,
      }))
      observeToolCalls(progressState, checkpointCalls)
      if (typeof onToolCall === 'function') {
        for (const call of checkpointCalls) await onToolCall(call)
      }
      await emitToolProgress('tools_scheduled')
      convo.push(buildAssistantToolCallsMessage(checkpointCalls, ''))
      await persistTurn()
    }

    if (checkpointCalls?.length) {
      // The model response was already made durable before the previous process
      // stopped. Resume its unanswered calls without asking the model again.
      toolCalls = checkpointCalls
    } else {
      if (typeof claimSteering === 'function') {
        const claimed = await claimSteering()
        if (claimed?.messages?.length) {
          const freshMessages = freshSteeringMessages(claimed.messages)
          if (freshMessages.length > 0) {
            steeringLeaseId = claimed.leaseId
            appendSteeringMessages(freshMessages)
          } else if (claimed.leaseId) {
            // A prior checkpoint may already contain these ids while its ACK
            // was lost. Re-affirm the durable state, consume the recovered
            // lease, and never inject the same steering text twice.
            await persistAndAcknowledgeSteering(claimed.leaseId)
          }
        }
      }

      let modelResult
      try {
        if (typeof onModelPhase === 'function') await onModelPhase({ phase: 'started', iteration: iter })
        let streamedText = false
        const request = await callModelWithContextRecovery({
          messages: convo,
          tools: activeToolSpecs,
          callModel: (modelRequest) => runWithModelBudget(
            budget,
            () => runModel(modelRequest),
          ),
          isContextLengthError,
          contextWindow,
          semanticSummary,
          signal,
          userId: job?.userId || null,
          sessionId: recoverySessionId,
          consumeBudget: (cost) => budget.consume(cost),
          onTextDelta: async (text, metadata = {}) => {
            if (!text) return
            // Do not leak a model's "copy this code into a file" fallback into
            // the chat while a real file artifact is still required. The final
            // narration streams normally after the generator succeeds.
            if (!hasRequiredArtifacts()) return
            streamedText = true
            if (typeof onModelDelta === 'function') {
              await onModelDelta({ text, iteration: iter, modelName: metadata.modelName || null })
            }
          },
          onReasoningDelta: async (text, metadata = {}) => {
            if (!text || typeof onReasoningDelta !== 'function') return
            await onReasoningDelta({ text, iteration: iter, modelName: metadata.modelName || null })
          },
        })
        convo.splice(0, convo.length, ...request.messages)
        if (request.recovery?.archiveId) {
          recovery = { archiveId: String(request.recovery.archiveId) }
        }
        modelResult = request.response
        if (!Array.isArray(modelResult?.toolCalls) || modelResult.toolCalls.length === 0) {
          const compatibilityCall = extractTextToolCalls(modelResult?.content)
          if (compatibilityCall.detected) {
            modelResult = {
              ...modelResult,
              content: compatibilityCall.content,
              toolCalls: compatibilityCall.toolCalls,
            }
          }
        }
        const returnedToolCalls = Array.isArray(modelResult?.toolCalls) ? modelResult.toolCalls : []
        if (requiresRepresentativeRead
          && !hasSuccessfulRepresentativeRead
          && !representativeReadsInjected
          && returnedToolCalls.length === 0
          && iter + 1 < maxIters) {
          representativeReadsInjected = true
          convo.push({
            role: 'system',
            content: [
              DIRECTORY_REVIEW_GUARD_MARKER,
              'The previous answer tried to finish from a directory listing alone, so it was discarded.',
              'The runtime is now reading representative documentation, configuration, and entrypoint files through the authorized read_file tool.',
              'Base the next answer on the returned file contents and report any concrete read errors truthfully.',
            ].join(' '),
          })
          modelResult = { ...modelResult, content: '', toolCalls: representativeReadCalls }
        }
        if (typeof onModelPhase === 'function') await onModelPhase({
          phase: 'completed',
          iteration: iter,
          content: modelResult?.content || '',
          toolCalls: modelResult?.toolCalls || [],
          usage: modelResult?.usage || null,
          modelName: modelResult?.modelName || null,
        })
        if (!streamedText
          && modelResult?.content
          && hasRequiredArtifacts()
          && typeof onModelDelta === 'function') {
          await onModelDelta({
            text: modelResult.content,
            iteration: iter,
            modelName: modelResult?.modelName || null,
          })
        }
      } catch (error) {
        let recoverableModelResult = error?.partialModelResult
        if (recoverableModelResult
          && (!Array.isArray(recoverableModelResult.toolCalls) || recoverableModelResult.toolCalls.length === 0)) {
          const compatibilityCall = extractTextToolCalls(recoverableModelResult.content)
          if (compatibilityCall.detected) {
            recoverableModelResult = {
              ...recoverableModelResult,
              content: compatibilityCall.content,
              toolCalls: compatibilityCall.toolCalls,
            }
          }
        }
        const recoverableToolCalls = Array.isArray(recoverableModelResult?.toolCalls)
          ? recoverableModelResult.toolCalls
          : []
        const canRecoverExecutionReasoning = error?.code === 'REASONING_RUNAWAY'
          && directExecutionRequested
          && activeToolSpecs.length > 0
          && executionReasoningRetries < MAX_EXECUTION_REASONING_RETRIES
          && iter + 1 < maxIters
        if (canRecoverExecutionReasoning) {
          executionReasoningRetries += 1
          convo.push({
            role: 'system',
            content: [
              EXECUTION_REASONING_RECOVERY_MARKER,
              'The previous response spent too long reasoning without submitting a tool call and was cancelled.',
              'Do not recompute the plan, layout, or environment and do not narrate another intention to act.',
              `Begin the next response with one substantive available tool call. Preferred execution tools: ${activeToolSpecs.map(toolNameFromSpec).filter(Boolean).join(', ')}.`,
              'Keep private reasoning brief, execute the requested mutation now, and verify concrete output afterward.',
            ].join(' '),
          })
          if (typeof onModelPhase === 'function') await onModelPhase({
            phase: 'retrying',
            iteration: iter,
            error: error?.message || String(error),
            reason: 'reasoning_runaway',
          })
          await persistTurn()
          if (steeringLeaseId && typeof acknowledgeSteering === 'function') {
            await acknowledgeSteering(steeringLeaseId)
          }
          continue
        }
        if (error?.code === 'MODEL_BUDGET_EXCEEDED' && recoverableToolCalls.length > 0) {
          // The provider request and its cost have already happened. Discarding
          // an actionable tool call here wastes that work and can stop one step
          // before the requested artifact is produced. Execute this final
          // response; the exhausted budget will still reject the next model
          // request before it reaches the provider.
          modelResult = recoverableModelResult
          modelBudgetExceededAfterResponse = error?.message || 'model budget exceeded'
          if (typeof onModelPhase === 'function') await onModelPhase({
            phase: 'completed',
            iteration: iter,
            content: modelResult?.content || '',
            toolCalls: modelResult?.toolCalls || [],
            usage: modelResult?.usage || null,
            modelName: modelResult?.modelName || null,
            budgetExceeded: true,
            budgetReason: error?.message || String(error),
          })
        } else {
          if (typeof onModelPhase === 'function') await onModelPhase({
            phase: 'failed', iteration: iter, error: error?.message || String(error),
          })
        // ★ 模型报错不再无条件炸掉整个 step。
        //
        // 原来这里直接 throw,一路冒到 runOneTick 把 job 标 failed,
        // **这一步已经收集到的所有工具结果全部丢弃**,checkpoint 也被删掉。
        // 于是 LM Studio 在第 30 轮打了个嗝,前 29 轮的活白干。
        //
        // subagentRuntime.js 早就做对了(见那里的降级注释),job 循环一直没跟上。
        // 现在对齐:已经跑过至少一轮 + 不是用户主动取消 → 降级成部分结果,
        // 把中断原因和已查到的东西交给用户,而不是一个空的 failed。
        if (error?.code === 'MODEL_BUDGET_EXCEEDED') {
          const collected = convo
            .filter((m) => m.role === 'tool')
            .map((m) => (typeof m.content === 'string' ? m.content : ''))
            .filter(Boolean)
            .join('\n')
            .slice(0, 4000)
          let wrapUpText = ''
          try {
            const wrapUpRequest = await callModelWithContextRecovery({
              messages: [
                ...convo,
                {
                  role: 'system',
                  content: `模型预算已用尽(${error.message})。请基于目前已有的信息给出最终回答，不要再调用任何工具。`,
                },
              ],
              tools: [],
              callModel: (modelRequest) => runWithModelBudget(
                budget,
                () => runModel(modelRequest),
                { allowOverBudget: true },
              ),
              isContextLengthError,
              contextWindow,
              semanticSummary,
              signal,
              userId: job?.userId || null,
              sessionId: recoverySessionId,
              toolChoice: 'none',
            })
            if (wrapUpRequest.recovery?.archiveId) {
              recovery = { archiveId: String(wrapUpRequest.recovery.archiveId) }
            }
            wrapUpText = wrapUpRequest.response?.content || ''
          } catch (wrapUpError) {
            if (wrapUpError?.name === 'AbortError') throw wrapUpError
          }
          assertRequiredArtifacts()
          const terminal = await finishTerminalResult({
            text: wrapUpText || `(模型预算已用尽:${error.message})\n\n已经完成的部分:\n${collected || error.partialModelResult?.content || '(无)'}`,
            artifactIds,
            iterations: iter + 1,
            incomplete: true,
            budgetExceeded: true,
            reason: error.message,
            recovery,
          }, { steeringLeaseId, finalMetadata: { budgetExceeded: true } })
          if (!terminal) continue
          return terminal
        }
        if (steeringLeaseId) {
          if (typeof releaseSteering === 'function') await releaseSteering(steeringLeaseId)
          steeringLeaseId = null
        }
        if (error?.name === 'AbortError' || iter === 0) throw error

        const collected = convo
          .filter((m) => m.role === 'tool')
          .map((m) => (typeof m.content === 'string' ? m.content : ''))
          .filter(Boolean)
          .join('\n')
          .slice(0, 4000)

        assertRequiredArtifacts()
        const terminal = await finishTerminalResult({
          text: `(任务中断:${error?.message || String(error)})\n\n已经完成的部分:\n${collected || '(无)'}`,
          artifactIds,
          iterations: iter + 1,
          interrupted: true,
          code: error?.code || 'MODEL_CALL_INTERRUPTED',
          reason: error?.message || String(error),
          recovery,
        }, {
          steeringLeaseId,
          appendTextToConversation: false,
          finalMetadata: {
            interrupted: true,
            code: error?.code || 'MODEL_CALL_INTERRUPTED',
          },
        })
        if (!terminal) continue
          return terminal
        }
      }
      const { content, toolCalls: rawToolCalls } = modelResult

      if (!rawToolCalls || rawToolCalls.length === 0) {
        if (hasVerifiedDirectoryResolution && DIRECTORY_AUTHORIZATION_WAIT_CLAIM.test(String(content || ''))) {
          const canRetry = directoryResumeRetries < MAX_DIRECTORY_RESUME_RETRIES
            && iter + 1 < maxIters
          if (!canRetry) {
            const incomplete = await finishIncomplete({
              text: '\u76ee\u5f55\u6743\u9650\u5df2\u6388\u4e88\uff0c\u4f46\u6a21\u578b\u5728\u6062\u590d\u540e\u4ecd\u91cd\u590d\u8bf7\u6c42\u540c\u4e00\u6388\u6743\uff0c\u4e14\u672a\u6267\u884c\u539f\u4efb\u52a1\u3002\u672c\u8f6e\u6ca1\u6709\u6807\u8bb0\u4e3a\u5b8c\u6210\u3002',
              reason: 'directory_resume_not_converged',
              steeringLeaseId,
            })
            if (incomplete.deferredForSteering) continue
            return incomplete
          }
          directoryResumeRetries += 1
          if (content) convo.push({ role: 'assistant', content })
          convo.push({
            role: 'system',
            content: [
              DIRECTORY_RESUME_GUARD_MARKER,
              'The requested directory grant is already verified in this checkpoint; there is no pending directory picker or authorization action.',
              'Do not ask the user to authorize, choose, or confirm that directory again.',
              'Continue the original task now with the available execution tools and obtain concrete execution and verification results before answering.',
            ].join(' '),
          })
          await persistTurn()
          if (steeringLeaseId && typeof acknowledgeSteering === 'function') {
            await acknowledgeSteering(steeringLeaseId)
          }
          continue
        }
        if (!hasRequiredArtifacts()) {
          const canRetry = artifactDeliveryRetries < MAX_ARTIFACT_DELIVERY_RETRIES && iter + 1 < maxIters
          const missing = missingArtifactTools()
          if (!canRetry) throw artifactDeliveryError(missing)
          artifactDeliveryRetries += 1
          if (content) convo.push({ role: 'assistant', content })
          convo.push({
            role: 'system',
            content: [
              ARTIFACT_DELIVERY_GUARD_MARKER,
              'The user requested a real downloadable file, but the previous response did not create one.',
              `Call each missing artifact generator now: ${missing.join(', ')}.`,
              'Do not ask for a directory, do not print source code as the deliverable, and do not claim completion until the tool returns artifactId.',
            ].join(' '),
          })
          await persistTurn()
          if (steeringLeaseId && typeof acknowledgeSteering === 'function') {
            await acknowledgeSteering(steeringLeaseId)
          }
          continue
        }
        if (!hasRequiredExecutionEvidence()) {
          const canRetry = executionEvidenceRetries < MAX_EXECUTION_EVIDENCE_RETRIES
            && iter + 1 < maxIters
          if (!canRetry) {
            const incomplete = await finishIncomplete({
              text: '任务尚未完成：模型没有调用任何可用工具取得实际执行结果。请重试，或切换到支持工具调用的模型。',
              reason: 'execution_evidence_missing',
              steeringLeaseId,
            })
            if (incomplete.deferredForSteering) continue
            return incomplete
          }
          executionEvidenceRetries += 1
          if (content) convo.push({ role: 'assistant', content })
          convo.push({
            role: 'system',
            content: [
              EXECUTION_EVIDENCE_GUARD_MARKER,
              'The previous response described work but did not execute any substantive tool successfully, so it was not accepted as completion.',
              'Use the available tools now and continue until there is a concrete tool result.',
              'If indispensable information is missing, call request_clarification instead of presenting instructions as a completed result.',
            ].join(' '),
          })
          await persistTurn()
          if (steeringLeaseId && typeof acknowledgeSteering === 'function') {
            await acknowledgeSteering(steeringLeaseId)
          }
          continue
        }
        if (hasPendingMutationVerification()) {
          const canRetry = mutationVerificationRetries < MAX_MUTATION_VERIFICATION_RETRIES
            && iter + 1 < maxIters
            && availableVerificationToolNames.length > 0
          if (!canRetry) {
            const incomplete = await finishIncomplete({
              text: availableVerificationToolNames.length > 0
                ? '修改已经执行，但尚未通过读回、差异检查或项目检查验证，因此没有标记为完成。请重试以继续验证。'
                : '修改已经执行，但当前没有启用可用于读回、差异检查或项目检查的工具，因此无法确认完成。',
              reason: 'post_mutation_verification_missing',
              steeringLeaseId,
            })
            if (incomplete.deferredForSteering) continue
            return incomplete
          }
          mutationVerificationRetries += 1
          if (content) convo.push({ role: 'assistant', content })
          convo.push({
            role: 'system',
            content: [
              POST_MUTATION_VERIFICATION_GUARD_MARKER,
              'A local mutation succeeded, but no later verification has succeeded, so the completion claim was discarded.',
              `Pending changed targets: ${[...pendingMutationTargets].join(', ')}.`,
              `Pending deleted targets: ${[...pendingDeletionTargets].join(', ')}.`,
              `Verify the changed state now with one of these available tools: ${availableVerificationToolNames.join(', ')}.`,
              'Read back each matching changed file, inspect the project diff, or run the relevant project check before answering. For deleted targets, list the complete parent directory so absence can be verified. Reading an unrelated file does not verify these targets.',
            ].join(' '),
          })
          await persistTurn()
          if (steeringLeaseId && typeof acknowledgeSteering === 'function') {
            await acknowledgeSteering(steeringLeaseId)
          }
          continue
        }
        if (requiresPdfLayoutVerification && !pdfLayoutVerificationObserved) {
          const canRetry = pdfLayoutVerificationRetries < MAX_PDF_LAYOUT_VERIFICATION_RETRIES
            && iter + 1 < maxIters
            && hasCommandExecutionTool(activeToolSpecs)
          if (!canRetry) {
            const incomplete = await finishIncomplete({
              text: '\u6587\u4ef6\u5df2\u751f\u6210\uff0c\u4f46\u5c1a\u672a\u901a\u8fc7\u76ee\u6807\u9875\u3001\u975e\u76ee\u6807\u9875\u3001\u6587\u672c\u8fb9\u754c\u4e0e\u9010\u9875\u6e32\u67d3\u7684 PDF \u5e03\u5c40\u6821\u9a8c\uff0c\u56e0\u6b64\u6ca1\u6709\u6807\u8bb0\u4e3a\u5b8c\u6210\u3002',
              reason: 'pdf_layout_verification_missing',
              steeringLeaseId,
            })
            if (incomplete.deferredForSteering) continue
            return incomplete
          }
          pdfLayoutVerificationRetries += 1
          if (content) convo.push({ role: 'assistant', content })
          convo.push({
            role: 'system',
            content: [
              PDF_LAYOUT_VERIFICATION_GUARD_MARKER,
              'The PDF/preview files exist, but existence and byte reads do not verify the requested page selection or visual layout.',
              requestedPdfSectionLabel(executionIntentText)
                ? `The authoritative requested section is ${requestedPdfSectionLabel(executionIntentText)}.`
                : 'Use the exact page or section named by the user.',
              `Create or correct a separate read-only verify_pdf_layout.py, then run it with ${commandExecutionToolLabel(activeToolSpecs)} after all writes.`,
              'It must assert target-page text, unchanged non-target pages, full text/order, glyph bounds, forbidden-line clearance, paragraph continuation/indentation, and one fresh non-empty PNG per output page.',
              `Do not use browser_open_url for local file:// PDF or PNG paths; browser tools accept only http/https URLs. Use ${commandExecutionToolLabel(activeToolSpecs)} and the validator for local visual evidence.`,
              `Only a successful validator that prints the standalone marker ${PDF_LAYOUT_VERIFICATION_OK} is accepted. Do not echo the marker or print it from the generation script.`,
            ].join(' '),
          })
          await persistTurn()
          if (steeringLeaseId && typeof acknowledgeSteering === 'function') {
            await acknowledgeSteering(steeringLeaseId)
          }
          continue
        }
        if (needsDeliverableSelection()) {
          if (deliverableSelectionRetries >= MAX_DELIVERABLE_SELECTION_RETRIES) {
            const incomplete = await finishIncomplete({
              text: 'Files were created, but the model did not explicitly select the final deliverables. No intermediate files were attached to the answer.',
              reason: 'deliverable_selection_missing',
              steeringLeaseId,
            })
            if (incomplete.deferredForSteering) continue
            return incomplete
          }
          deliverableSelectionRetries += 1
          if (content) convo.push({ role: 'assistant', content })
          convo.push({
            role: 'system',
            content: [
              DELIVERABLE_SELECTION_GUARD_MARKER,
              'The previous completion was discarded because this chat turn created files without explicitly selecting its final deliverables.',
              `Current artifact IDs: ${artifactIds.join(', ')}.`,
              'Call set_deliverables now with only the artifact_ids that should appear in the final answer. Use an empty array only when no file should be delivered.',
              'If any later tool creates another artifact, call set_deliverables again after that tool finishes.',
            ].join(' '),
          })
          if (iter + 1 >= maxIters) maxIters = iter + 2
          await persistTurn()
          if (steeringLeaseId && typeof acknowledgeSteering === 'function') {
            await acknowledgeSteering(steeringLeaseId)
          }
          continue
        }
        const completion = await prepareCompletionForSteering({
          text: content || '',
          steeringLeaseId,
        })
        if (!completion.closed) continue
        finalText = content || ''
        if (!completion.prepared) convo.push({ role: 'assistant', content: finalText })
        try {
          const hasFinalText = Boolean(finalText.trim())
          await persistTurn(hasFinalText ? { final: { text: finalText, iterations: iter + 1 } } : {})
          finalCheckpointPersisted = hasFinalText
          if (!completion.prepared && steeringLeaseId && typeof acknowledgeSteering === 'function') {
            await acknowledgeSteering(steeringLeaseId)
          }
        } catch (error) {
          if (steeringLeaseId && typeof releaseSteering === 'function') {
            await releaseSteering(steeringLeaseId)
          }
          throw error
        }
        break
      }

      // 唯一 id、参数 JSON 和简写/wire 形状都在公共 harness 里归一化。
      // 这样无 id 的调用也能保证 assistant.tool_calls 与 tool_call_id 严格配对。
      const scopedToolCalls = scopeTextToolCallIds(rawToolCalls, {
        turnId: job?.id || step?.id,
        iteration: iter,
      })
      const modelOutputTruncated = String(modelResult?.finishReason || '').toLowerCase() === 'length'
      checkpointCalls = normalizeToolCalls(scopedToolCalls, {
        toolSpecs: activeToolSpecs,
      }).map((call) => ({
        ...call,
        modelOutputTruncated,
        idempotencyKey: buildJobToolIdempotencyKey({
          jobId: job?.id,
          stepId: step?.id,
          toolCallId: call.id,
        }),
        checkpointStatus: 'pending',
        checkpointApprovalId: null,
      }))
      observeToolCalls(progressState, checkpointCalls)
      if (typeof onToolCall === 'function') {
        for (const call of checkpointCalls) await onToolCall(call)
      }
      await emitToolProgress('tools_scheduled')
      toolCalls = checkpointCalls
      convo.push(buildAssistantToolCallsMessage(toolCalls, content))
      try {
        // The model response and steering text become durable atomically from
        // the engine's perspective; only then may the steering lease be ACKed.
        await persistTurn()
        if (steeringLeaseId && typeof acknowledgeSteering === 'function') {
          await acknowledgeSteering(steeringLeaseId)
          steeringLeaseId = null
        }
        modelMutationBatchScheduled = true
      } catch (error) {
        if (steeringLeaseId && typeof releaseSteering === 'function') {
          await releaseSteering(steeringLeaseId)
        }
        throw error
      }
    }

    let pausedByClarification = null
    const budgetExceededByCompletedModelResponse = modelBudgetExceededAfterResponse
    modelBudgetExceededAfterResponse = null
    let budgetExceeded = budgetExceededByCompletedModelResponse
    let noProgressReason = null
    let noProgressCode = null
    const markCall = async (call, updates) => {
      Object.assign(call, updates)
      await persistTurn()
    }
    const observeFailureRecovery = (call, result) => {
      if (isSuccessfulToolResult(result)) {
        if (isSubstantiveToolCall(call)) {
          failureRecovery = restoreFailureRecovery()
          pendingFailureRecoveryPrompt = false
        }
        return
      }
      if (!shouldReflectOnFailure(result)) return
      const tool = String(call?.name || '').trim()
      if (!tool) return
      if (failureRecovery.tool !== tool) {
        failureRecovery = { tool, count: 0, reflected: false, attempts: [] }
      }
      failureRecovery.count += 1
      failureRecovery.attempts.push({
        tool,
        code: String(result?.code || 'tool_execution_failed').slice(0, 160),
        message: [
          String(result?.error || 'Tool execution failed.'),
          result?.hint ? `Hint: ${String(result.hint)}` : '',
        ].filter(Boolean).join(' ').slice(0, 800),
      })
      failureRecovery.attempts = failureRecovery.attempts.slice(-FAILURE_RECOVERY_THRESHOLD)
      if (failureRecovery.count >= FAILURE_RECOVERY_THRESHOLD && !failureRecovery.reflected) {
        pendingFailureRecoveryPrompt = true
      }
    }
    const appendFailureRecoveryPrompt = () => {
      if (!pendingFailureRecoveryPrompt || failureRecovery.reflected) return false
      const tried = failureRecovery.attempts.map((attempt, index) => (
        `${index + 1}. ${attempt.tool} failed with ${attempt.code}: ${attempt.message}`
      ))
      convo.push({
        role: 'system',
        content: [
          FAILURE_RECOVERY_MARKER,
          `The same tool (${failureRecovery.tool}) has failed ${failureRecovery.count} consecutive times.`,
          'Analyze the failure before making another call. Do not repeat the same method or merely vary guessed arguments.',
          'State internally what was tried, identify the likely cause from the concrete errors below, then choose a materially different strategy or report one specific blocker.',
          ...(process.platform === 'win32'
            && isCommandExecutionTool(failureRecovery.tool)
            && activeToolSpecs.some((spec) => toolNameFromSpec(spec) === 'write_file')
            ? [`For long or multiline Python on Windows, the required different strategy is: create a UTF-8 .py file with write_file, run it with ${failureRecovery.tool}, then verify the declared final outputs. Do not retry another long python -c command or a Unix-only pipeline.`]
            : []),
          ...tried,
        ].join('\n'),
      })
      failureRecovery.reflected = true
      pendingFailureRecoveryPrompt = false
      return true
    }

    const executeOne = async (call, { durableExecution = true } = {}) => {
      if (signal?.aborted) {
        const error = new Error('Turn cancelled')
        error.name = 'AbortError'
        throw error
      }
      if (typeof onToolStarted === 'function') await onToolStarted(call)
      const { name, args } = call
      // ★ 死循环 advisory：连续发出「同一工具 + 相同参数」时,记一条待注入提醒。
      // 只提醒不拦截 —— 模型自己决定换策略还是收尾(见 repeatCallGuard)。
      const repeatReminder = repeatCallGuard.record(name, args)
      if (repeatReminder) pendingRepeatCallReminder = repeatReminder
      let executionArgsUsed = args
      // ★ M3.5:预算检查(reflect/request_clarification 不计,鼓励复盘与澄清)
      const isFree = name === 'reflect' || name === 'request_clarification' || name === 'request_directory' || name === 'sleep_until' || name === 'set_deliverables'
      let result
      let outcomeBudgetExceeded = null
      let outcomeNoProgressReason = null
      let clarification = null
      let artifactId = null
      const idempotentResume = call.checkpointStatus === 'executing'
        && supportsIdempotentResume(executeTool, {
          name,
          args: call.checkpointExecutionArgs ?? args,
          job,
          step,
          toolCallId: call.id,
          idempotencyKey: call.idempotencyKey,
        })
      if (call.modelOutputTruncated) {
        result = {
          ok: false,
          code: 'tool_call_truncated',
          error: 'The model reached its output-token limit while generating this tool-call batch, so the arguments may be incomplete and were not executed.',
          retryable: true,
          hint: 'Generate a fresh complete tool call. Shorten large inline content or split the work into smaller calls when necessary.',
        }
      } else if (call.checkpointStatus === 'executing'
        && getToolMetadata(name, { args, userId: job?.userId || null }).isReadOnly !== true
        && !idempotentResume) {
        // We cannot prove whether a side effect committed before the process
        // stopped. Never replay it automatically: report the uncertainty to
        // the model so it can verify state or ask the user how to proceed.
        result = {
          ok: false,
          code: 'tool_execution_outcome_unknown',
          error: `The service restarted while ${name} was executing. It was not replayed because its side effects may already have happened.`,
          retryable: false,
          requiresUserVerification: true,
        }
      } else {
        const convergenceBlock = convergenceBlockFor(call)
        const guardDecision = convergenceBlock
          ? { ok: false, result: convergenceBlock, convergenceBlocked: true }
          : loopGuard.before(call)
        if (!guardDecision.ok) {
          result = guardDecision.result
          if (!guardDecision.convergenceBlocked) outcomeNoProgressReason = guardDecision.reason
        } else {
          // 每次非思维型工具尝试都计成本，包括模型给出的未知工具/损坏参数。
          // 校验仍会阻止它们真正执行，但不能让无效调用绕过预算。
          if (!isFree) {
            const b = budget.consume(1)
            if (!b.ok) {
              outcomeBudgetExceeded = b.reason
              result = { ok: false, code: 'tool_budget_exceeded', error: b.reason, retryable: false }
            }
          }

          if (!result) {
            // 被产物门控挡下的文件工具单独给一条可执行的说明,否则模型只看到
            // 「未知工具：create_pptx」会以为是系统故障,继续重试到耗尽预算。
            if (isFileArtifactTool(call.name) && !stepArtifactTools.has(call.name)) {
              result = {
                ok: false,
                code: 'artifact_tool_not_requested',
                error: `用户没有要求生成 ${call.name} 这类文件产物,该工具在本次任务中不可用。`,
                retryable: false,
                hint: '直接完成用户真正要求的工作(如修改代码、给出结论),并用文字说明结果;不要用文件代替交付。',
              }
            }
          }

          if (!result) {
            const validationError = validateToolCall(call, activeToolSpecs, {
              // 单测/嵌入方可注入自己的 executor；生产默认执行器仍严格限制在已声明工具集。
              allowUnknown: executeTool !== executeServerTool,
            })
            if (validationError) result = validationError
          }

          if (!result && name === 'request_directory' && hasVerifiedDirectoryResolution) {
            result = {
              ok: false,
              code: 'directory_authorization_already_resolved',
              error: 'The requested local directory authorization is already persisted and verified for this turn.',
              retryable: false,
              hint: 'Do not request the directory again. Continue the original task now using the exact authorized path and access mode from the TURN_RESOLUTION system message.',
            }
          }

          if (!result && name === 'request_clarification') {
            result = contradictedCapabilityClarification(args, activeToolSpecs, convo)
          }

          if (!result && name === 'set_deliverables') {
            try {
              result = selectDeliverables(args)
            } catch (error) {
              result = normalizeToolError(error)
            }
          }

          if (!result) {
            try {
              // Resume the exact persisted approval after restart; otherwise
              // run the pre hook once, then create and persist the approval.
              // A resumed approval already contains the hook-rewritten args,
              // so the pre hook must not be fired a second time after restart.
              const resumingApproval = call.checkpointStatus === 'awaiting_approval' && call.checkpointApprovalId
              let effectiveArgs = args
              let gate = null
              let hookAuthorizedCall = false
              let hookRequiresApproval = false
              let hookApprovalReason = null
              if (idempotentResume) {
                effectiveArgs = call.checkpointExecutionArgs ?? effectiveArgs
                gate = {
                  proceed: true,
                  args: effectiveArgs,
                  approvalId: call.checkpointApprovalId || null,
                  resumedIdempotentExecution: true,
                }
              } else if (resumingApproval) {
                gate = await resumePersistedApproval({ approvalId: call.checkpointApprovalId, signal })
                effectiveArgs = gate.args ?? effectiveArgs
              } else {
                if (enableToolHooks && job?.userId) {
                  const preHook = await dispatchHooks({
                    userId: job.userId,
                    event: 'pre_tool_use',
                    tool: name,
                    args: effectiveArgs,
                    sessionId: job.id || null,
                    requestId: step?.id || null,
                  })
                  if (!preHook.allow) {
                    result = {
                      ok: false,
                      denied: true,
                      code: 'hook_denied',
                      error: preHook.reason || `pre_tool_use hook denied ${name}`,
                      retryable: false,
                    }
                  } else if (preHook.replacementArgs && typeof preHook.replacementArgs === 'object') {
                    effectiveArgs = preHook.replacementArgs
                  }
                  // A pre_tool_use hook may authorize the call directly,
                  // bypassing the approval inbox for this invocation.
                  if (preHook.permissionDecision === 'allow') hookAuthorizedCall = true
                  if (preHook.permissionDecision === 'ask') {
                    hookRequiresApproval = true
                    hookApprovalReason = preHook.reason || null
                  }
                }
                if (!result && effectiveArgs !== args) {
                  const hookValidationError = validateToolCall(
                    { ...call, args: effectiveArgs },
                    activeToolSpecs,
                    { allowUnknown: executeTool !== executeServerTool },
                  )
                  if (hookValidationError) result = hookValidationError
                }
                if (!result && !hookAuthorizedCall) {
                  gate = await requestToolApproval({
                    userId: job?.userId || null,
                    origin: approvalOrigin,
                    jobId: approvalOrigin === 'chat' ? null : job?.id || null,
                    stepId: approvalOrigin === 'chat' ? job?.id || null : step?.id || null,
                    sessionId: approvalSessionId,
                    toolName: name,
                    args: effectiveArgs,
                    signal,
                    mode: approvalMode,
                    forceApproval: hookRequiresApproval,
                    forceApprovalReason: hookApprovalReason,
                    onPending: async (approval) => {
                      await markCall(call, {
                        checkpointStatus: 'awaiting_approval',
                        checkpointApprovalId: approval.id,
                      })
                      if (typeof onApprovalPending === 'function') await onApprovalPending(approval)
                    },
                  })
                }
                if (!result && hookAuthorizedCall) {
                  gate = { proceed: true, args: effectiveArgs, hookAuthorized: true }
                }
              }
              if (gate && !gate.proceed) {
                result = formatDeniedToolResult(gate)
              } else if (gate) {
                const executionArgs = gate.args ?? effectiveArgs
                executionArgsUsed = executionArgs
                rememberApprovedSubagentCall(subagentApprovalContext, name, executionArgs, gate)
                const executionMetadata = getToolMetadata(name, {
                  args: executionArgs,
                  userId: job?.userId || null,
                })
                // Mutating tools ignore lease/transport aborts while a call is in flight,
                // but an explicit user stop still reaches cancellable shell/browser work.
                const abortScope = createToolAbortScope(signal, executionMetadata.interruptBehavior)
                if (durableExecution) {
                  await markCall(call, {
                    checkpointStatus: 'executing',
                    checkpointApprovalId: gate.approvalId || call.checkpointApprovalId || null,
                    checkpointExecutionArgs: executionArgs,
                    idempotencyKey: call.idempotencyKey,
                  })
                }
                try {
                  result = await executeToolWithRetry({
                    metadata: executionMetadata,
                    signal: abortScope.signal,
                    maxAttempts: toolRetryMaxAttempts,
                    baseDelayMs: toolRetryBaseDelayMs,
                    execute: () => executeTool({
                      name,
                      args: executionArgs,
                      job,
                      step,
                      signal: abortScope.signal,
                      budget,
                      toolCallId: call.id,
                      idempotencyKey: call.idempotencyKey,
                      approvalContext: subagentApprovalContext,
                      allowedArtifactTools: stepArtifactTools,
                    }),
                  })
                } finally {
                  abortScope.dispose()
                }
                if (gate.authorization && result && typeof result === 'object') {
                  result = { ...result, approvalAuthorization: gate.authorization }
                }
                artifactId = result?.artifactId || null
                if (isLoopPauseResult(result)) clarification = result.clarification
                if (enableToolHooks && job?.userId) {
                  try {
                    await dispatchHooks({
                      userId: job.userId,
                      event: 'post_tool_use',
                      tool: name,
                      args: { input: executionArgs, output: result },
                      sessionId: job.id || null,
                      requestId: step?.id || null,
                    })
                  } catch {
                    // The tool has already executed; a post hook failure must
                    // not replay or reinterpret its side effects.
                  }
                }
              }
              if (gate?.approvalId && !gate.resumedIdempotentExecution && typeof onApprovalResolved === 'function') {
                try {
                  await onApprovalResolved(gate)
                } catch {
                  // Approval has already resolved and the tool may already
                  // have committed an external side effect. An event/UI sink
                  // failure must never overwrite that real outcome and invite
                  // the model to replay the write.
                }
              }
            } catch (err) {
              if (signal?.aborted || err?.name === 'AbortError') throw err
              result = normalizeToolError(err)
            }
          }
        }
      }

      return {
        call,
        executionArgs: executionArgsUsed,
        result,
        artifactId,
        clarification,
        budgetExceeded: outcomeBudgetExceeded,
        noProgressReason: outcomeNoProgressReason,
      }
    }

    const pendingToolResultCount = Math.max(
      1,
      toolCalls.filter((call) => call.checkpointStatus !== 'completed').length,
    )
    const toolResultMaxChars = resolveToolResultMaxChars({
      contextWindow,
      resultCount: pendingToolResultCount,
    })
    const convergenceBatch = {
      exploratorySuccess: false,
      productiveSuccess: false,
    }
    // OpenAI-compatible providers require every tool response for one
    // assistant tool_calls batch to be contiguous. Browser screenshots add a
    // multimodal user message, so defer that (and any other post-tool context)
    // until every tool_call in this batch has received its tool response.
    const deferredPostBatchMessages = []

    const recordOutcome = async (outcome) => {
      outcome.result = normalizeToolResult(outcome.result)
      const succeeded = isSuccessfulToolResult(outcome.result)
      const executedCall = outcome.executionArgs === outcome.call?.args
        ? outcome.call
        : { ...outcome.call, args: outcome.executionArgs }
      if (succeeded && !outcome.artifactId) {
        const localArtifacts = await persistLocalToolArtifactsAsync({
          call: executedCall,
          result: outcome.result,
          job,
          step,
        })
        if (localArtifacts.length > 0) {
          outcome.artifactId = localArtifacts[0].id
          outcome.artifactIds = localArtifacts.map((artifact) => artifact.id)
          outcome.artifacts = localArtifacts.map(({ id, filename, type, url }) => ({ id, filename, type, url }))
          outcome.result = {
            ...outcome.result,
            artifactId: localArtifacts[0].id,
            filename: localArtifacts[0].filename,
            url: localArtifacts[0].url,
            artifacts: outcome.artifacts,
          }
        }
      }
      const progressChanges = progressChangesFor(executedCall, outcome.result)
      const semanticControlCall = executedCall?.name === 'set_deliverables'
      const installSignature = installAttemptSignature(executedCall)
      if (installSignature) rememberInstallAttempt(installSignature)
      const productiveExecution = !semanticControlCall && executionConvergenceEnabled
        && isProductiveExecutionOutcome(executedCall, outcome.result, outcome.artifactId)
      if (productiveExecution) {
        convergenceBatch.productiveSuccess = true
      } else if (executionConvergenceEnabled
        && succeeded
        && isExplorationOnlyCall(executedCall, job?.userId || null)) {
        convergenceBatch.exploratorySuccess = true
      }
      recordToolProgress(progressState, {
        call: outcome.call,
        succeeded,
        ...progressChanges,
      })
      observeFailureRecovery(executedCall, outcome.result)
      if (!succeeded) outcome.artifactId = null
      const scheduledWaitEvidence = executedCall?.name === 'sleep_until'
        && outcome.result?.paused === true
        && outcome.result?.clarification?.blocker_kind === 'scheduled_wake'
        && Number.isFinite(Number(outcome.result?.clarification?.wakeAt))
        && SCHEDULED_WAIT_INTENT.test(executionIntentText)
      if (!semanticControlCall && succeeded && (isSubstantiveToolCall(executedCall) || scheduledWaitEvidence)) {
        executionEvidenceObserved = true
      }
      const mutationExecutionSucceeded = semanticControlCall
        ? false
        : executionConvergenceEnabled
        ? productiveExecution
        : succeeded && isMutationExecutionCall(executedCall, outcome.artifactId)
      if (mutationExecutionSucceeded) {
        mutationExecutionObserved = true
      }
      if (mutationExecutionSucceeded && isLocalMutationCall(executedCall)) {
        if (requiresPdfLayoutVerification) pdfLayoutVerificationObserved = false
        const deletionTargets = looksLikeDeletionCommand(executedCall?.args?.command)
          ? staticDeletionTargets(executedCall, outcome.result)
          : null
        if (deletionTargets?.size) {
          for (const deletionTarget of deletionTargets) {
            for (const pending of [...pendingMutationTargets]) {
              if (pending !== PROJECT_SCOPE_TARGET && targetsMatch(pending, deletionTarget)) {
                pendingMutationTargets.delete(pending)
              }
            }
            pendingDeletionTargets.add(deletionTarget)
          }
        } else {
          for (const target of extractMutationTargets(executedCall, outcome.result)) {
            pendingMutationTargets.add(target)
            if (target === PROJECT_SCOPE_TARGET) continue
            for (const deleted of [...pendingDeletionTargets]) {
              if (targetsMatch(deleted, target)) pendingDeletionTargets.delete(deleted)
            }
          }
        }
        mutationVerificationRetries = 0
      } else if (succeeded && hasPendingMutationVerification() && isVerificationCall(executedCall)) {
        const clearedMutation = clearVerifiedMutationTargets(
          pendingMutationTargets,
          executedCall,
          outcome.result,
        )
        const clearedDeletion = clearVerifiedDeletionTargets(
          pendingDeletionTargets,
          executedCall,
          outcome.result,
        )
        if (clearedMutation || clearedDeletion) {
          mutationVerificationRetries = 0
        }
      }
      if (requiresPdfLayoutVerification
        && isSuccessfulPdfLayoutVerification(executedCall, outcome.result)) {
        pdfLayoutVerificationObserved = true
        pdfLayoutVerificationRetries = 0
        // ★ 验证器会重新打开源文件与输出文件并逐页断言文本/边界/预览 PNG,
        // 这是比 read/diff 更强的验证证据。它打印 OK 即证明本轮产物完整 ——
        // 清空待验证目标,否则「验证明明通过」最后仍会误报
        // post_mutation_verification_missing,任务以一句矛盾的失败收尾。
        pendingMutationTargets.clear()
        pendingDeletionTargets.clear()
        mutationVerificationRetries = 0
      }
      if (Array.isArray(outcome.artifactIds)) recordArtifactIds(outcome.artifactIds)
      else if (outcome.artifactId) recordArtifactIds([outcome.artifactId])
      if (outcome.artifactId && expectedArtifactTools.has(outcome.call?.name)) {
        deliveredArtifactTools.add(outcome.call.name)
      }
      if (executedCall?.name === 'read_file' && succeeded) {
        hasSuccessfulRepresentativeRead = true
      }
      const toolResultMessages = buildToolResultMessages(
        outcome.call,
        outcome.result,
        { maxChars: toolResultMaxChars },
      )
      if (toolResultMessages.length > 1 && outcome.result?.image?.data) {
        const compactImage = { ...outcome.result.image }
        delete compactImage.data
        outcome.result = { ...outcome.result, image: { ...compactImage, captured: true } }
      }
      const [toolResultMessage, ...postToolMessages] = toolResultMessages
      convo.push(toolResultMessage)
      deferredPostBatchMessages.push(...postToolMessages)
      if (executedCall?.name === 'request_directory'
        && succeeded
        && outcome.result?.already_authorized === true
        && outcome.result?.authorization?.resource_type === 'directory') {
        const accessMode = String(outcome.result.authorization.access_mode || '').trim()
        const requiredNames = new Set([
          'list_directory',
          'read_file',
          ...(accessMode === 'read_write'
            ? ['write_file', 'edit_file', ...COMMAND_EXECUTION_TOOL_NAMES]
            : []),
        ])
        const byName = new Map(activeToolSpecs.map((spec) => [toolNameFromSpec(spec), spec]))
        for (const spec of Array.isArray(fallbackToolSpecs) ? fallbackToolSpecs : []) {
          const name = toolNameFromSpec(spec)
          if (requiredNames.has(name) && !byName.has(name)) byName.set(name, spec)
        }
        const refreshedSpecs = [...byName.values()].filter(Boolean)
        if (refreshedSpecs.length > activeToolSpecs.length) {
          activeToolSpecs = refreshedSpecs
          convo = replaceRuntimeCapabilityBlock(convo, {
            toolSpecs: activeToolSpecs,
            approvalMode,
          })
          availableVerificationToolNames = activeToolSpecs
            .map(toolNameFromSpec)
            .filter((name) => VERIFICATION_TOOLS.has(name) || isCommandExecutionTool(name))
          requiresPdfLayoutVerification = mutationExecutionRequested
            && shouldRequirePdfLayoutVerification(executionIntentText)
            && hasCommandExecutionTool(activeToolSpecs)
          deferredPostBatchMessages.push({
            role: 'system',
            content: [
              '[DIRECTORY AUTHORIZATION TOOL REFRESH]',
              `The persisted ${accessMode} directory grant has been verified by the runtime.`,
              `The callable tools for the next response are now: ${activeToolSpecs.map(toolNameFromSpec).filter(Boolean).join(', ')}.`,
              `Use the exact authorized directory ${JSON.stringify(outcome.result.authorization.path)} and continue the original task without requesting authorization again.`,
              `This refreshed list supersedes the earlier ${AVAILABLE_TOOL_CAPABILITIES_MARKER} list for local file and code-execution capabilities.`,
            ].join(' '),
          })
        }
      }
      const convergenceBlocked = [
        'execution_convergence_probe_blocked',
        'execution_convergence_install_blocked',
      ].includes(String(outcome.result?.code || ''))
      const progress = convergenceBlocked
        ? { ok: true }
        : loopGuard.after(outcome.result, outcome.call)
      const toolProgress = convergenceBlocked
        ? { ok: true }
        : loopGuard.afterCall?.(executedCall, outcome.result) || { ok: true }
      if (!noProgressReason) {
        noProgressReason = outcome.noProgressReason
          || (!toolProgress.ok ? toolProgress.reason : null)
          || (!progress.ok ? progress.reason : null)
        if (noProgressReason) {
          noProgressCode = outcome.noProgressReason
            ? outcome.result?.code || 'tool_no_progress'
            : !toolProgress.ok
              ? toolProgress.result?.code || 'tool_no_progress'
              : progress.result?.code || 'tool_no_progress'
        }
      }
      if (!budgetExceeded && outcome.budgetExceeded) budgetExceeded = outcome.budgetExceeded
      if (!pausedByClarification && outcome.clarification) pausedByClarification = outcome.clarification
      await markCall(outcome.call, {
        checkpointStatus: 'completed',
        checkpointResult: outcome.result,
        checkpointArtifactId: outcome.artifactId || null,
      })
      if (typeof onToolCompleted === 'function') await onToolCompleted(outcome)
      await emitToolProgress('tool_completed')
    }

    const isParallelReadCall = (call) => {
      const metadata = getToolMetadata(call.name, {
        args: call.args,
        userId: job?.userId || null,
      })
      // Concurrency safety only describes whether two calls may overlap; it
      // is not proof that a side effect can be replayed after a crash. Keep
      // every mutation on the durable serial path even when a dynamic/MCP
      // tool explicitly declares itself concurrency-safe.
      return metadata.isReadOnly === true && metadata.isConcurrencySafe === true
    }
    const requiresPreExecutionSteeringCheck = (call) => {
      if (!call) return false
      const metadata = getToolMetadata(call.name, {
        args: call.args,
        userId: job?.userId || null,
      })
      // Command tools remain conservatively guarded even when static analysis
      // classifies a particular command as read-only. Every other built-in,
      // MCP, or plugin tool is governed by its canonical side-effect metadata.
      return isCommandExecutionTool(call) || metadata.isReadOnly !== true
    }
    const shouldStopBatch = () => Boolean(
      noProgressReason || budgetExceeded || pausedByClarification,
    )
    const skipRemainingCalls = async (startIndex) => {
      // If the batch must stop, every unanswered tool_call still needs a tool
      // result before the conversation can be sent back to the model.
      for (const skipped of toolCalls.slice(startIndex)) {
        if (skipped.checkpointStatus === 'completed') continue
        const skippedResult = {
          ok: false,
          code: 'tool_execution_skipped',
          error: noProgressReason || budgetExceeded || '当前轮已暂停',
          retryable: false,
        }
        convo.push(buildToolResultMessage(skipped, skippedResult))
        Object.assign(skipped, {
          checkpointStatus: 'completed',
          checkpointResult: skippedResult,
        })
        recordToolProgress(progressState, { call: skipped, succeeded: false })
      }
      await persistTurn()
    }
    const supersedeRemainingCalls = (startIndex) => {
      for (const superseded of toolCalls.slice(startIndex)) {
        if (superseded.checkpointStatus === 'completed') continue
        const supersededResult = {
          ok: false,
          code: 'tool_execution_superseded_by_steering',
          error: 'This unstarted tool call was skipped because newer user steering superseded the current tool-call batch.',
          retryable: false,
          superseded: true,
          executed: false,
        }
        convo.push(buildToolResultMessage(
          superseded,
          supersededResult,
          { maxChars: toolResultMaxChars },
        ))
        Object.assign(superseded, {
          checkpointStatus: 'completed',
          checkpointResult: supersededResult,
          checkpointArtifactId: null,
        })
        // Superseded calls count as protocol-complete progress, but they never
        // enter failure recovery, convergence, loop-guard, or tool-failure UI.
        recordToolProgress(progressState, { call: superseded, succeeded: false })
      }
    }
    const claimSteeringAtToolBoundary = async (startIndex) => {
      if (startIndex >= toolCalls.length || typeof claimSteering !== 'function') return false
      const claimed = await claimSteering()
      if (!claimed?.messages?.length) return false
      const freshMessages = freshSteeringMessages(claimed.messages)
      if (freshMessages.length === 0) {
        if (claimed.leaseId) await persistAndAcknowledgeSteering(claimed.leaseId)
        return false
      }

      supersedeRemainingCalls(startIndex)
      // Keep every tool response in the assistant batch contiguous before
      // adding screenshot context or the newer user direction.
      convo.push(...deferredPostBatchMessages)
      deferredPostBatchMessages.length = 0
      appendSteeringMessages(freshMessages)
      await persistAndAcknowledgeSteering(claimed.leaseId)
      if (iter + 1 >= maxIters) maxIters = iter + 2
      return true
    }

    // Preserve model order while treating each write or non-concurrency-safe
    // call as a barrier. Consecutive safe reads before and after a barrier can
    // run concurrently, while the barrier itself keeps durable execution and
    // approval/checkpoint semantics.
    let callIndex = 0
    let batchSupersededBySteering = false
    const firstPendingCallIndex = toolCalls.findIndex((call) => call.checkpointStatus !== 'completed')
    const firstPendingCall = firstPendingCallIndex >= 0 ? toolCalls[firstPendingCallIndex] : null
    if (modelMutationBatchScheduled
      && requiresPreExecutionSteeringCheck(firstPendingCall)
      && await claimSteeringAtToolBoundary(firstPendingCallIndex)) {
      batchSupersededBySteering = true
    }
    while (!batchSupersededBySteering && callIndex < toolCalls.length) {
      const call = toolCalls[callIndex]
      if (call.checkpointStatus === 'completed') {
        callIndex += 1
        continue
      }

      if (isParallelReadCall(call)) {
        const readSegment = []
        let segmentEnd = callIndex
        while (segmentEnd < toolCalls.length) {
          const candidate = toolCalls[segmentEnd]
          if (candidate.checkpointStatus === 'completed' || !isParallelReadCall(candidate)) break
          readSegment.push(candidate)
          segmentEnd += 1
        }
        const outcomes = await mapWithConcurrency(
          readSegment,
          (candidate) => executeOne(candidate, { durableExecution: false }),
          { concurrency: JOB_READ_CONCURRENCY },
        )
        const hardNoProgressOutcome = outcomes.find((outcome) => outcome.noProgressReason) || null
        for (const outcome of outcomes) await recordOutcome(outcome)
        // A later successful candidate proves progress after ordinary read
        // failures. It must not, however, erase a pre-execution hard fuse such
        // as the third identical call in the same segment.
        if (hardNoProgressOutcome) {
          noProgressReason = hardNoProgressOutcome.noProgressReason
          noProgressCode = hardNoProgressOutcome.result?.code || 'tool_no_progress'
        } else if (outcomes.some(({ result }) => result?.ok === true)) {
          noProgressReason = null
          noProgressCode = null
        }
        callIndex = segmentEnd
      } else {
        const outcome = await executeOne(call)
        await recordOutcome(outcome)
        callIndex += 1
      }

      if (await claimSteeringAtToolBoundary(callIndex)) {
        batchSupersededBySteering = true
        break
      }
      if (shouldStopBatch()) {
        await skipRemainingCalls(callIndex)
        break
      }
    }
    convo.push(...deferredPostBatchMessages)
    const failureStrategyAdvisories = loopGuard.pendingAdvisories?.() || []
    for (const advisory of failureStrategyAdvisories) {
      convo.push({
        role: 'system',
        content: [
          '[TOOL FAILURE STRATEGY REQUIRED]',
          'code=' + advisory.code,
          'level=' + advisory.level,
          'tool=' + advisory.tool,
          'failures=' + advisory.count + '.',
          advisory.content,
        ].join(' '),
      })
    }
    // Commit the fired tier only after its model-visible message is in the
    // conversation. The checkpoint below then persists both atomically.
    if (failureStrategyAdvisories.length > 0) loopGuard.commitPendingAdvisories?.()
    if (executionConvergenceEnabled) {
      if (convergenceBatch.productiveSuccess) {
        executionConvergence.unproductiveRounds = 0
        executionConvergence.interventionActive = false
        executionConvergence.installAttempts = []
      } else if (convergenceBatch.exploratorySuccess) {
        executionConvergence.unproductiveRounds += 1
      }
      if (!executionConvergence.interventionActive
        && executionConvergence.unproductiveRounds >= EXECUTION_CONVERGENCE_ROUND_THRESHOLD) {
        executionConvergence.interventions += 1
        executionConvergence.interventionActive = true
        convo.push({
          role: 'system',
          content: [
            EXECUTION_CONVERGENCE_MARKER,
            `${executionConvergence.unproductiveRounds} consecutive tool batches completed discovery or inspection work without producing the requested output.`,
            'Discovery is now considered complete. Do not create or run more inspect/probe/diagnostic scripts, repeat dependency checks, or reinstall an already attempted dependency.',
            'Immediately execute the requested mutation or artifact-generation step, declare expected_outputs for generated local files when supported, and then verify the resulting files or project state.',
            'If execution is genuinely blocked, report the single concrete command error or missing authorization; do not substitute another exploration loop.',
          ].join(' '),
        })
      }
    }
    appendFailureRecoveryPrompt()
    if (pendingRepeatCallReminder) {
      convo.push({
        role: 'system',
        content: `${REPEAT_CALL_GUARD_MARKER} ${pendingRepeatCallReminder.content}`,
      })
      pendingRepeatCallReminder = null
    }
    checkpointCalls = null
    await persistTurn()
    await emitToolProgress('batch_completed')
    if (batchSupersededBySteering) continue
    if (needsDeliverableSelection() && iter + 1 >= maxIters) maxIters = iter + 2
    if (budgetExceeded) {
      // ★ Lens-4 fix:预算超限写 audit,审计员能追查 job 为什么没跑完
      if (job?.userId) {
        writeToolAudit({
          userId: job.userId,
          origin: 'budget',
          toolName: 'job_budget',
          args: { jobId: job.id, stepId: step?.id, snapshot: budget.snapshot?.() },
          status: 'denied',
          durationMs: 0,
        })
      }
      // ★ 这里以前直接 return finalText —— 而 finalText 在预算路径上几乎必然是 ''。
      // 用户看到的就是「任务跑了很久,然后一个字都没有」,即
      // 「做到一半就没有后续」最典型的现场。
      //
      // 对齐 maxIters 路径的做法:让模型基于已有信息收个尾。
      // 收尾调用**不再受已耗尽的预算约束**(不传 consumeBudget)—— 否则预算已经
      // 超了,收尾调用自己也会被拒,永远拿不到总结,等于没修。
      if (!finalText && budgetExceededByCompletedModelResponse) {
        finalText = '\u5df2\u6267\u884c\u6a21\u578b\u8fd4\u56de\u7684\u6700\u540e\u4e00\u6279\u5de5\u5177\u8c03\u7528\uff0c\u4f46\u6a21\u578b token \u9884\u7b97\u5df2\u7528\u5c3d\u3002\u5df2\u4fdd\u5b58\u68c0\u67e5\u70b9\uff1b\u91cd\u8bd5\u540e\u53ef\u4ece\u5f53\u524d\u8fdb\u5ea6\u7ee7\u7eed\uff0c\u4e0d\u4f1a\u91cd\u590d\u5df2\u5b8c\u6210\u7684\u5de5\u5177\u8c03\u7528\u3002'
      }
      if (!finalText) {
        try {
          const wrapUpRequest = await callModelWithContextRecovery({
            messages: [
              ...convo,
              {
                role: 'system',
                content: `任务预算已用尽(${budgetExceeded})。请基于目前已经取得的进展给出总结:做完了什么、还差什么、建议用户下一步怎么做。不要再调用任何工具。`,
              },
            ],
            tools: [],
            callModel: (modelRequest) => runWithModelBudget(
              budget,
              () => runModel(modelRequest),
              { allowOverBudget: true },
            ),
            isContextLengthError,
            contextWindow,
            semanticSummary,
            signal,
            userId: job?.userId || null,
            sessionId: recoverySessionId,
            toolChoice: 'none',
          })
          if (wrapUpRequest.recovery?.archiveId) {
            recovery = { archiveId: String(wrapUpRequest.recovery.archiveId) }
          }
          finalText = wrapUpRequest.response?.content || ''
        } catch {
          writeToolAudit?.({
            userId: job?.userId,
            origin: 'budget',
            toolName: 'wrap_up',
            args: { jobId: job?.id, stepId: step?.id },
            status: 'error',
            durationMs: 0,
          })
          finalText = ''
        }
      }
      assertRequiredArtifacts()
      const terminal = await finishTerminalResult({
        text: finalText || `(任务预算已用尽:${budgetExceeded}。上面的工具结果可能已包含部分进展,可以点「重试」从断点继续。)`,
        artifactIds,
        iterations: iter + 1,
        incomplete: true,
        budgetExceeded: true,
        reason: budgetExceeded,
        recovery,
      }, { steeringLeaseId, finalMetadata: { budgetExceeded: true } })
      if (!terminal) continue
      return terminal
    }
    if (pausedByClarification) {
      // ★ M3: 模型主动调 request_clarification → 当轮 loop 中断交回用户
      const terminal = await finishTerminalResult({
        text: finalText || String(
          pausedByClarification.question
          || pausedByClarification.message
          || '需要你补充信息后才能继续。',
        ),
        artifactIds,
        iterations: iter + 1,
        paused: true,
        clarification: pausedByClarification,
        recovery,
      }, {
        steeringLeaseId,
        finalMetadata: { paused: true, clarification: pausedByClarification },
      })
      if (!terminal) continue
      return terminal
    }
    if (noProgressReason) {
      try {
        const wrapUpRequest = await callModelWithContextRecovery({
          messages: [
            ...convo,
            {
              role: 'system',
              content: `工具循环因无进展停止：${noProgressReason}。请基于已有信息给出部分结论，不要再调用工具。`,
            },
          ],
          tools: [],
          callModel: (modelRequest) => runWithModelBudget(
            budget,
            () => runModel(modelRequest),
            { allowOverBudget: true },
          ),
          isContextLengthError,
          contextWindow,
          semanticSummary,
          signal,
          userId: job?.userId || null,
          sessionId: recoverySessionId,
          consumeBudget: (cost) => budget.consume(cost),
          toolChoice: 'none',
        })
        if (wrapUpRequest.recovery?.archiveId) {
          recovery = { archiveId: String(wrapUpRequest.recovery.archiveId) }
        }
        const wrapUp = wrapUpRequest.response
        finalText = wrapUp?.content || ''
      } catch {
        finalText = ''
      }
      assertRequiredArtifacts()
      const terminal = await finishTerminalResult({
        text: finalText || `(工具循环已停止：${noProgressReason})`,
        artifactIds,
        iterations: iter + 1,
        incomplete: true,
        noProgress: true,
        code: noProgressCode || 'tool_no_progress',
        reason: noProgressReason,
        recovery,
      }, {
        steeringLeaseId,
        finalMetadata: {
          noProgress: true,
          code: noProgressCode || 'tool_no_progress',
        },
      })
      if (!terminal) continue
      return terminal
    }
  }

  // ★ Harness: 到达迭代上限时,以前直接返回空 finalText —— 用户看到的是
  // "任务完成但什么都没说"。对齐 subagentRuntime 的做法:让模型基于已有信息
  // 收个尾,拿不到就至少说清楚是被上限截断的,不要静默空返回。
  if (!finalText) {
    try {
      const wrapUpRequest = await callModelWithContextRecovery({
        messages: [
          ...convo,
          {
            role: 'system',
            content: `你已达到工具调用上限(${maxIters} 轮)。请基于目前已有的信息给出最终回答,不要再调用任何工具。`,
          },
        ],
        tools: [],
        callModel: (modelRequest) => runWithModelBudget(
          budget,
          () => runModel(modelRequest),
          { allowOverBudget: true },
        ),
        isContextLengthError,
        contextWindow,
        semanticSummary,
        signal,
        userId: job?.userId || null,
        sessionId: recoverySessionId,
        consumeBudget: (cost) => budget.consume(cost),
        toolChoice: 'none',
      })
      if (wrapUpRequest.recovery?.archiveId) {
        recovery = { archiveId: String(wrapUpRequest.recovery.archiveId) }
      }
      const wrapUp = wrapUpRequest.response
      finalText = wrapUp?.content || ''
    } catch {
      writeToolAudit?.({
        userId: job?.userId,
        origin: 'loop',
        toolName: 'wrap_up',
        args: { jobId: job?.id, stepId: step?.id },
        status: 'error',
        durationMs: 0,
      })
      finalText = ''
    }
    if (!finalText) {
      finalText = `(已达到 ${maxIters} 轮工具调用上限,任务未能自行收尾。上面的工具结果可能已包含部分进展。)`
    }
  }

  assertRequiredArtifacts()
  if (!hasRequiredExecutionEvidence()) {
    return finishIncomplete({
      text: '\u4efb\u52a1\u5c1a\u672a\u5b8c\u6210\uff1a\u672a\u83b7\u5f97\u53ef\u9a8c\u8bc1\u7684\u5b9e\u9645\u6267\u884c\u7ed3\u679c\u3002\u8bf7\u91cd\u8bd5\uff0c\u6216\u5207\u6362\u5230\u652f\u6301\u5de5\u5177\u8c03\u7528\u7684\u6a21\u578b\u3002',
      reason: 'execution_evidence_missing',
    })
  }
  if (hasPendingMutationVerification()) {
    return finishIncomplete({
      text: availableVerificationToolNames.length > 0
        ? '\u4fee\u6539\u5df2\u7ecf\u6267\u884c\uff0c\u4f46\u5c1a\u672a\u901a\u8fc7\u8bfb\u56de\u3001\u5dee\u5f02\u68c0\u67e5\u6216\u9879\u76ee\u68c0\u67e5\u9a8c\u8bc1\uff0c\u56e0\u6b64\u6ca1\u6709\u6807\u8bb0\u4e3a\u5b8c\u6210\u3002'
        : '\u4fee\u6539\u5df2\u7ecf\u6267\u884c\uff0c\u4f46\u5f53\u524d\u6ca1\u6709\u53ef\u7528\u7684\u9a8c\u8bc1\u5de5\u5177\uff0c\u56e0\u6b64\u65e0\u6cd5\u786e\u8ba4\u5b8c\u6210\u3002',
      reason: 'post_mutation_verification_missing',
    })
  }
  if (!finalCheckpointPersisted) {
    await persistTurn({ final: { text: finalText, iterations: Math.min(iter + 1, maxIters) } })
  }
  return {
    text: finalText,
    artifactIds,
    ...deliverySelectionFields(),
    iterations: Math.min(iter + 1, maxIters),
    recovery,
  }
}

/**
 * 工具循环入口的日志关联上下文。
 *
 * job 链路和 turn 链路共用 runToolsLoop。这里按 job 对象把 jobId/userId/sessionId
 * 挂进 AsyncLocalStorage 上下文,期间模型代理、工具执行、压缩恢复等结构化日志
 * 都能按 jobId(或 turn 的稳定 id)串起来。turn 链路外层(TurnEngine.startTurn)
 * 已经挂过 turnId/sessionId,withLogContext 会合并而不是覆盖。
 */
export function runToolLoop(options = {}) {
  const job = options?.job
  return withLogContext(
    { jobId: job?.id, userId: job?.userId, sessionId: job?.sessionId },
    () => runToolsLoop(options),
  )
}

export const _testing = {
  attachVisionFeedback,
  visionFeedbackMime,
  resolveVisionFeedbackMaxBytes,
}
