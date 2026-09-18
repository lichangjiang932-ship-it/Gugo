/**
 * Local prompt-prefix fingerprints.
 *
 * Providers report their own cache-read tokens when they support it, but not
 * every provider does (see the accepted streaming-usage gap), and a provider
 * hit rate never tells you *why* a prefix changed. These fingerprints are the
 * provider-independent signal: the stable prefix must stay byte-identical for a
 * KV/prefix cache to have any chance of hitting, so any change there is a
 * cache-invalidating change worth catching in review.
 *
 * Pure functions: no DB, no I/O, no logging.
 */
import { createHash } from 'node:crypto'
import { canonicalizeModelTools } from '../adapters/modelRequestCache.js'

export const PROMPT_PREFIX_SCHEMA_VERSION = 1
const RUNTIME_PROMPT_SNAPSHOT_VERSION = 2
const RUNTIME_COMPARISON_SCOPE = 'within_turn'

function digest(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex')
}

function blockText(block) {
  if (typeof block === 'string') return block
  const content = block?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'string' ? part : String(part?.text || ''))).join('\n')
  }
  return ''
}

/** A stable block counts only when it actually rendered text. */
function hasRenderedText(block) {
  const value = block?.text ?? block?.content
  return typeof value === 'string' && value.length > 0
}

/**
 * @param {{blocks?: object[], stableBlocks?: object[], stableBlockCount?: number}} input
 * @returns {{version: number, stablePrefixFingerprint: string|null, fullFingerprint: string, stableBlockCount: number, blockCount: number}}
 */
export function fingerprintPromptBlocks({ blocks = [], stableBlocks = null, stableBlockCount = 0 } = {}) {
  const list = Array.isArray(blocks) ? blocks : []
  // `stableBlocks` is the ordered list of candidate blocks that must not
  // drift; blocks that were not rendered (null/empty text) simply do not count.
  const declared = Array.isArray(stableBlocks)
    ? stableBlocks.filter(hasRenderedText).length
    : Number(stableBlockCount) || 0
  const stable = Math.min(Math.max(0, declared), list.length)
  return Object.freeze({
    version: PROMPT_PREFIX_SCHEMA_VERSION,
    stablePrefixFingerprint: stable > 0
      ? digest(JSON.stringify(list.slice(0, stable).map(blockText)))
      : null,
    fullFingerprint: digest(JSON.stringify(list.map(blockText))),
    stableBlockCount: stable,
    blockCount: list.length,
  })
}

export function comparePromptPrefixes(previous, current) {
  if (!previous || !current) return Object.freeze({ comparable: false, stable: null, changed: null })
  // With no stable prefix there is nothing to keep warm, so a "stable: true"
  // here would be a false reassurance. Report it as not comparable instead.
  const comparable = previous.stablePrefixFingerprint != null
    && current.stablePrefixFingerprint != null
    && Number(previous.stableBlockCount) === Number(current.stableBlockCount)
  const stable = comparable
    ? previous.stablePrefixFingerprint === current.stablePrefixFingerprint
    : null
  return Object.freeze({
    comparable,
    stable,
    changed: previous.fullFingerprint !== current.fullFingerprint,
    previousStableBlockCount: Number(previous.stableBlockCount) || 0,
    currentStableBlockCount: Number(current.stableBlockCount) || 0,
  })
}

function usableRuntimeSnapshot(value) {
  return value?.version === RUNTIME_PROMPT_SNAPSHOT_VERSION
    && value.comparisonScope === RUNTIME_COMPARISON_SCOPE
    && /^[a-f0-9]{64}$/u.test(String(value.fullFingerprint || ''))
    && /^[a-f0-9]{64}$/u.test(String(value.toolsFingerprint || ''))
    && (value.stablePrefixFingerprint === null || /^[a-f0-9]{64}$/u.test(String(value.stablePrefixFingerprint || '')))
    && Number.isSafeInteger(value.stableBlockCount) && value.stableBlockCount >= 0
}

/** Application-context observations, not a claim about the provider's final tokenization or KV hits. */
export function describeRuntimePrompt({ messages = [], tools = [], previous = null } = {}) {
  const list = Array.isArray(messages) ? messages : []
  const toolList = Array.isArray(tools) ? canonicalizeModelTools(tools) : []
  let stableBlockCount = 0
  while (list[stableBlockCount]?.role === 'system'
    && list[stableBlockCount].__gugoPromptStability === 'stable') stableBlockCount += 1
  const prefix = fingerprintPromptBlocks({ blocks: list, stableBlockCount })
  const snapshot = Object.freeze({ version: RUNTIME_PROMPT_SNAPSHOT_VERSION,
    comparisonScope: RUNTIME_COMPARISON_SCOPE, stablePrefixFingerprint: prefix.stablePrefixFingerprint,
    stableBlockCount, fullFingerprint: digest(JSON.stringify(list)), toolsFingerprint: digest(JSON.stringify(toolList)) })
  const prior = usableRuntimeSnapshot(previous) ? previous : null
  const comparison = comparePromptPrefixes(prior, snapshot)
  return { snapshot, diagnostics: Object.freeze({
    version: 1, stage: 'pre_compaction', comparisonScope: RUNTIME_COMPARISON_SCOPE,
    stablePrefixFingerprint: snapshot.stablePrefixFingerprint,
    contextFingerprint: snapshot.fullFingerprint, toolsFingerprint: snapshot.toolsFingerprint,
    stableBlockCount, messageCount: list.length, toolCount: toolList.length,
    prefixComparable: comparison.comparable,
    stablePrefixChanged: comparison.comparable ? !comparison.stable : null,
    toolsChanged: prior ? prior.toolsFingerprint !== snapshot.toolsFingerprint : null,
  }) }
}
