import { BarChart3, Bug, FileText, FolderOpen, Globe2, GitPullRequest, Map, Presentation, Sparkles } from 'lucide-react'
import { useT } from '../../../i18n/I18nProvider.jsx'
import { projectHue } from '../../../lib/projectGlyph.js'

/**
 * What a new conversation offers to start with. Two sets, chosen by context:
 * with a project open the starters are about that code (the way Claude Code and
 * Codex open), without one they are the general tasks Gugo also does well.
 * Every starter has a short card title and a full, sendable prompt; the ones
 * that need the reader's own words end with a colon and leave the cursor there.
 */
const CODE_STARTERS = [
  { key: 'codeExplain', icon: Map, tone: 'running' },
  { key: 'codeBug', icon: Bug, tone: 'danger' },
  { key: 'codeFeature', icon: Sparkles, tone: 'accent' },
  { key: 'codeReview', icon: GitPullRequest, tone: 'warning' },
]

const GENERAL_STARTERS = [
  { key: 'research', icon: Globe2, tone: 'running' },
  { key: 'doc', icon: FileText, tone: 'accent' },
  { key: 'data', icon: BarChart3, tone: 'warning' },
  { key: 'slides', icon: Presentation, tone: 'danger' },
]

const TONE = Object.freeze({
  accent: 'bg-accent/10 text-accent-ink',
  running: 'bg-running/10 text-running',
  warning: 'bg-warning/10 text-warning',
  danger: 'bg-danger/10 text-danger',
})

function greetingKey(hour) {
  if (hour < 11) return 'welcome.greetingMorning'
  if (hour < 18) return 'welcome.greetingAfternoon'
  return 'welcome.greetingEvening'
}

function projectName(path) {
  return String(path || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || ''
}

export default function NewConversationWelcome({
  onPromptSelect,
  workspacePath = '',
}) {
  const { t } = useT()
  const project = projectName(workspacePath)
  const starters = project ? CODE_STARTERS : GENERAL_STARTERS

  return (
    <section
      className="flex flex-1 flex-col items-center justify-center px-1 py-8 sm:py-10"
      aria-labelledby="new-conversation-title"
      data-testid="new-conversation-welcome"
      data-context={project ? 'project' : 'general'}
    >
      <GugoMark />
      <h1 id="new-conversation-title" className="text-center text-section font-semibold tracking-[-0.02em] text-ink sm:text-page">
        {t('welcome.title', { greeting: t(greetingKey(new Date().getHours())) })}
      </h1>
      {project ? (
        <p className="mt-2.5 inline-flex max-w-full items-center gap-1.5 rounded-pill bg-ink/[0.04] px-2.5 py-1 text-xs text-ink-soft" data-testid="welcome-project">
          <FolderOpen className="h-3.5 w-3.5 shrink-0" style={{ color: `hsl(${projectHue(project)} 55% 45%)` }} aria-hidden="true" />
          <span className="truncate">{t('welcome.projectBadge', { project })}</span>
        </p>
      ) : null}
      <p className="mt-2.5 max-w-lg text-balance text-center text-ui leading-6 text-ink-soft">
        {t(project ? 'welcome.hint' : 'welcome.hintNoProject')}
      </p>

      <div className="mt-7 grid w-full max-w-[640px] grid-cols-1 gap-2.5 sm:grid-cols-2" data-testid="welcome-starters">
        {starters.map(({ key, icon: Icon, tone }) => (
          <button
            key={key}
            type="button"
            data-testid="welcome-starter"
            data-starter={key}
            onClick={(event) => {
              onPromptSelect?.(t(`welcome.${key}Prompt`))
              // Hand the cursor to the composer, at the end: a starter that ends
              // with a colon is waiting for the reader's own words.
              const composer = event.currentTarget.closest('[data-chat-main-area]')
                ?.querySelector('textarea.chat-composer-input')
              if (composer) {
                requestAnimationFrame(() => {
                  composer.focus()
                  const end = composer.value.length
                  composer.setSelectionRange?.(end, end)
                })
              }
            }}
            className="group flex min-w-0 items-start gap-3 rounded-card border border-ink/10 bg-surface px-3.5 py-3 text-left transition-all hover:-translate-y-px hover:border-ink/20 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30 motion-reduce:transition-none motion-reduce:hover:translate-y-0"
          >
            <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${TONE[tone]}`} aria-hidden="true">
              <Icon className="h-4 w-4" strokeWidth={1.8} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-ui font-medium text-ink">{t(`welcome.${key}Title`)}</span>
              <span className="mt-0.5 block truncate text-xs text-ink-fade">{t(`welcome.${key}Desc`)}</span>
            </span>
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
      className="mb-4 flex h-11 w-11 items-center justify-center rounded-card bg-ink text-paper shadow-sm sm:mb-5 sm:h-12 sm:w-12"
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
