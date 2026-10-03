import { normalizeOptionalTokenCount } from '../../../lib/contextUsage.js'

export default function RequestCacheUsage({ usage, t }) {
  if (!usage || typeof usage !== 'object') return null
  const prompt = normalizeOptionalTokenCount(usage.promptTokens)
  const reportedRead = normalizeOptionalTokenCount(usage.cacheHitTokens)
  const read = prompt !== null && reportedRead !== null && reportedRead > prompt ? null : reportedRead
  const write = normalizeOptionalTokenCount(usage.cacheCreationTokens)
  const uncached = normalizeOptionalTokenCount(usage.uncachedInputTokens)
  const percent = read !== null && prompt > 0 ? Math.round(read / prompt * 100) : null
  const unknown = t('chat.contextUsage.cacheUnknown')

  return <section
    className="mt-2.5 border-t border-ink/10 pt-2 text-xs leading-5"
    data-testid="request-cache-usage"
    data-observation={read === null ? 'unknown' : 'reported'}
    aria-label={t('chat.contextUsage.latestRequestCache')}
  >
    <div className="mb-1 text-ink-fade" title={t('chat.contextUsage.cacheHint')}>
      {t('chat.contextUsage.latestRequestCache')}
    </div>
    <dl className="space-y-0.5">
      <div className="flex items-baseline justify-between gap-3" data-testid="request-cache-read">
        <dt>{t('chat.contextUsage.cacheRead')}</dt>
        <dd className="font-mono text-ink">{read === null ? unknown : read.toLocaleString()}
          {percent !== null && <span className="ml-1.5 text-ink-soft">{percent}%</span>}
        </dd>
      </div>
      {write !== null && <div className="flex items-baseline justify-between gap-3" data-testid="request-cache-write">
        <dt>{t('chat.contextUsage.cacheWrite')}</dt><dd className="font-mono text-ink">{write.toLocaleString()}</dd>
      </div>}
      {uncached !== null && <div className="flex items-baseline justify-between gap-3" data-testid="request-uncached-input">
        <dt>{t('chat.contextUsage.uncachedInput')}</dt><dd className="font-mono text-ink">{uncached.toLocaleString()}</dd>
      </div>}
    </dl>
  </section>
}
