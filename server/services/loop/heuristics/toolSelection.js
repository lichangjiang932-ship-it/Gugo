import {
  CONNECTOR_TOOL_SPECS,
} from '../../connectorTools.js'
import {
  allowedArtifactTools,
  isFileArtifactTool,
} from '../../artifactIntent.js'
import {
  createLocalFileArtifact,
  createLocalFileArtifactAsync,
} from '../../artifactGen.js'
import fs from 'node:fs'
import {
  getBuiltinSpec,
  listBuiltinSpecs,
} from '../../toolRegistry.js'
import path from 'node:path'
import {
  resolveInWorkspace,
} from '../../../adapters/fsShellTools.js'
import {
  selectChatToolSpecs,
} from '../../chatToolSelection.js'
import {
  persistGeneratedArtifact,
} from './artifactPublishing.js'
import {
  getTurnArtifactByIdInTurn,
} from '../../turnArtifactStore.js'
import {
  getArtifactById,
} from '../../jobStore.js'
import {
  COMMAND_OUTPUT_TOOL_NAMES,
  LOCAL_ARTIFACT_TOOL_NAMES,
} from './htmlArtifactInput.js'

/**
 * TurnEngine consumes the exact same static schemas exposed by toolRegistry.
 * Connector schemas stay separate because availability is filtered per user
 * by resolveTurnToolSpecs at the beginning of every turn.
 */
export const SERVER_TOOL_SPECS = [
  ...listBuiltinSpecs(),
  ...CONNECTOR_TOOL_SPECS,
].filter(Boolean)

/**
 * 为一次运行选择稳定的工具 schema 集。生成类工具必须经过当前交付
 * 意图授权；回答/执行分类只参与其余工具的执行与完成门禁。
 */
export function selectJobToolSpecs({
  prompt = '',
  userPrompt = prompt,
  previousUserPrompt = '',
  priorArtifacts = [],
  priorArtifactTypes = [],
  hasExplicitManagedArtifactReference = false,
  skillId = undefined,
  specs = SERVER_TOOL_SPECS,
  origin = '',
  intentMode = 'auto',
  userId = null,
  metadataResolver = undefined,
  onDecision = null,
} = {}) {
  // Final-delivery selection is a server-owned chat control, not a user
  // capability toggle. Older clients and persisted settings do not know about
  // this hidden tool, so the upstream configured list can legitimately omit
  // it. Restore the canonical schema for chat turns before capability routing;
  // answer mode will still remove it as a mutating control, and non-chat jobs
  // remain unable to claim turn-owned artifacts.
  const sourceSpecs = Array.isArray(specs) ? specs : []
  const deliveryControlSpec = origin === 'chat' ? getBuiltinSpec('set_deliverables') : null
  const routedSpecs = deliveryControlSpec
    && !sourceSpecs.some((spec) => spec?.function?.name === 'set_deliverables')
    ? [...sourceSpecs, deliveryControlSpec]
    : sourceSpecs
  const allowed = allowedArtifactTools(userPrompt, {
    skillId,
    priorArtifacts,
    priorArtifactTypes,
    hasExplicitManagedArtifactReference,
  })
  const artifactFiltered = routedSpecs.filter((spec) => {
    const name = spec?.function?.name
    if (!name) return false
    // Final-delivery selection is scoped to a persisted chat turn. Background
    // jobs have a different artifact owner (job/step) and must not be allowed
    // to claim turn artifacts through this control tool.
    if (name === 'set_deliverables' && origin !== 'chat') return false
    return !isFileArtifactTool(name) || allowed.has(name)
  })
  const artifactSelectedNames = new Set(artifactFiltered.map((spec) => spec?.function?.name).filter(Boolean))
  const artifactExcludedTools = routedSpecs
    .map((spec) => String(spec?.function?.name || '').trim())
    .filter((name) => name && !artifactSelectedNames.has(name))
    .map((name) => ({
      name,
      stage: 'artifact_contract',
      reason: name === 'set_deliverables'
        ? 'turn_artifact_control_not_available'
        : 'artifact_contract_not_requested',
    }))
  if (origin === 'chat') {
    let chatDecision = null
    const selected = selectChatToolSpecs({
      prompt,
      userPrompt,
      previousUserPrompt,
      specs: artifactFiltered,
      intentMode,
      executionRequired: allowed.size > 0,
      userId,
      ...(metadataResolver ? { metadataResolver } : {}),
      onDecision: (decision) => { chatDecision = decision },
    })
    if (typeof onDecision === 'function') {
      try {
        onDecision({
          ...(chatDecision || {}),
          excludedTools: [
            ...artifactExcludedTools,
            ...(Array.isArray(chatDecision?.excludedTools) ? chatDecision.excludedTools : []),
          ].slice(0, 256),
        })
      } catch {
        // Diagnostics are advisory and must never block tool selection.
      }
    }
    return selected
  }
  if (typeof onDecision === 'function') {
    try {
      onDecision({
        version: 1,
        capabilityMode: 'job',
        intentToolNames: [],
        eligibleToolNames: routedSpecs.map((spec) => spec?.function?.name).filter(Boolean).sort().slice(0, 256),
        selectedToolNames: artifactFiltered.map((spec) => spec?.function?.name).filter(Boolean).sort().slice(0, 256),
        excludedTools: artifactExcludedTools.slice(0, 256),
      })
    } catch {
      // Diagnostics are advisory and must never block tool selection.
    }
  }
  return artifactFiltered
}

export function localArtifactCandidates(call, result) {
  if (call?.name === 'write_file' || call?.name === 'file_download') {
    return [{ path: result?.path || call?.args?.path, scope: result?.scope }]
  }
  if (call?.name === 'image_transform') {
    return [{ path: result?.path || call?.args?.output_path, scope: result?.scope }]
  }
  if (call?.name === 'media_transform') {
    return [{
      path: result?.path || result?.output_path || call?.args?.output_path,
      scope: result?.scope,
    }]
  }
  if (call?.name === 'pdf_transform') {
    return (Array.isArray(result?.outputs) ? result.outputs : [])
      .map((output) => ({ path: output?.path, scope: output?.scope }))
  }
  if (call?.name === 'archive_create') {
    return [{ path: result?.output || call?.args?.output, scope: result?.scope }]
  }
  if (!COMMAND_OUTPUT_TOOL_NAMES.has(call?.name)) return []
  return (Array.isArray(result?.verifiedOutputs) ? result.verifiedOutputs : [])
    .filter((output) => output?.type === 'file')
}

export function resolveLocalArtifactSource(candidate, call, result) {
  const reported = String(candidate?.path || '').trim()
  const declared = String(candidate?.declaredPath || '').trim()
  if (reported && path.isAbsolute(reported)) return reported
  if (candidate?.scope === 'workspace' && reported) return resolveInWorkspace(reported)
  if (declared && path.isAbsolute(declared)) return declared
  const cwd = String(result?.cwd || call?.args?.cwd || '').trim()
  if (cwd && path.isAbsolute(cwd)) return path.resolve(cwd, declared || reported)
  return resolveInWorkspace(reported || declared)
}

export function localArtifactPublicationKey({ call, job, step, candidateIndex = 0, toolCallId = '' } = {}) {
  const ownerId = String(job?.userId || '').trim()
  const callId = String(toolCallId || call?.id || '').trim()
  const jobId = String(job?.id || '').trim()
  if (!ownerId || !callId || !jobId) return ''
  const index = Math.max(0, Math.floor(Number(candidateIndex) || 0))
  if (job?.origin === 'chat') {
    const sessionId = String(job?.sessionId || '').trim()
    if (!sessionId) return ''
    return JSON.stringify(['local-tool-artifact-v1', ownerId, 'turn', sessionId, jobId, callId, index])
  }
  const stepId = String(step?.id || '').trim()
  // Background jobs need a step identity to distinguish repeated call ids.
  // Without it, fall back to unique publication instead of claiming a stable
  // key that can alias an artifact produced by a different step.
  if (!stepId) return ''
  return JSON.stringify([
    'local-tool-artifact-v1', ownerId, 'job', jobId, stepId, callId, index,
  ])
}

function localArtifactPublicationFailure(error, { candidateIndex, sourcePath }) {
  const causeCode = String(error?.code || 'UNKNOWN').slice(0, 80)
  const sourceMissing = ['ENOENT', 'ENOTDIR'].includes(causeCode)
  return {
    code: 'artifact_publication_failed',
    causeCode,
    candidateIndex,
    filename: path.basename(String(sourcePath || '')) || null,
    retryable: !sourceMissing && error?.retryable === true,
    message: sourceMissing
      ? 'The local output disappeared before its downloadable copy could be published. Do not rerun the source tool automatically.'
      : `The local output was created, but the artifact store could not publish it (${causeCode}). Do not rerun the source tool automatically.`,
  }
}

function attachLocalArtifactPublicationFailures(artifacts, failures) {
  Object.defineProperty(artifacts, 'publicationFailures', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze(failures.map((failure) => Object.freeze({ ...failure }))),
  })
  return artifacts
}

function persistedLocalArtifact({ artifact, job, step }) {
  const existing = job?.origin === 'chat'
    ? getTurnArtifactByIdInTurn({
        id: artifact?.id,
        userId: job?.userId,
        sessionId: job?.sessionId,
        turnId: job?.id,
      })
    : getArtifactById(artifact?.id)
  if (!existing
    || existing.userId !== job?.userId
    || existing.id !== artifact?.id
    || existing.filename !== artifact?.filename
    || existing.url !== artifact?.url
    || existing.type !== artifact?.type) return null
  if (job?.origin !== 'chat'
    && (existing.jobId !== job?.id || (existing.stepId || null) !== (step?.id || null))) return null
  return { ...artifact, ...existing }
}

export function persistLocalToolArtifacts({ call, result, job, step }) {
  if (result?.ok !== true || !LOCAL_ARTIFACT_TOOL_NAMES.has(call?.name)) return []
  const persisted = []
  const seen = new Set()
  for (const candidate of localArtifactCandidates(call, result)) {
    let artifact = null
    try {
      const sourcePath = resolveLocalArtifactSource(candidate, call, result)
      const key = process.platform === 'win32' ? sourcePath.toLowerCase() : sourcePath
      if (seen.has(key)) continue
      seen.add(key)
      artifact = createLocalFileArtifact({ sourcePath, filename: path.basename(sourcePath) })
      persistGeneratedArtifact({ artifact, args: { title: artifact.title }, job, step })
      persisted.push(artifact)
    } catch {
      if (artifact?.fullPath) {
        try { fs.unlinkSync(artifact.fullPath) } catch { /* best-effort orphan cleanup */ }
      }
      // A successful tool result remains successful if an output disappears
      // before it can be copied or has no safe downloadable filename.
    }
  }
  return persisted
}

export async function persistLocalToolArtifactsAsync({ call, result, job, step, toolCallId = '' }) {
  if (result?.ok !== true || !LOCAL_ARTIFACT_TOOL_NAMES.has(call?.name)) {
    return attachLocalArtifactPublicationFailures([], [])
  }
  const persisted = []
  const publicationFailures = []
  const seen = new Set()
  const candidates = localArtifactCandidates(call, result)
  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
    const candidate = candidates[candidateIndex]
    let artifact = null
    let sourcePath = ''
    try {
      sourcePath = resolveLocalArtifactSource(candidate, call, result)
      const key = process.platform === 'win32' ? sourcePath.toLowerCase() : sourcePath
      if (seen.has(key)) continue
      seen.add(key)
      const publicationKey = localArtifactPublicationKey({ call, job, step, candidateIndex, toolCallId })
      artifact = await createLocalFileArtifactAsync({
        sourcePath,
        filename: path.basename(sourcePath),
        publicationKey,
      })
      try {
        persistGeneratedArtifact({ artifact, args: { title: artifact.title }, job, step })
        persisted.push(artifact)
      } catch (error) {
        const existing = artifact.idempotentPublication
          ? persistedLocalArtifact({ artifact, job, step })
          : null
        if (!existing) throw error
        persisted.push(existing)
      }
    } catch (error) {
      if (artifact?.fullPath && !artifact.idempotentPublication) {
        try { await fs.promises.unlink(artifact.fullPath) } catch { /* best-effort orphan cleanup */ }
      }
      publicationFailures.push(localArtifactPublicationFailure(error, { candidateIndex, sourcePath }))
      // Preserve the successful source operation, but surface publication as a
      // separate failure so the runtime never claims a downloadable artifact.
    }
  }
  return attachLocalArtifactPublicationFailures(persisted, publicationFailures)
}

export const selectToolSpecs = selectJobToolSpecs
