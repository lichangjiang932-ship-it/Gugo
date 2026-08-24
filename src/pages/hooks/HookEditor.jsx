import { Play, Save, Trash2, X } from 'lucide-react'

const EVENTS = [
  { id: 'user_prompt_submit', labelKey: 'hooks.eventUserPrompt' },
  { id: 'pre_tool_use', labelKey: 'hooks.eventPreTool' },
  { id: 'post_tool_use', labelKey: 'hooks.eventPostTool' },
  { id: 'stop', labelKey: 'hooks.eventStop' },
  { id: 'pre_compact', labelKey: 'hooks.eventPreCompact' },
  { id: 'session_start', labelKey: 'hooks.eventSessionStart' },
  { id: 'session_end', labelKey: 'hooks.eventSessionEnd' },
  { id: 'subagent_stop', labelKey: 'hooks.eventSubagentStop' },
  { id: 'notification', labelKey: 'hooks.eventNotification' },
]

export default function HookEditor({ editing, onChange, onClose, onDelete, onSave, onTest, saving, testResult, t }) {
  if (!editing) return <div className="flex h-full items-center justify-center text-sm text-ink-fade">{t('hooks.choose')}</div>
  const update = (patch) => onChange({ ...editing, ...patch })
  return <div className="mx-auto max-w-[720px] space-y-4 px-8 py-6">
    <div className="flex items-center justify-between"><div className="text-sm font-semibold text-ink">{editing.id ? t('hooks.edit') : t('hooks.create')}</div><button type="button" onClick={onClose} className="text-ink-fade hover:text-ink"><X className="h-4 w-4" /></button></div>
    <Field label={t('hooks.event')}><select value={editing.event} onChange={(event) => update({ event: event.target.value })} className="h-9 w-full rounded-md border border-ink/15 bg-paper-2 px-3 text-sm outline-none">{EVENTS.map((event) => <option key={event.id} value={event.id}>{t(event.labelKey)}</option>)}</select></Field>
    <Field label={t('hooks.toolPattern')}><input value={editing.toolPattern} onChange={(event) => update({ toolPattern: event.target.value })} className="h-9 w-full rounded-md border border-ink/15 bg-paper-2 px-3 text-sm outline-none focus:border-focus" /></Field>
    <Field label={t('hooks.argumentMatcher')}>
      <textarea rows="4" value={editing.argumentMatcherText || ''} onChange={(event) => update({ argumentMatcherText: event.target.value })} placeholder={t('hooks.argumentMatcherPlaceholder')} spellCheck="false" className="w-full rounded-md border border-ink/15 bg-paper-2 px-3 py-2 font-mono text-xs outline-none focus:border-focus" />
      <p className="mt-1 text-[10px] text-ink-fade">{t('hooks.argumentMatcherHint')}</p>
    </Field>
    <Field label={t('hooks.kind')}><div className="flex gap-1.5"><KindChip active={editing.kind === 'http'} onClick={() => update({ kind: 'http' })}>{t('hooks.httpCallback')}</KindChip><KindChip active={editing.kind === 'shell'} onClick={() => update({ kind: 'shell' })}>{t('hooks.shellEnabled')}</KindChip></div></Field>
    {editing.kind === 'http' ? <Field label="HTTPS URL (POST JSON)"><input value={editing.url || ''} onChange={(event) => update({ url: event.target.value })} placeholder="https://your-host/hook" className="h-9 w-full rounded-md border border-ink/15 bg-paper-2 px-3 text-sm outline-none focus:border-focus" /></Field> : <Field label={t('hooks.shellArgv')}><input value={Array.isArray(editing.command) ? editing.command.join(' ') : editing.command || ''} onChange={(event) => update({ command: event.target.value })} placeholder="node hooks/audit.js" className="h-9 w-full rounded-md border border-ink/15 bg-paper-2 px-3 font-mono text-sm outline-none focus:border-focus" /></Field>}
    <div className="flex items-center gap-4 text-xs text-ink-soft"><Check label={t('hooks.enabled')} checked={editing.enabled} onChange={(enabled) => update({ enabled })} /><Check label={t('hooks.blockingMode')} checked={editing.blocking} onChange={(blocking) => update({ blocking })} /><label className="flex items-center gap-2">{t('hooks.timeout')}<input type="number" value={editing.timeoutMs} onChange={(event) => update({ timeoutMs: Number(event.target.value) || 5000 })} className="h-7 w-20 rounded-md border border-ink/15 bg-paper-2 px-2 text-xs" /></label></div>
    <div className="flex items-center gap-2 pt-2"><button type="button" onClick={onSave} disabled={saving} className="flex h-8 items-center gap-1 rounded-md bg-accent px-4 text-xs text-accent-contrast hover:bg-accent/90 disabled:opacity-50"><Save className="h-3.5 w-3.5" />{saving ? t('hooks.saving') : t('hooks.save')}</button>{editing.id && <><button type="button" onClick={() => onTest(editing.id)} className="flex h-8 items-center gap-1 rounded-md border border-ink/15 px-3 text-xs text-ink-soft hover:bg-paper-2"><Play className="h-3.5 w-3.5" />{t('hooks.test')}</button><button type="button" onClick={() => onDelete(editing.id)} className="flex h-8 items-center gap-1 rounded-md border border-danger/30 px-3 text-xs text-danger hover:bg-danger/5"><Trash2 className="h-3.5 w-3.5" />{t('hooks.delete')}</button></>}</div>
    {testResult && <div className="mt-2 whitespace-pre-wrap break-all rounded-md border border-ink/10 bg-paper-2 p-3 font-mono text-xs">{JSON.stringify(testResult, null, 2)}</div>}
  </div>
}

function Field({ label, children }) { return <div><label className="mb-1.5 block text-xs text-ink-fade">{label}</label>{children}</div> }
function KindChip({ active, onClick, children }) { return <button type="button" onClick={onClick} className={`rounded-md border px-3 py-1 text-xs transition-colors ${active ? 'border-accent bg-accent text-accent-contrast' : 'border-ink/15 bg-paper-2 text-ink-soft hover:border-accent/50'}`}>{children}</button> }
function Check({ checked, label, onChange }) { return <label className="flex cursor-pointer items-center gap-2"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />{label}</label> }
