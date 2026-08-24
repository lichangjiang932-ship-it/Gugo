import { KeyRound, Play, Save, Trash2, X } from 'lucide-react'

const INPUT_CLASS = 'h-9 w-full rounded-lg border border-ink/10 bg-paper-2/45 px-3 text-sm text-ink outline-none transition-colors placeholder:text-ink-fade/70 hover:border-ink/15 focus:border-focus/55'
const MONO_INPUT_CLASS = `${INPUT_CLASS} font-mono text-xs`
const SECONDARY_BUTTON_CLASS = 'inline-flex h-8 items-center gap-1.5 rounded-lg border border-ink/10 bg-paper px-3 text-xs text-ink-soft transition-colors hover:bg-paper-2/55 hover:text-ink disabled:cursor-not-allowed disabled:opacity-45'

export default function McpServerEditor({ controller, t }) {
  const { editing } = controller
  if (!editing) {
    return (
      <section className="flex min-h-[360px] items-center justify-center rounded-lg border border-ink/10 bg-paper px-8 text-center">
        <div className="max-w-md text-xs leading-5 text-ink-fade">
          <p>{t('mcp.selectHint')}</p>
          <p className="mt-1 text-[11px]">{t('mcp.transportHint')}</p>
        </div>
      </section>
    )
  }

  const update = (patch) => controller.setEditing({ ...editing, ...patch })

  return (
    <section className="min-h-[360px] overflow-hidden rounded-lg border border-ink/10 bg-paper">
      <header className="flex min-h-14 items-center justify-between gap-3 border-b border-ink/10 px-5 py-3">
        <h2 className="text-sm font-semibold text-ink">{editing.id ? t('mcp.editTitle') : t('mcp.newTitle')}</h2>
        <button
          type="button"
          onClick={() => controller.setEditing(null)}
          aria-label={t('mcp.close')}
          className="grid h-8 w-8 place-items-center rounded-full text-ink-fade transition-colors hover:bg-ink/[0.045] hover:text-ink"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      <div className="space-y-5 p-5 sm:p-6">
        <Field label={t('mcp.name')}>
          <input value={editing.name} onChange={(event) => update({ name: event.target.value })} className={INPUT_CLASS} placeholder={t('mcp.namePlaceholder')} />
        </Field>

        <Field label={t('mcp.transport')}>
          <div className="inline-flex flex-wrap gap-1 rounded-lg bg-paper-2/65 p-1">
            {['stdio', 'http', 'sse'].map((transport) => (
              <Chip key={transport} active={editing.transport === transport} onClick={() => update({ transport })}>
                {t(`mcp.${transport}`)}
              </Chip>
            ))}
          </div>
        </Field>

        {editing.transport === 'stdio'
          ? <StdioFields controller={controller} editing={editing} t={t} update={update} />
          : <RemoteFields controller={controller} editing={editing} t={t} update={update} />}

        <label className="flex min-h-11 cursor-pointer items-center justify-between gap-4 border-t border-ink/10 pt-4 text-xs text-ink-soft">
          <span>{t('mcp.enabled')}</span>
          <input type="checkbox" checked={editing.enabled} onChange={(event) => update({ enabled: event.target.checked })} className="h-4 w-4 accent-ink" />
        </label>

        <div className="flex flex-wrap items-center gap-2 border-t border-ink/10 pt-4">
          <button
            type="button"
            onClick={controller.save}
            disabled={controller.saving}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-ink bg-ink px-4 text-xs font-medium text-paper transition-colors hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-45"
          >
            <Save className="h-3.5 w-3.5" />
            {controller.saving ? t('mcp.saving') : t('mcp.save')}
          </button>
          {editing.id && (
            <>
              <button type="button" onClick={() => controller.test(editing.id)} className={SECONDARY_BUTTON_CLASS}>
                <Play className="h-3.5 w-3.5" />
                {t('mcp.testConnection')}
              </button>
              <button type="button" onClick={() => controller.remove(editing.id)} className={`${SECONDARY_BUTTON_CLASS} hover:border-danger/25 hover:text-danger`}>
                <Trash2 className="h-3.5 w-3.5" />
                {t('mcp.delete')}
              </button>
            </>
          )}
        </div>

        <TestResult result={controller.testResult} t={t} />
      </div>
    </section>
  )
}

function StdioFields({ controller, editing, t, update }) {
  return (
    <div className="grid gap-4">
      <Field label={t('mcp.command')}>
        <input value={editing.command} onChange={(event) => update({ command: event.target.value })} className={MONO_INPUT_CLASS} />
      </Field>
      <Field label={t('mcp.args')}>
        <input value={Array.isArray(editing.args) ? editing.args.join(' ') : editing.args || ''} onChange={(event) => update({ args: event.target.value })} className={MONO_INPUT_CLASS} />
      </Field>
      <Field label={t('mcp.cwd')}>
        <input value={editing.cwd || ''} onChange={(event) => update({ cwd: event.target.value })} className={MONO_INPUT_CLASS} placeholder={t('mcp.cwdPlaceholder')} />
      </Field>
      <Field label={t('mcp.env')} error={controller.fieldErrors.env} hint={t('mcp.keyValueHint')}>
        <textarea
          rows="4"
          value={editing.envText || ''}
          onChange={(event) => {
            update({ envText: event.target.value })
            controller.setFieldErrors((current) => ({ ...current, env: '' }))
          }}
          className="w-full resize-y rounded-lg border border-ink/10 bg-paper-2/45 px-3 py-2 font-mono text-xs text-ink outline-none transition-colors placeholder:text-ink-fade/70 hover:border-ink/15 focus:border-focus/55"
          placeholder={'GITHUB_TOKEN=...\nAPI_KEY=...'}
          spellCheck="false"
        />
      </Field>
    </div>
  )
}

function RemoteFields({ controller, editing, t, update }) {
  return (
    <div className="grid gap-4">
      <Field label={t('mcp.url')}>
        <input value={editing.url || ''} onChange={(event) => update({ url: event.target.value })} className={INPUT_CLASS} placeholder="https://your-mcp.example.com/mcp" />
      </Field>
      <Field label={t('mcp.headers')} error={controller.fieldErrors.headers} hint={t('mcp.keyValueHint')}>
        <textarea
          rows="4"
          value={editing.headersText || ''}
          onChange={(event) => {
            update({ headersText: event.target.value })
            controller.setFieldErrors((current) => ({ ...current, headers: '' }))
          }}
          className="w-full resize-y rounded-lg border border-ink/10 bg-paper-2/45 px-3 py-2 font-mono text-xs text-ink outline-none transition-colors placeholder:text-ink-fade/70 hover:border-ink/15 focus:border-focus/55"
          placeholder={'Authorization=Bearer ...\nX-API-Key=...'}
          spellCheck="false"
        />
      </Field>
      <OAuthFields controller={controller} editing={editing} t={t} update={update} />
    </div>
  )
}

function OAuthFields({ controller, editing, t, update }) {
  return (
    <section className="space-y-4 rounded-lg border border-ink/10 bg-paper-2/25 p-4">
      <div className="flex items-start gap-2.5">
        <KeyRound className="mt-0.5 h-4 w-4 flex-none text-ink-fade" />
        <div className="min-w-0 flex-1">
          <h3 className="text-xs font-semibold text-ink">{t('mcp.oauthTitle')}</h3>
          <p className="mt-0.5 text-[10px] leading-4 text-ink-fade">{t('mcp.oauthHint')}</p>
        </div>
        {editing.oauth?.configured && (
          <span className={`rounded-full border px-2 py-0.5 text-[10px] ${editing.oauth.connected ? 'border-success/20 bg-success/5 text-success' : 'border-warning/20 bg-warning/5 text-warning'}`}>
            {t(editing.oauth.connected ? 'mcp.oauthConnectedStatus' : 'mcp.oauthExpiredStatus')}
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Field label={t('mcp.oauthClientId')}>
          <input value={editing.oauthClientId || ''} onChange={(event) => update({ oauthClientId: event.target.value })} className={MONO_INPUT_CLASS} placeholder={t('mcp.oauthClientIdPlaceholder')} />
        </Field>
        <Field label={t('mcp.oauthClientSecret')}>
          <input type="password" value={editing.oauthClientSecret || ''} onChange={(event) => update({ oauthClientSecret: event.target.value })} className={MONO_INPUT_CLASS} placeholder={t('mcp.oauthOptional')} autoComplete="new-password" />
        </Field>
      </div>
      <Field label={t('mcp.oauthScopes')}>
        <input value={editing.oauthScopes || ''} onChange={(event) => update({ oauthScopes: event.target.value })} className={MONO_INPUT_CLASS} placeholder="read write" />
      </Field>
      <details className="text-[10px] text-ink-fade">
        <summary className="cursor-pointer select-none rounded-md py-1 transition-colors hover:text-ink">{t('mcp.oauthAdvanced')}</summary>
        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
          <Field label={t('mcp.oauthAuthorizationEndpoint')}>
            <input value={editing.oauthAuthorizationEndpoint || ''} onChange={(event) => update({ oauthAuthorizationEndpoint: event.target.value })} className={MONO_INPUT_CLASS} placeholder="https://auth.example.com/authorize" />
          </Field>
          <Field label={t('mcp.oauthTokenEndpoint')}>
            <input value={editing.oauthTokenEndpoint || ''} onChange={(event) => update({ oauthTokenEndpoint: event.target.value })} className={MONO_INPUT_CLASS} placeholder="https://auth.example.com/token" />
          </Field>
        </div>
      </details>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={controller.startOAuth} disabled={!editing.id || controller.oauthBusy} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-ink bg-ink px-3 text-xs text-paper transition-colors hover:bg-ink/90 disabled:cursor-not-allowed disabled:opacity-40">
          <KeyRound className="h-3.5 w-3.5" />
          {controller.oauthBusy ? t('mcp.oauthWorking') : t('mcp.oauthConnect')}
        </button>
        {editing.oauth?.configured && <button type="button" onClick={controller.disconnectOAuth} disabled={controller.oauthBusy} className={SECONDARY_BUTTON_CLASS}>{t('mcp.oauthDisconnect')}</button>}
        {!editing.id && <span className="text-[10px] text-ink-fade">{t('mcp.oauthSaveFirst')}</span>}
      </div>
    </section>
  )
}

function TestResult({ result, t }) {
  if (!result) return null
  if (result.loading) return <div className="rounded-lg border border-ink/10 bg-paper-2/35 p-3 text-xs text-ink-soft" role="status">{t('mcp.testing')}</div>
  if (result.error) return <div className="rounded-lg border border-danger/20 bg-danger/5 p-3 text-xs text-danger" role="alert">{t('mcp.error')}: {result.error}</div>
  return (
    <div className="space-y-2 rounded-lg border border-ink/10 bg-paper-2/35 p-3 text-xs">
      {result.tools?.length > 0 && (
        <div>
          <div className="mb-1 font-semibold text-ink">{t('mcp.tools')} ({result.tools.length})</div>
          <ul className="space-y-1 text-xs text-ink-soft">
            {result.tools.map((tool) => <li key={tool.name}><code className="font-mono text-ink">{tool.name}</code> · {tool.description}</li>)}
          </ul>
        </div>
      )}
      {result.resources?.length > 0 && <div className="font-semibold text-ink">{t('mcp.resources')} ({result.resources.length})</div>}
      {result.prompts?.length > 0 && <div className="font-semibold text-ink">{t('mcp.prompts')} ({result.prompts.length})</div>}
    </div>
  )
}

function Field({ label, hint, error, children }) {
  return (
    <div>
      <label className="mb-1.5 block text-xs text-ink-fade">{label}</label>
      {children}
      {hint && !error && <p className="mt-1 text-[10px] leading-4 text-ink-fade">{hint}</p>}
      {error && <p className="mt-1 text-[10px] leading-4 text-danger">{error}</p>}
    </div>
  )
}

function Chip({ active, onClick, children }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`min-h-7 rounded-md border px-3 py-1 text-xs transition-colors ${active ? 'border-ink/15 bg-paper text-ink' : 'border-transparent bg-transparent text-ink-fade hover:bg-ink/[0.035] hover:text-ink'}`}
    >
      {children}
    </button>
  )
}
