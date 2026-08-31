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
import { allowedArtifactTools, isExplicitCodeSnippetRequest } from './artifactIntent.js'
import { ensureSafetySystemMessages } from './promptCompiler.js'
import { injectJobPromptContext, resolveJobSkillContext } from './jobPromptContext.js'
import {
  buildArtifactPrompt,
  buildCitationPrompt,
  buildCodeWorkflowPrompt,
  buildDelayedFollowupPrompt,
} from './jobPromptBlocks.js'
import {
  buildFinalOutput,
  buildPlanningBrief,
  buildPriorStepsContext,
  buildVerificationPrompt,
  shouldCompileDocx,
} from './jobWorkflow.js'
import { buildTextStepResult, buildToolStepResult } from './jobAcceptanceRuntime.js'
import { createTaskReviewer } from './taskReviewer.js'
import { createJobRuntimeCore } from './runtimeCore.js'
import { getDefaultOutputDirectory, getProjectDirectory } from './localFileAccessService.js'
import { markJobAwaitingApproval, markJobRunningAgain } from './jobRuntimeLifecycle.js'
import { readJobModelRequestRecoveryResolution } from './jobModelRequestRecoveryService.js'
import { buildUserModelEnv } from './modelProviderStore.js'
import {
  createJobLoopModelBridge,
  runDefaultJobModel,
  runDefaultJobModelWithTools,
} from './jobModelExecutionRuntime.js'
import { filterLiveJobDirectoryAuthorizationCheckpoint } from './jobCheckpointAuthorizationRuntime.js'

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
          paragraphs: generatedTexts.map((text, index) => ({
            heading: index === 0 ? 1 : 2,
            text,
          })),
        })
        try {
          await validateGeneratedArtifact({
            filePath: artifact?.fullPath,
            filename: artifact?.filename,
            toolName: 'create_docx',
            artifactType: artifact?.type || 'docx',
          })
        } catch (error) {
          try {
            discardInvalidGeneratedArtifact({
              filePath: artifact?.fullPath,
              artifactDirectory,
            })
          } catch {
            // Cleanup is best-effort and must not replace the validation error.
          }
          throw error
        }
        appendJobArtifact({
          id: artifact.id,
          jobId: job.id,
          userId: job.userId,
          stepId: step.id,
          type: artifact.type,
          title: artifact.title || job.title,
          url: artifact.url,
          filename: artifact.filename,
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

    const { skillId, userPrompt, skill } = resolveJobSkillContext({ prompt: job.prompt, userId: job.userId })
    const messages = ensureSafetySystemMessages([])

    // ★ 产物意图决定提示词分支(2026-07-31 事故修复)。
    //   以前这段提示词无条件注入 —— 修 bug 的任务里也常驻 7 条「PPT 必守规则」
    //   外加一句「不要把内容写成纯文本回答」,等于在推模型把中期汇报做成 PPT。
    //   现在:用户没要文件,就一个字都不提文件工具;要了哪种,才注入哪种的规则。
    const artifactTools = allowedArtifactTools(job.prompt, { skillId })
    const { specs: mcpToolSpecs } = enableServerTools
      ? await listUserToolSpecs(job.userId)
      : { specs: [] }
    const browserToolSpecs = enableServerTools ? listRegisteredBrowserToolSpecs() : []
    const runtimeToolSpecs = enableServerTools
      ? listAllSpecs({ userId: job.userId }).filter((entry) => entry?.origin === 'plugin').map((entry) => entry?.tool) : []
    const visibleJobToolSpecs = [...new Map(
      [...SERVER_TOOL_SPECS, ...mcpToolSpecs, ...browserToolSpecs, ...runtimeToolSpecs]
        .filter((spec) => spec?.function?.name)
        .map((spec) => [spec.function.name, spec]),
    ).values()]
    // Background jobs do not carry TurnEngine's file-access snapshot, but they
    // must still honor the same deployment and per-user capability policy
    // before a schema reaches the model. With no snapshot, workspace tools keep
    // their existing Job behavior while run_code uses the authoritative runtime
    // trust predicate and every explicit user tool override remains enforced.
    const policyVisibleJobToolSpecs = projectToolSpecsForRuntimePolicy(visibleJobToolSpecs, {
      userId: job.userId,
    })
    const jobToolSpecs = selectToolSpecs({
      prompt: job.prompt,
      skillId,
      specs: policyVisibleJobToolSpecs,
      userId: job.userId,
    })
    let outputDirectoryContext = {}
    try {
      outputDirectoryContext = {
        defaultOutputDirectory: getDefaultOutputDirectory({ userId: job.userId }),
        projectDirectory: getProjectDirectory({ userId: job.userId }),
      }
    } catch {
      // Optional prompt context must not block job execution.
    }

    if (enableServerTools) {
      // 提示词分支和工具集裁剪必须用同一份判定(见 toolLoopRuntime 里的注释),
      // 这里按顺序注入:产物规则 → 代码工作流 → 引用/链接引导 → 延迟唤醒。
      messages.push({
        role: 'system',
        content: buildArtifactPrompt(artifactTools, {
          codeSnippetRequested: isExplicitCodeSnippetRequest(userPrompt || job.prompt),
          ...outputDirectoryContext,
        }),
      })
      messages.push({ role: 'system', content: buildCodeWorkflowPrompt() })
      messages.push({ role: 'system', content: buildCitationPrompt() })
      messages.push({ role: 'system', content: buildDelayedFollowupPrompt() })
    }
    const promptSuffix = step.kind === 'batch_item'
      ? `\n\n这是批量任务中的第 ${step.input?.index || 1} / ${step.input?.total || 1} 项,请只完成这一项。`
      : ''

    // ★ Harness: 把已完成步骤的结论带进本步上下文。
    // 以前每一步都是从 job.prompt 重新起一个 zero-shot 调用 —— 上一步的
    // 工具循环结论在步骤边界就丢了,模型看不到自己刚做过什么,
    // 多步任务实际退化成 N 个互不相干的单步任务。这是任务成功率的最大杀手。
    const priorContext = buildPriorStepsContext(job.steps || [], step.id)
    if (priorContext) messages.push({ role: 'system', content: priorContext })

    const finalPrompt = step.kind === 'verify'
      ? buildVerificationPrompt(job, step)
      : `${userPrompt || job.prompt}${promptSuffix}`
    injectJobPromptContext({ messages, job, skill, skillId, query: finalPrompt, preparePromptContext })
    messages.push({ role: 'user', content: finalPrompt })

    if (enableServerTools) {
      const checkpointEnabled = !!(
        job?.id
        && job?.userId
        && step?.id
        && getJobRow(job.id, { userId: job.userId })
      )
      const loopModel = createJobLoopModelBridge({
        job, step, selectedModel, modelEnv, runModelWithTools,
        readModelRequestResolution, reconcileModelRequest,
      })
      const result = await runToolLoop({
        job,
        step,
        messages,
        // 提示词分支和工具集裁剪必须用同一份判定,否则会出现
        // 「提示词说没有文件工具、工具列表里却还躺着 create_pptx」的错位。
        toolSpecs: jobToolSpecs,
        // Planner step kinds are already a trusted execution decision. Do not
        // send execute/batch work back through a verb heuristic: prompts such
        // as "send a Slack message" otherwise accept prose as completion even
        // though no tool ever ran.
        intentMode: ['execute', 'batch_item'].includes(step.kind) ? 'execute' : 'auto',
        runModel: loopModel.run,
        reconcileModelRequest: loopModel.reconcile,
        signal,
        onApprovalPending: () => markJobAwaitingApproval(job),
        onApprovalResolved: () => markJobRunningAgain(job),
        claimSteering,
        acknowledgeSteering,
        releaseSteering,
        loadCheckpoint: checkpointEnabled
          ? async () => filterLiveJobDirectoryAuthorizationCheckpoint(
              await runtimeCore.checkpoint.load({ jobId: job.id, stepId: step.id, userId: job.userId }),
              { userId: job.userId },
            )
          : null,
        saveCheckpoint: checkpointEnabled
          ? (state, metadata = {}) => {
              const save = () => runtimeCore.checkpoint.save(
                { jobId: job.id, stepId: step.id, userId: job.userId },
                state,
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
      // ★ 修:以前这里只取 text/artifactIds/iterations,把 paused / budgetExceeded
      // 静默丢掉 → 被澄清打断或预算耗尽的截断运行会上报 ok:true 假装成功。
      // 现在如实透传,截断就是截断。
      //
      // interrupted = the model failed after partial progress; the shared loop returned a safe partial result.
      // 同样算截断,但**不算 failed** —— 用户能看到已经做完的部分。
      if (result.paused && checkpointEnabled) {
        const makeResumable = () => runtimeCore.checkpoint.makeResumable({
          jobId: job.id, stepId: step.id, userId: job.userId,
        })
        const saved = typeof commitCheckpoint === 'function' ? commitCheckpoint(makeResumable) : makeResumable()
        if (!saved) throw new Error('Failed to persist resumable job turn checkpoint')
      }
      return buildToolStepResult({ job, step, result, taskEvaluator: evaluateCurrentStep })
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
    return buildTextStepResult({ job, step, text, taskEvaluator: evaluateCurrentStep })
  }
}
