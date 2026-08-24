import { X } from 'lucide-react'
import Modal from '../../components/Modal.jsx'

export default function CustomSkillModal({ market, t }) {
  if (!market.customModal) return null
  const update = (field, value, clearError = false) => {
    market.setDraft((current) => ({ ...current, [field]: value }))
    if (clearError) market.setDraftError('')
  }
  return (
    <Modal onClose={() => market.setCustomModal(false)} ariaLabelledby="custom-skill-modal-title" className="max-w-md p-6 flex flex-col gap-4">
        <div className="flex items-center justify-between"><h2 id="custom-skill-modal-title" className="font-semibold text-xl text-ink">{t('skillsMarket.newCustom')}</h2><button type="button" onClick={() => market.setCustomModal(false)} className="text-ink-fade hover:text-ink" aria-label={t('skillsMarket.close')}><X className="w-4 h-4" /></button></div>
        <div className="flex flex-col gap-3 text-sm">
          <Field label={t('skillsMarket.commandId')}><input value={market.draft.id} onChange={(event) => update('id', event.target.value, true)} placeholder="my-skill" className="field-input" /></Field>
          <div className="grid grid-cols-[1fr_60px] gap-2">
            <Field label={t('skillsMarket.name')}><input value={market.draft.name} onChange={(event) => update('name', event.target.value, true)} placeholder={t('skillsMarket.namePlaceholder')} className="field-input" /></Field>
            <Field label={t('skillsMarket.icon')}><input value={market.draft.icon} onChange={(event) => update('icon', event.target.value)} maxLength={2} className="field-input px-2 text-center text-lg" /></Field>
          </div>
          <Field label={t('skillsMarket.description')}><textarea value={market.draft.desc} onChange={(event) => update('desc', event.target.value)} rows={2} placeholder={t('skillsMarket.descriptionPlaceholder')} className="field-area" /></Field>
          <Field label={t('skillsMarket.instructions')}><textarea value={market.draft.systemPrompt} onChange={(event) => update('systemPrompt', event.target.value, true)} rows={5} placeholder={t('skillsMarket.instructionsPlaceholder')} className="field-area resize-y" /></Field>
          <Field label={t('skillsMarket.permissions')}><input value={market.draft.perms} onChange={(event) => update('perms', event.target.value)} placeholder={t('skillsMarket.permissionsPlaceholder')} className="field-input" /></Field>
        </div>
        {market.draftError && <div className="p-2 border border-danger/35 bg-danger/5 rounded-md text-sm text-danger">{market.draftError}</div>}
        <div className="flex gap-2 justify-end"><button type="button" onClick={() => market.setCustomModal(false)} className="btn-ghost">{t('skillsMarket.cancel')}</button><button type="button" onClick={market.saveCustomSkill} disabled={!market.draft.id.trim() || !market.draft.name.trim() || !market.draft.systemPrompt.trim()} className="btn-primary">{t('skillsMarket.create')}</button></div>
    </Modal>
  )
}

function Field({ label, children }) {
  return <label className="flex flex-col gap-1"><span className="font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade">{label}</span>{children}</label>
}
