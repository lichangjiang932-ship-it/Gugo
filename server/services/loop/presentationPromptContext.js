import { createHash } from 'node:crypto'
import { resolveArtifactDeliveryTargets } from '../../../shared/artifactIntent.js'
import { PRESENTATION_PROMPT_POLICY, PRESENTATION_VISUAL_POLICY } from '../../../shared/presentationPromptPolicy.js'
import { hasEffectiveReadOnlyBoundary } from '../chatToolSelection.js'

export const PRESENTATION_RUNTIME_PROMPT_MARKER = '[PRESENTATION AUTHORING CONTRACT]'
export const PRESENTATION_RUNTIME_PROMPT = [
  PRESENTATION_RUNTIME_PROMPT_MARKER,
  PRESENTATION_PROMPT_POLICY,
  PRESENTATION_VISUAL_POLICY,
].join('\n\n')

// Exact prior host record, preserved as a fixture for checkpoint-upgrade tests.
const LEGACY_HOST_POLICY_HASHES = new Set([
  'e407b37a30228afe96c3fc2ec4c05c710f00640709fac0f122b00ec833523295',
  'd9542735bc22dca2ce627d07e1764499d5cc81572a4795bccc4ac85af0bec566',
  '5c313b0224fcda3f5f3015611d58b565e44feace4083c7eca95b817ade0c73ee',
])

function isOwnedPrompt(message) {
  if (message?.role !== 'system' || typeof message.content !== 'string') return false
  if (message.content === PRESENTATION_RUNTIME_PROMPT) return true
  // A similar prefix is not ownership: old records must match a known full hash.
  return message.content.startsWith(`${PRESENTATION_RUNTIME_PROMPT_MARKER}\n\n`)
    && LEGACY_HOST_POLICY_HASHES.has(createHash('sha256').update(message.content).digest('hex'))
}

/** Keep one stable host record across iterations, checkpoints and summaries. */
export function replacePresentationPromptContext(messages = [], { enabled = false } = {}) {
  const source = Array.isArray(messages) ? messages : []
  const ownedIndexes = []
  const policyAlreadyLoaded = source.some((message, index) => {
    if (isOwnedPrompt(message)) {
      ownedIndexes.push(index)
      return false
    }
    return message?.role === 'system' && typeof message.content === 'string'
      && message.content.includes(PRESENTATION_PROMPT_POLICY)
      && message.content.includes(PRESENTATION_VISUAL_POLICY)
  })
  if (!enabled || policyAlreadyLoaded) {
    return source.some(isOwnedPrompt) ? source.filter((message) => !isOwnedPrompt(message)) : source
  }
  if (ownedIndexes.length === 1 && source[ownedIndexes[0]].content === PRESENTATION_RUNTIME_PROMPT) return source
  if (ownedIndexes.length > 0) {
    return source.flatMap((message, index) => {
      if (!isOwnedPrompt(message)) return [message]
      return index === ownedIndexes[0] ? [{ ...message, content: PRESENTATION_RUNTIME_PROMPT }] : []
    })
  }
  const firstNonSystem = source.findIndex((message) => message?.role !== 'system')
  const index = firstNonSystem < 0 ? source.length : firstNonSystem
  return [
    ...source.slice(0, index),
    { role: 'system', content: PRESENTATION_RUNTIME_PROMPT },
    ...source.slice(index),
  ]
}

/** Reuse the existing artifact contract; this adds no tool or write authority. */
export function synchronizePresentationPromptContext(s) {
  const currentText = s.activeArtifactContractText || s.artifactAuthorizationText
  let enabled = false
  if (s.job?.origin === 'chat' && s.intentMode !== 'answer'
    && !hasEffectiveReadOnlyBoundary(currentText, s.previousUserPrompt)) {
    enabled = s.expectedArtifactTools.has('create_pptx')
    if (!enabled && s.mutationExecutionRequested) {
      const delivery = resolveArtifactDeliveryTargets(
        currentText,
        s.artifactIntentOptions,
      )
      enabled = ['patch_intent', 'mixed_intent'].includes(delivery.intent)
        && delivery.workspaceArtifactTypes.includes('pptx')
    }
  }
  s.convo = replacePresentationPromptContext(s.convo, { enabled })
}
