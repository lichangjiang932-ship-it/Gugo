import { KeyRound, Play, Save, Trash2, X } from 'lucide-react'

export default function McpServerEditor({ controller, t }) {
  const { editing } = controller
  if (!editing) return <div className="flex h-full items-center justify-center px-6 text-center text-sm text-ink-fade">{t('mcp.selectHint')}<br /><span className="text-[11px]">{t('mcp.transportHint')}</span></div>
  const update = (patch) => controller.setEditing({ ...editing, ...patch })
  return (
    <div className="mx-auto max-w-[720px] space-y-4 px-8 py-6">
      <div className="flex items-center justify-between"><div className="text-sm font-semibold text-ink">{editing.id ? t('mcp.editTitle') : t('mcp.newTitle')}</div><button type="button" onClick={() => controller.setEditing(null)} aria-label={t('mcp.close')} className="text-ink-fade hover:text-ink"><X className="h-4 w-4" /></button></div>
      <Field label={t('mcp.name')}><input value={editing.name} onChange={(event) => update({ name: event.target.value })} className="h-9 w-full rounded-md border border-ink/15 bg-paper-2 px-3 text-sm outline-none focus:border-ember" placeholder={t('mcp.namePlaceholder')} /></Field>
      <Field label={t('mcp.transport')}><div className="flex gap-1.5">{['stdio', 'http', 'sse'].map((transport) => <Chip key={transport} active={editing.transport === transport} onClick={() => update({ transport })}>{t(`mcp.${transport}`)}</Chip>)}</div></Field>
      {editing.transport === 'stdio' ? <StdioFields controller={controller} editing={editing} t={t} update={update} /> : <RemoteFields controller={controller} editing={editing} t={t} update={update} />}
      <label className="flex cursor-pointer items-center gap-2 text-xs text-ink-soft"><input type="checkbox" checked={editing.enabled} onChange={(event) => update({ enabled: event.target.checked })} />{t('mcp.enabled')}</label>
      <div className="flex items-center gap-2 pt-2">
        <button type="button" onClick={controller.save} disabled={controller.saving} className="flex h-8 items-center gap-1 rounded-md bg-ember px-4 text-xs text-paper hover:bg-ember/90 disabled:opacity-50"><Save className="h-3.5 w-3.5" />{controller.saving ? t('mcp.saving') : t('mcp.save')}</button>
        {editing.id && <><button type="button" onClick={() => controller.test(editing.id)} className="flex h-8 items-center gap-1 rounded-md border border-ink/15 px-3 text-xs text-ink-soft hover:bg-paper-2"><Play className="h-3.5 w-3.5" />{t('mcp.testConnection')}</button><button type="button" onClick={() => controller.remove(editing.id)} className="flex h-8 items-center gap-1 rounded-md border border-rose-300 px-3 text-xs text-rose-700 hover:bg-rose-50"><Trash2 className="h-3.5 w-3.5" />{t('mcp.delete')}</button></>}
      </div>
      <TestResult result={controller.testResult} t={t} />
    </div>
  )
}

function StdioFields({ controller, editing, t, update }) {
  return <><Field label={t('mcp.command')}><input value={editing.command} onChange={(event) => update({ command: event.target.value })} className="h-9 w-full rounded-md border border-ink/15 bg-paper-2 px-3 font-mono text-sm outline-none focus:border-ember" /></Field><Field label={t('mcp.args')}><input value={Array.isArray(editing.args) ? editing.args.join(' ') : editing.args || ''} onChange={(event) => update({ args: event.target.value })} className="h-9 w-full rounded-md border border-ink/15 bg-paper-2 px-3 font-mono text-sm outline-none focus:border-ember" /></Field><Field label={t('mcp.cwd')}><input value={editing.cwd || ''} onChange={(event) => update({ cwd: event.target.value })} className="h-9 w-full rounded-md border border-ink/15 bg-paper-2 px-3 font-mono text-sm outline-none focus:border-ember" placeholder={t('mcp.cwdPlaceholder')} /></Field><Field label={t('mcp.env')} error={controller.fieldErrors.env} hint={t('mcp.keyValueHint')}><textarea rows="4" value={editing.envText || ''} onChange={(event) => { update({ envText: event.target.value }); controller.setFieldErrors((current) => ({ ...current, env: '' })) }} className="w-full rounded-md border border-ink/15 bg-paper-2 px-3 py-2 font-mono text-xs outline-none focus:border-ember" placeholder={'GITHUB_TOKEN=...\nAPI_KEY=...'} spellCheck="false" /></Field></>
}

function RemoteFields({ controller, editing, t, update }) {
  return <><Field label={t('mcp.url')}><input value={editing.url || ''} onChange={(event) => update({ url: event.target.value })} className="h-9 w-full rounded-md border border-ink/15 bg-paper-2 px-3 text-sm outline-none focus:border-ember" placeholder="https://your-mcp.example.com/mcp" /></Field><Field label={t('mcp.headers')} error={controller.fieldErrors.headers} hint={t('mcp.keyValueHint')}><textarea rows="4" value={editing.headersText || ''} onChange={(event) => { update({ headersText: event.target.value }); controller.setFieldErrors((current) => ({ ...current, headers: '' })) }} className="w-full rounded-md border border-ink/15 bg-paper-2 px-3 py-2 font-mono text-xs outline-none focus:border-ember" placeholder={'Authorization=Bearer ...\nX-API-Key=...'} spellCheck="false" /></Field><OAuthFields controller={controller} editing={editing} t={t} update={update} /></>
}

function OAuthFields({ controller, editing, t, update }) {
  const inputClass = 'h-9 w-full rounded-md border border-ink/15 bg-paper px-3 font-mono text-xs outline-none focus:border-ember'
  return (
    <div className="space-y-3 rounded-lg border border-ink/10 bg-paper-2/60 p-4">
      <div className="flex items-center gap-2"><KeyRound className="h-4 w-4 text-ember" /><div className="min-w-0 flex-1"><div className="text-xs font-semibold text-ink">{t('mcp.oauthTitle')}</div><div className="text-[10px] text-ink-fade">{t('mcp.oauthHint')}</div></div>{editing.oauth?.configured && <span className={`rounded-full px-2 py-0.5 text-[10px] ${editing.oauth.connected ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'}`}>{t(editing.oauth.connected ? 'mcp.oauthConnectedStatus' : 'mcp.oauthExpiredStatus')}</span>}</div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2"><Field label={t('mcp.oauthClientId')}><input value={editing.oauthClientId || ''} onChange={(event) => update({ oauthClientId: event.target.value })} className={inputClass} placeholder={t('mcp.oauthClientIdPlaceholder')} /></Field><Field label={t('mcp.oauthClientSecret')}><input type="password" value={editing.oauthClientSecret || ''} onChange={(event) => update({ oauthClientSecret: event.target.value })} className={inputClass} placeholder={t('mcp.oauthOptional')} autoComplete="new-password" /></Field></div>
      <Field label={t('mcp.oauthScopes')}><input value={editing.oauthScopes || ''} onChange={(event) => update({ oauthScopes: event.target.value })} className={inputClass} placeholder="read write" /></Field>
      <details className="text-[10px] text-ink-fade"><summary className="cursor-pointer select-none">{t('mcp.oauthAdvanced')}</summary><div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2"><Field label={t('mcp.oauthAuthorizationEndpoint')}><input value={editing.oauthAuthorizationEndpoint || ''} onChange={(event) => update({ oauthAuthorizationEndpoint: event.target.value })} className={inputClass} placeholder="https://auth.example.com/authorize" /></Field><Field label={t('mcp.oauthTokenEndpoint')}><input value={editing.oauthTokenEndpoint || ''} onChange={(event) => update({ oauthTokenEndpoint: event.target.value })} className={inputClass} placeholder="https://auth.example.com/token" /></Field></div></details>
      <div className="flex items-center gap-2"><button type="button" onClick={controller.startOAuth} disabled={!editing.id || controller.oauthBusy} className="flex h-8 items-center gap-1.5 rounded-md bg-ink px-3 text-xs text-paper hover:bg-ink/90 disabled:opacity-40"><KeyRound className="h-3.5 w-3.5" />{controller.oauthBusy ? t('mcp.oauthWorking') : t('mcp.oauthConnect')}</button>{editing.oauth?.configured && <button type="button" onClick={controller.disconnectOAuth} disabled={controller.oauthBusy} className="h-8 rounded-md border border-ink/15 px-3 text-xs text-ink-soft hover:bg-paper disabled:opacity-40">{t('mcp.oauthDisconnect')}</button>}{!editing.id && <span className="text-[10px] text-ink-fade">{t('mcp.oauthSaveFirst')}</span>}</div>
    </div>
  )
}

function TestResult({ result, t }) {
  if (!result) return null
  if (result.loading) return <div className="mt-2 rounded-md border border-ink/10 bg-paper-2 p-3 text-xs">{t('mcp.testing')}</div>
  if (result.error) return <div className="mt-2 rounded-md border border-ink/10 bg-paper-2 p-3 text-xs text-rose-700">{t('mcp.error')}: {result.error}</div>
  return <div className="mt-2 space-y-2 rounded-md border border-ink/10 bg-paper-2 p-3 text-xs">{result.tools?.length > 0 && <div><div className="mb-1 font-semibold text-ink">{t('mcp.tools')} ({result.tools.length})</div><ul className="space-y-0.5 text-[11px] text-ink-soft">{result.tools.map((tool) => <li key={tool.name}><code className="text-ember">{tool.name}</code> · {tool.description}</li>)}</ul></div>}{result.resources?.length > 0 && <div className="font-semibold text-ink">{t('mcp.resources')} ({result.resources.length})</div>}{result.prompts?.length > 0 && <div className="font-semibold text-ink">{t('mcp.prompts')} ({result.prompts.length})</div>}</div>
}

function Field({ label, hint, error, children }) {
  return <div><label className="mb-1.5 block text-[11px] text-ink-fade">{label}</label>{children}{hint && !error && <p className="mt-1 text-[10px] text-ink-fade">{hint}</p>}{error && <p className="mt-1 text-[10px] text-rose-700">{error}</p>}</div>
}

function Chip({ active, onClick, children }) {
  return <button type="button" onClick={onClick} className={`rounded-md border px-3 py-1 text-xs transition-colors ${active ? 'border-ember bg-ember text-paper' : 'border-ink/15 bg-paper-2 text-ink-soft hover:border-ember/50'}`}>{children}</button>
}
