import {
  appendJobArtifact,
  getJob as getJobRow,
  getJobWithChildren,
} from './jobStore.js'
import { createDocx } from './artifactGen.js'
import {
  discardInvalidGeneratedArtifactFile,
  validateGeneratedArtifactFile,
} from './generatedArtifactFormatValidation.js'
import { getArtifactDir } from './artifactStorage.js'
import { getModelContextWindow } from '../adapters/modelProxy.js'
import { reconcileModelRequestWithProvider } from '../adapters/modelRequestReconciler.js'
import { runToolLoop } from './loop/index.js'
import { selectToolSpecs, SERVER_TOOL_SPECS } from './toolLoopRuntime.js'
import { listUserToolSpecs } from '../mcp/mcpManager.js'
import { listRegisteredBrowserToolSpecs } from './browserTools.js'
import { listAllSpecs } from './toolRegistry.js'
import { projectToolSpecsForRuntimePolicy } from './turnToolSpecs.js'
import { allowedArtifactTools } from './artifactIntent.js'
import { buildJobStepPromptMessages, resolveJobSkillContext } from './jobPromptContext.js'
import { assertPromptContextActive } from './backgroundMemoryQuery.js'
import {
  buildFinalOutput,
  buildPlanningBrief,
  shouldCompileDocx,
} from './jobWorkflow.js'
import { buildTextStepResult, buildToolStepResult } from './jobAcceptanceRuntime.js'
import { createTaskReviewer } from './taskReviewer.js'
import { createJobRuntimeCore } from './runtimeCore.js'
import { markJobAwaitingApproval, markJobRunningAgain } from './jobRuntimeLifecycle.js'
import { readJobModelRequestRecoveryResolution } from './jobModelRequestRecoveryService.js'
import { buildUserModelEnv } from './modelProviderStore.js'
import {
  createJobLoopModelBridge,
  runDefaultJobModel,
  runDefaultJobModelWithTools,
} from './jobModelExecutionRuntime.js'
import { filterLiveJobDirectoryAuthorizationCheckpoint } from './jobCheckpointAuthorizationRuntime.js'

async function executeFinalizeJobStep({
  job,
  step,
  createDocxImpl,
  validateGeneratedArtifact,
  discardInvalidGeneratedArtifact,
  artifactDirectory,
}) {
  let finalOutput = buildFinalOutput(job)
  const generatedTexts = (job.steps || [])
    .filter((item) => ['execute', 'batch_item'].includes(item.kind))
    .map((item) => item.output?.text)
    .filter(Boolean)
  const hasOwnedDocxArtifact = (Array.isArray(job.artifacts) ? job.artifacts : []).some((artifact) => (
    artifact?.jobId === job.id
    && artifact?.userId === job.userId
    && String(artifact?.type || '').trim().toLowerCase() === 'docx'
  ))
  if (generatedTexts.length && shouldCompileDocx(job.prompt) && !hasOwnedDocxArtifact) {
    const artifact = await createDocxImpl({
      title: job.title,
      paragraphs: generatedTexts.map((text, index) => ({ heading: index === 0 ? 1 : 2, text })),
    })
    try {
      await validateGeneratedArtifact({
        filePath: artifact?.fullPath,
        filename: artifact?.filename,
        toolName: 'create_docx',
        artifactType: artifact?.type || 'docx',
      })
    } catch (error) {
      try { discardInvalidGeneratedArtifact({ filePath: artifact?.fullPath, artifactDirectory }) }
      catch { /* cleanup must not replace validation failure */ }
      throw error
    }
    appendJobArtifact({
      id: artifact.id, jobId: job.id, userId: job.userId, stepId: step.id,
      type: artifact.type, title: artifact.title || job.title,
      url: artifact.url, filename: artifact.filename,
    })
    const refreshedJob = getJobWithChildren(job.id) || {
      ...job,
      artifacts: [...(job.artifacts || []), artifact],
    }
    finalOutput = buildFinalOutput(refreshedJob)
  }
  return {
    ok: finalOutput.complete !== false,
    error: finalOutput.complete === false ? finalOutput.summary : null,
    acceptance: finalOutput.acceptance || null,
    output: { phase: 'finalize', ...finalOutput },
  }
}

async function resolveJobToolCatalog({ enableServerTools, job, skillId }) {
  const artifactTools = allowedArtifactTools(job.prompt, { skillId })
  if (!enableServerTools) return { artifactTools, jobToolSpecs: [] }
  const { specs: mcpToolSpecs } = await listUserToolSpecs(job.userId)
  const browserToolSpecs = listRegisteredBrowserToolSpecs()
  const runtimeToolSpecs = listAllSpecs({ userId: job.userId })
    .filter((entry) => entry?.origin === 'plugin')
    .map((entry) => entry?.tool)
  const visible = [...new Map(
    [...SERVER_TOOL_SPECS, ...mcpToolSpecs, ...browserToolSpecs, ...runtimeToolSpecs]
      .filter((spec) => spec?.function?.name)
      .map((spec) => [spec.function.name, spec]),
  ).values()]
  const policyVisible = projectToolSpecsForRuntimePolicy(visible, { userId: job.userId })
  return {
    artifactTools,
    jobToolSpecs: selectToolSpecs({
      prompt: job.prompt, skillId, specs: policyVisible, userId: job.userId,
    }),
  }
}

async function executeJobToolStep({
  job,
  step,
  messages,
  jobToolSpecs,
  selectedModel,
  modelEnv,
  runModelWithTools,
  readModelRequestResolution,
  reconcileModelRequest,
  signal,
  claimSteering,
  acknowledgeSteering,
  releaseSteering,
  runtimeCore,
  commitCheckpoint,
  evaluateCurrentStep,
  checkpointContext,
  promptContext,
}) {
  const checkpointEnabled = checkpointContext.enabled
  const loopModel = createJobLoopModelBridge({
    job, step, selectedModel, modelEnv, runModelWithTools,
    readModelRequestResolution, reconcileModelRequest,
  })
  const result = await runToolLoop({
    job,
    step,
    messages,
    toolSpecs: jobToolSpecs,
    intentMode: ['execute', 'batch_item'].includes(step.kind) ? 'execute' : 'auto',
    runModel: loopModel.run,
    reconcileModelRequest: loopModel.reconcile,
    signal,
    onApprovalPending: (approval) => markJobAwaitingApproval(job, step, approval),
    onApprovalResolved: (decision) => markJobRunningAgain(job, step, decision),
    claimSteering,
    acknowledgeSteering,
    releaseSteering,
    loadCheckpoint: checkpointEnabled
      ? async () => filterLiveJobDirectoryAuthorizationCheckpoint(
          checkpointContext.loaded,
          { userId: job.userId },
        )
      : null,
    saveCheckpoint: checkpointEnabled
      ? (state, metadata = {}) => {
          const save = () => runtimeCore.checkpoint.save(
            { jobId: job.id, stepId: step.id, userId: job.userId },
            { ...state, promptContext: {
              memoryIds: promptContext.memoryIds || [], memoryDiagnostics: promptContext.memoryDiagnostics || null,
            } },
            { checkpointWriteSequence: metadata.checkpointWriteSequence },
          )
          return typeof commitCheckpoint === 'function' ? commitCheckpoint(save) : save()
        }
      : null,
    contextWindow: getModelContextWindow({
      modelName: selectedModel,
      env: modelEnv || buildUserModelEnv({ userId: job.userId }),
    }),
  })
  if (result.paused && checkpointEnabled) {
    const makeResumable = () => runtimeCore.checkpoint.makeResumable({
      jobId: job.id, stepId: step.id, userId: job.userId,
    })
    const saved = typeof commitCheckpoint === 'function' ? commitCheckpoint(makeResumable) : makeResumable()
    if (!saved) throw new Error('Failed to persist resumable job turn checkpoint')
  }
  return buildToolStepResult({ job, step, result, taskEvaluator: evaluateCurrentStep })
}

export function createDefaultExecuteStep({
  runModel = runDefaultJobModel,
  runModelWithTools = runDefaultJobModelWithTools,
  createDocxImpl = createDocx,
  validateGeneratedArtifact = validateGeneratedArtifactFile,
  discardInvalidGeneratedArtifact = discardInvalidGeneratedArtifactFile,
  artifactDirectory = getArtifactDir(),
  enableServerTools = true,
  preparePromptContext,
  runtimeCore = createJobRuntimeCore(),
  taskEvaluator = createTaskReviewer(),
  reconcileModelRequest = reconcileModelRequestWithProvider,
  readModelRequestResolution = readJobModelRequestRecoveryResolution,
} = {}) {
  return async function defaultExecuteStep({
    job,
    step,
    signal,
    claimSteering = null,
    acknowledgeSteering = null,
    releaseSteering = null,
    commitCheckpoint = null,
    modelEnv = null,
  }) {
    const selectedModel = String(job?.modelName || '').trim() || undefined
    const evaluateCurrentStep = (input) => taskEvaluator({
      ...input,
      signal,
      workerModelName: selectedModel,
      modelEnv,
    })
    if (step.kind === 'plan') {
      const text = buildPlanningBrief(job)
      return {
        ok: true,
        output: { phase: 'plan', text, summary: `已规划任务:${job.title}` },
      }
    }

    if (step.kind === 'finalize') {
      return executeFinalizeJobStep({
        job,
        step,
        createDocxImpl,
        validateGeneratedArtifact,
        discardInvalidGeneratedArtifact,
        artifactDirectory,
      })
    }

    assertPromptContextActive(signal)
    modelEnv = Object.freeze({ ...(modelEnv || buildUserModelEnv({ userId: job.userId })) })
    const checkpointEnabled = !!(enableServerTools && job?.id && job?.userId && step?.id
      && getJobRow(job.id, { userId: job.userId }))
    const loadedCheckpoint = checkpointEnabled
      ? await runtimeCore.checkpoint.load({ jobId: job.id, stepId: step.id, userId: job.userId }) : null

    const { skillId, userPrompt, skill } = resolveJobSkillContext({ prompt: job.prompt, userId: job.userId })
    const { artifactTools, jobToolSpecs } = await resolveJobToolCatalog({
      enableServerTools,
      job,
      skillId,
    })
    const { messages, finalPrompt, promptContext } = await buildJobStepPromptMessages({
      job, step, skill, skillId, userPrompt, artifactTools, enableServerTools,
      preparePromptContext, modelEnv, signal, loadedCheckpoint,
    })

    if (enableServerTools) {
      const result = await executeJobToolStep({
        job,
        step,
        messages,
        jobToolSpecs,
        selectedModel,
        modelEnv,
        runModelWithTools,
        readModelRequestResolution,
        reconcileModelRequest,
        signal,
        claimSteering,
        acknowledgeSteering,
        releaseSteering,
        runtimeCore,
        commitCheckpoint,
        evaluateCurrentStep,
        checkpointContext: { enabled: checkpointEnabled, loaded: loadedCheckpoint },
        promptContext,
      })
      return withPromptContextDiagnostics(result, promptContext)
    }

    // 兼容路径:enableServerTools=false 时退回纯文本(老行为)
    const text = await runModel({
      job,
      step,
      messages,
      userPrompt: finalPrompt,
      skill,
      signal,
      userId: job.userId,
      modelName: selectedModel,
      modelEnv,
    })
    const result = await buildTextStepResult({ job, step, text, taskEvaluator: evaluateCurrentStep })
    return withPromptContextDiagnostics(result, promptContext)
  }
}

function withPromptContextDiagnostics(result, context) {
  return { ...result, output: { ...result.output, promptContext: {
    memoryIds: context.memoryIds || [], memoryDiagnostics: context.memoryDiagnostics || null,
  } } }
}
