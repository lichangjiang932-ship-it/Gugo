import { normalizeOptionalTokenCount } from '../../../lib/contextUsage.js'

function compactTokens(value) {
  const tokens = Math.max(0, Number(value) || 0)
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1))}M`
  if (tokens >= 1_000) return `${Number((tokens / 1_000).toFixed(tokens >= 100_000 ? 0 : 1))}K`
  return Math.round(tokens).toLocaleString()
}

function UsageRow({ color, label, value }) {
  return (
    <div className="flex items-center gap-2 py-0.5" data-testid="context-usage-row">
      <span className={`h-2 w-2 shrink-0 rounded-full ${color}`} aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-xs leading-4 text-ink-soft">{label}</span>
      <span className="shrink-0 font-mono text-xs leading-4 text-ink">~{compactTokens(value)}</span>
    </div>
  )
}

export default function ContextUsagePanel({
  contextUsage,
  contextWindow,
  t,
}) {
  const measuredPromptTokens = normalizeOptionalTokenCount(contextUsage.actualPromptTokens)
  const hasMeasuredPromptTokens = measuredPromptTokens !== null
  const serverEstimatedPromptTokens = normalizeOptionalTokenCount(contextUsage.serverEstimatedPromptTokens)
  const usedTokens = measuredPromptTokens
    ?? serverEstimatedPromptTokens
    ?? Number(contextUsage.estimatedTokens || 0)
  const contextWindowAuthoritative = contextUsage.contextWindowAuthoritative !== false
  const windowTokens = Number(contextUsage.contextWindow || contextWindow)
  const percent = contextWindowAuthoritative
    ? Math.min(100, Math.max(0, Math.round((usedTokens / Math.max(1, windowTokens)) * 100)))
    : 0
  const toolTokens = Number(contextUsage.toolSpecTokens || 0) + Number(contextUsage.toolCallTokens || 0)
  const conversationTokens = Number(contextUsage.messageTokens || 0) + Number(contextUsage.attachmentTokens || 0)
  const cumulativeTokens = normalizeOptionalTokenCount(contextUsage.cumulativeTokens)

  return (
    <div
      className="w-full rounded-xl border border-ink/10 bg-paper px-3 py-2.5 text-ink-soft shadow-[0_10px_30px_rgb(var(--color-ink-rgb)/0.13)]"
      data-density="compact"
      data-testid="context-usage-panel"
      role="dialog"
      aria-label={t('chat.contextUsage.currentContext')}
    >
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-[13px] leading-5 text-ink-soft">
          {t('chat.contextUsage.currentContext')}{contextWindowAuthoritative && (
            <strong className="ml-1 font-semibold text-ink">{percent}%</strong>
          )}
        </div>
        <div className="shrink-0 font-mono text-[13px] font-semibold leading-5 text-ink">
          {hasMeasuredPromptTokens ? '' : '~'}{compactTokens(usedTokens)}
          {contextWindowAuthoritative && <> / {compactTokens(windowTokens)}</>}
        </div>
      </div>
      {contextWindowAuthoritative && (
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-ink/10" aria-hidden="true">
          <div
            className={`h-full rounded-full transition-[width,background-color] ${percent >= 80 ? 'bg-danger' : percent >= 60 ? 'bg-warning' : 'bg-running'}`}
            style={{ width: `${percent}%` }}
          />
        </div>
      )}
      <div className="mt-2 border-t border-ink/10 pt-1.5">
        {(hasMeasuredPromptTokens || serverEstimatedPromptTokens !== null) && (
          <p
            className="truncate pb-1 text-xs leading-[1.35] text-ink-fade"
            data-testid="context-estimate-notice"
            title={t('chat.contextUsage.estimateNotice')}
          >
            {t('chat.contextUsage.estimateNotice')}
          </p>
        )}
        <UsageRow color="bg-ink/35" label={t('chat.contextUsage.systemPrompt')} value={contextUsage.systemTokens} />
        <UsageRow color="bg-accent" label={t('chat.contextUsage.tools')} value={toolTokens} />
        <UsageRow color="bg-ink/60" label={t('chat.contextUsage.messagePayload')} value={conversationTokens} />
      </div>
      {cumulativeTokens !== null && (
        <div className="mt-1.5 flex items-center justify-between gap-3 border-t border-ink/10 pt-2 text-xs leading-4">
          <span className="text-ink-soft">{t('chat.contextUsage.cumulativeUsage')}</span>
          <span className="shrink-0 font-mono font-semibold text-ink">{compactTokens(cumulativeTokens)}</span>
        </div>
      )}
    </div>
  )
}
