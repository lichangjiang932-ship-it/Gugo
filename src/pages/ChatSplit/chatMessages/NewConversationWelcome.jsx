import { ArrowUpRight } from 'lucide-react'
import { useT } from '../../../i18n/I18nProvider.jsx'

const STARTER_PROMPTS = [
  'weeklyReport',
  'salesExcel',
  'productPpt',
  'workPlan',
]

export default function NewConversationWelcome({
  onPromptSelect,
}) {
  const { t } = useT()

  return (
    <section
      className="flex min-h-[420px] flex-1 flex-col items-center justify-center py-10"
      aria-labelledby="new-conversation-title"
      data-testid="new-conversation-welcome"
    >
      <GugoMark />
      <h1 id="new-conversation-title" className="text-page font-semibold tracking-[-0.02em] text-ink">
        {t('chatMessages.emptyTitle')}
      </h1>
      <p className="mt-2 max-w-md text-center text-ui leading-6 text-ink-soft">
        {t('chatMessages.emptyHint')}
      </p>

      <div className="mt-7 w-full max-w-[560px] border-y border-ink/10">
        {STARTER_PROMPTS.map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => onPromptSelect?.(t(`chatMessages.${key}`))}
            className="group flex w-full items-center gap-3 border-b border-ink/10 px-1 py-3 text-left text-body leading-6 text-ink-soft transition-colors last:border-b-0 hover:bg-ink/[0.025] hover:text-ink"
          >
            <span className="min-w-0 flex-1">{t(`chatMessages.${key}`)}</span>
            <ArrowUpRight className="h-4 w-4 shrink-0 text-ink-fade transition-colors group-hover:text-accent-ink" aria-hidden="true" />
          </button>
        ))}
      </div>
    </section>
  )
}

function GugoMark() {
  return (
    <div
      data-testid="gugo-mark"
      className="mb-5 flex h-12 w-12 items-center justify-center rounded-card bg-ink text-paper"
      aria-hidden="true"
    >
      <svg viewBox="0 0 56 56" className="h-8 w-8" fill="none">
        <path d="M38.5 17.5A15 15 0 1 0 41 31H29" stroke="currentColor" strokeWidth="4.5" strokeLinecap="round" />
        <path d="M41 31v9" stroke="currentColor" strokeWidth="4.5" strokeLinecap="round" />
        <circle cx="42.5" cy="13.5" r="3.5" className="fill-accent" />
      </svg>
    </div>
  )
}
