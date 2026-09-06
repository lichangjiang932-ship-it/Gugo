import { replaceCompactionSummary, validateToolCallChain } from './compactionService.js'
import {
  COMPACTION_ARCHIVE_METADATA_RESERVE_TOKENS, MIN_COMPACTION_SUMMARY_TOKENS,
  boundCompactionSummary, estimateContextTokens, textTokens,
} from './contextCompactionMetrics.js'

function archivedTokenCount(result) {
  return (Array.isArray(result?.archivedMessages) ? result.archivedMessages : [])
    .reduce((total, message) => total + 6 + textTokens(message), 0)
}

export function fitCompactionResult(result, {
  tools,
  threshold,
  summaryTokenLimit,
  reserveTokens = COMPACTION_ARCHIVE_METADATA_RESERVE_TOKENS,
} = {}) {
  const archivedTokens = archivedTokenCount(result)
  const emptySummaryTokens = 6 + textTokens({ ...result.summaryMessage, content: '' })
  let budget = Math.min(
    summaryTokenLimit,
    Math.max(0, archivedTokens - emptySummaryTokens - 1),
  )
  const target = Math.max(1, threshold - Math.max(0, reserveTokens))
  let bestResult = result
  let bestEstimate = estimateContextTokens(result.outboundMessages, tools)
  let truncated = false

  for (let attempt = 0; attempt < 5 && budget >= MIN_COMPACTION_SUMMARY_TOKENS; attempt += 1) {
    const summaryText = boundCompactionSummary(result.summaryText, { maxTokens: budget })
    const candidate = replaceCompactionSummary(result, summaryText)
    const estimatedTokens = estimateContextTokens(candidate.outboundMessages, tools)
    const summaryTokens = 6 + textTokens(candidate.summaryMessage)
    const chain = validateToolCallChain(candidate.outboundMessages)
    if (estimatedTokens < bestEstimate) {
      bestResult = candidate
      bestEstimate = estimatedTokens
    }
    truncated ||= summaryText !== result.summaryText
    if (chain.ok && estimatedTokens < target && summaryTokens < archivedTokens) {
      return {
        ok: true,
        result: candidate,
        estimatedTokens,
        summaryTokens,
        summaryTruncated: truncated,
      }
    }
    const overflow = Math.max(
      1,
      estimatedTokens - target + 1,
      summaryTokens - archivedTokens + 1,
    )
    budget = Math.floor(budget - overflow - 4)
  }

  return {
    ok: false,
    reduced: (() => {
      const summaryTokens = 6 + textTokens(bestResult.summaryMessage)
      return validateToolCallChain(bestResult.outboundMessages).ok && summaryTokens < archivedTokens
    })(),
    result: bestResult,
    estimatedTokens: bestEstimate,
    summaryTokens: 6 + textTokens(bestResult.summaryMessage),
    summaryTruncated: truncated,
    error: bestEstimate >= target
      ? `compacted outbound context still needs ${bestEstimate} tokens (budget ${target})`
      : 'compaction summary was not smaller than the archived surface',
  }
}
