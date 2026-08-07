import { Save, Sparkles, Star, X } from 'lucide-react'
import PersonaManifestEditor from '../../components/PersonaManifestEditor.jsx'

export default function AgentEditorModal({
  agent,
  onApplyPersona,
  onChange,
  onClose,
  onPersonaSelect,
  onSave,
  personaDraftId,
  personaLoading,
  personaPreview,
  personaTemplates,
  saving,
  t,
}) {
  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-6" onClick={onClose}>
      <div className="flex max-h-[88vh] w-full max-w-3xl flex-col rounded-lg bg-canvas shadow-xl" onClick={(event) => event.stopPropagation()}>
        <header className="flex items-center justify-between border-b border-ink/10 px-6 py-4">
          <h2 className="text-lg font-semibold">{agent.id ? t('agents.editTitle') : t('agents.newTitle')}</h2>
          <button onClick={onClose} className="text-ink-fade hover:text-ink"><X size={18} /></button>
        </header>
        <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
          <Field label={t('agents.fieldName')}>
            <input value={agent.name} onChange={(event) => onChange({ ...agent, name: event.target.value })} className="w-full rounded border border-ink/15 bg-canvas px-3 py-2 text-sm text-ink" placeholder={t('agents.namePlaceholder')} maxLength={80} />
          </Field>
          <div className="space-y-3 rounded-md border border-ink/10 p-4">
            <div className="flex items-center justify-between gap-3">
              <label className="block text-xs font-medium text-ink-fade">{t('agents.fieldPersonaTemplate')}</label>
              <span className="text-xs text-ink-fade">{agent.personaTemplate ? t('agents.personaApplied', { id: agent.personaTemplate }) : t('agents.personaNotApplied')}</span>
            </div>
            <div className="flex gap-2">
              <select value={personaDraftId} onChange={(event) => onPersonaSelect(event.target.value)} className="flex-1 rounded border border-ink/15 bg-canvas px-3 py-2 text-sm text-ink">
                <option value="">{t('agents.personaTemplateNone')}</option>
                {personaTemplates.map((template) => <option key={template.id} value={template.id}>{template.label || template.name}</option>)}
              </select>
              <button type="button" onClick={onApplyPersona} disabled={personaLoading || personaDraftId === (agent.personaTemplate || '')} className="inline-flex items-center gap-2 rounded border border-ink/15 px-3 py-2 text-sm hover:bg-ink/5 disabled:opacity-50"><Sparkles size={14} />{t('agents.personaApply')}</button>
            </div>
            <PersonaPreview loading={personaLoading} preview={personaPreview} t={t} />
          </div>
          <PersonaManifestEditor key={agent.id || 'new-agent'} value={agent.personaManifest} onChange={(personaManifest) => onChange({ ...agent, personaManifest })} t={t} />
          <Field label={t('agents.fieldSoul')}>
            <textarea value={agent.soulMd} onChange={(event) => onChange({ ...agent, soulMd: event.target.value })} rows={10} className="w-full rounded border border-ink/15 bg-canvas px-3 py-2 font-mono text-sm text-ink" placeholder={t('agents.soulPlaceholder')} />
          </Field>
          <Field label={t('agents.fieldIdentity')}>
            <textarea value={agent.identityMd} onChange={(event) => onChange({ ...agent, identityMd: event.target.value })} rows={6} className="w-full rounded border border-ink/15 bg-canvas px-3 py-2 font-mono text-sm text-ink" placeholder={t('agents.identityPlaceholder')} />
          </Field>
          <Field label={t('agents.fieldAvatar')}>
            <input value={agent.avatarUrl} onChange={(event) => onChange({ ...agent, avatarUrl: event.target.value })} className="w-full rounded border border-ink/15 bg-canvas px-3 py-2 text-sm text-ink" placeholder="https://..." maxLength={1024} />
          </Field>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={agent.isDefault} onChange={(event) => onChange({ ...agent, isDefault: event.target.checked })} /><Star size={14} />{t('agents.setAsDefault')}</label>
        </div>
        <footer className="flex items-center justify-end gap-2 border-t border-ink/10 px-6 py-4">
          <button onClick={onClose} className="px-4 py-2 text-sm text-ink-fade hover:text-ink">{t('common.cancel')}</button>
          <button onClick={onSave} disabled={saving} className="inline-flex items-center gap-2 rounded bg-ink px-4 py-2 text-sm text-canvas disabled:opacity-50"><Save size={14} />{saving ? t('common.saving') : t('common.save')}</button>
        </footer>
      </div>
    </div>
  )
}

function Field({ children, label }) {
  return <div><label className="mb-1 block text-xs font-medium text-ink-fade">{label}</label>{children}</div>
}

function PersonaPreview({ loading, preview, t }) {
  if (loading) return <p className="text-sm text-ink-fade">{t('common.loading')}</p>
  if (!preview) return <p className="text-sm text-ink-fade">{t('agents.personaPreview')}</p>
  return (
    <div className="space-y-2">
      <div className="text-xs text-ink-fade">{preview.description || t('agents.personaPreview')}</div>
      <div className="grid gap-2">
        {(preview.sections || []).slice(0, 5).map((section) => (
          <section key={section.title} className="rounded border border-ink/10 bg-paper-2/40 p-3">
            <div className="mb-1 text-xs font-semibold text-ink">{section.title}</div>
            <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-ink-fade">{section.body}</pre>
          </section>
        ))}
      </div>
    </div>
  )
}
