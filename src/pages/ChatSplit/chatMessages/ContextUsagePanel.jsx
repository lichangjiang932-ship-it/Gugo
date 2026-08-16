import { normalizeOptionalTokenCount } from '../../../lib/contextUsage.js'

function compactTokens(value) {
  const tokens = Math.max(0, Number(value) || 0)
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1))}M`
  if (tokens >= 1_000) return `${Number((tokens / 1_000).toFixed(tokens >= 100_000 ? 0 : 1))}K`
  return Math.round(tokens).toLocaleString()
}

function UsageRow({ color, label, value }) {
  return (
    <div className="flex items-center gap-2.5 py-1.5">
      <span className={`h-3 w-3 shrink-0 rounded-[3px] ${color}`} aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate text-sm text-ink-soft">{label}</span>
      <span className="shrink-0 font-mono text-sm text-ink">~{compactTokens(value)}</span>
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
  const windowTokens = Number(contextUsage.contextWindow || contextWindow)
  const percent = Math.min(100, Math.max(0, Math.round((usedTokens / Math.max(1, windowTokens)) * 100)))
  const toolTokens = Number(contextUsage.toolSpecTokens || 0) + Number(contextUsage.toolCallTokens || 0)
  const conversationTokens = Number(contextUsage.messageTokens || 0) + Number(contextUsage.attachmentTokens || 0)
  const cumulativeTokens = normalizeOptionalTokenCount(contextUsage.cumulativeTokens)

  return (
    <div
      className="w-full rounded-2xl border border-ink/10 bg-paper px-4 py-4 text-ink-soft shadow-[0_16px_48px_rgb(var(--color-ink-rgb)/0.16)]"
      data-testid="context-usage-panel"
      role="dialog"
      aria-label={t('chat.contextUsage.currentContext')}
    >
      <div className="flex items-baseline justify-between gap-4">
        <div className="text-base text-ink-soft">
          {t('chat.contextUsage.currentContext')} <strong className="ml-1 font-semibold text-ink">{percent}%</strong>
        </div>
        <div className="shrink-0 font-mono text-base font-semibold text-ink">{hasMeasuredPromptTokens ? '' : '~'}{compactTokens(usedTokens)} / {compactTokens(windowTokens)}</div>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-ink/10" aria-hidden="true">
        <div
          className={`h-full rounded-full transition-[width,background-color] ${percent >= 80 ? 'bg-red-500' : percent >= 60 ? 'bg-amber-500' : 'bg-blue-500'}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="mt-3 border-t border-ink/10 pt-2">
        {(hasMeasuredPromptTokens || serverEstimatedPromptTokens !== null) && (
          <p className="pb-1 text-[11px] leading-4 text-ink-fade">{t('chat.contextUsage.estimateNotice')}</p>
        )}
        <UsageRow color="bg-slate-400" label={t('chat.contextUsage.systemPrompt')} value={contextUsage.systemTokens} />
        <UsageRow color="bg-violet-500" label={t('chat.contextUsage.tools')} value={toolTokens} />
        <UsageRow color="bg-blue-500" label={t('chat.contextUsage.messagePayload')} value={conversationTokens} />
      </div>
      {cumulativeTokens !== null && (
        <div className="mt-2 flex items-center justify-between gap-4 border-t border-ink/10 pt-3 text-sm">
          <span className="text-ink-soft">{t('chat.contextUsage.cumulativeUsage')}</span>
          <span className="shrink-0 font-mono font-semibold text-ink">{compactTokens(cumulativeTokens)}</span>
        </div>
      )}
    </div>
  )
}
