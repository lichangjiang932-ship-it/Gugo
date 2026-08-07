import { ArrowUpRight, FileText, ListChecks, Presentation, Sheet } from 'lucide-react'
import { useT } from '../../../i18n/I18nProvider.jsx'

const STARTER_PROMPTS = [
  { key: 'weeklyReport', icon: FileText, tone: 'text-sky-700 bg-sky-50 ring-sky-100' },
  { key: 'salesExcel', icon: Sheet, tone: 'text-emerald-700 bg-emerald-50 ring-emerald-100' },
  { key: 'productPpt', icon: Presentation, tone: 'text-violet-700 bg-violet-50 ring-violet-100' },
  { key: 'workPlan', icon: ListChecks, tone: 'text-amber-700 bg-amber-50 ring-amber-100' },
]

export default function NewConversationWelcome({ onPromptSelect }) {
  const { t } = useT()
  return <section className="flex min-h-[420px] flex-1 flex-col items-center justify-center py-10" aria-labelledby="new-conversation-title" data-testid="new-conversation-welcome"><GugoMark /><h1 id="new-conversation-title" className="font-hand text-2xl text-ink sm:text-3xl">{t('chatMessages.emptyTitle')}</h1><p className="mt-2 max-w-md text-center text-sm leading-6 text-ink-soft">{t('chatMessages.emptyHint')}</p><div className="mt-8 grid w-full max-w-[760px] gap-3 sm:grid-cols-2">{STARTER_PROMPTS.map(({ key, icon: Icon, tone }) => <button key={key} type="button" onClick={() => onPromptSelect?.(t(`chatMessages.${key}`))} className="group relative flex min-h-[104px] items-center gap-5 overflow-hidden rounded-[22px] border border-ink/[0.08] bg-paper px-5 py-5 text-left text-[15px] leading-6 text-ink-soft shadow-[0_1px_0_rgb(var(--color-ink-rgb)/0.03)] transition-all hover:-translate-y-0.5 hover:border-ink/15 hover:text-ink hover:shadow-[0_12px_30px_rgb(var(--color-ink-rgb)/0.08)]"><span className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl ring-1 transition-transform group-hover:scale-105 ${tone}`}><Icon className="h-6 w-6" aria-hidden="true" /></span><span className="min-w-0 flex-1"><span className="block font-medium text-ink">{t(`chatMessages.${key}`)}</span></span><ArrowUpRight className="h-4 w-4 shrink-0 text-ink-fade/60 group-hover:text-ember" aria-hidden="true" /></button>)}</div></section>
}

function GugoMark() {
  return <div data-testid="gugo-mark" className="mb-6 flex h-16 w-16 items-center justify-center rounded-[22px] bg-ink text-paper shadow-[0_16px_40px_rgb(var(--color-ink-rgb)/0.18)] ring-1 ring-paper/20" aria-hidden="true"><svg viewBox="0 0 56 56" className="h-10 w-10" fill="none"><path d="M38.5 17.5A15 15 0 1 0 41 31H29" stroke="currentColor" strokeWidth="4.5" strokeLinecap="round" /><path d="M41 31v9" stroke="currentColor" strokeWidth="4.5" strokeLinecap="round" /><circle cx="42.5" cy="13.5" r="3.5" className="fill-ember" /></svg></div>
}
