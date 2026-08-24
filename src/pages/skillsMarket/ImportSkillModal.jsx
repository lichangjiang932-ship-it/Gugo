import { X } from 'lucide-react'
import Modal from '../../components/Modal.jsx'

export default function ImportSkillModal({ market, t }) {
  const { preview, error, busy } = market.importState
  if (!preview && !error) return null
  return (
    <Modal onClose={market.closeImport} ariaLabelledby="import-skill-modal-title" className="max-w-lg p-6 flex flex-col gap-4">
        <div className="flex items-center justify-between"><h2 id="import-skill-modal-title" className="font-semibold text-xl text-ink">{t('skillsMarket.importPack')}</h2><button type="button" onClick={market.closeImport} className="text-ink-fade hover:text-ink" aria-label={t('skillsMarket.close')}><X className="w-4 h-4" /></button></div>
        {error ? <div className="p-3 border border-danger/35 bg-danger/5 rounded-md text-sm text-danger">{error}</div> : <Preview preview={preview} t={t} />}
        <div className="flex gap-2 justify-end"><button type="button" onClick={market.closeImport} className="btn-ghost">{t('skillsMarket.cancel')}</button>{!error && <button type="button" onClick={market.confirmImport} disabled={busy} className="btn-primary">{busy ? t('skillsMarket.importing') : t('skillsMarket.confirmImport')}</button>}</div>
    </Modal>
  )
}

function Preview({ preview, t }) {
  return <><div className="grid grid-cols-2 gap-3 text-sm"><Item label="ID" value={preview?.id} /><Item label={t('skillsMarket.version')} value={preview?.version} /><Item wide label={t('skillsMarket.name')} value={preview?.name} /><Item wide label={t('skillsMarket.description')} value={preview?.description} /></div><div className="rounded-md border border-dashed border-ink-fade/40 p-3"><p className="text-xs text-ink-fade mb-1">{t('skillsMarket.promptPreview')}</p><p className="text-sm text-ink-soft whitespace-pre-wrap">{preview?.promptPreview}</p></div></>
}

function Item({ label, value, wide }) {
  return <div className={wide ? 'col-span-2' : ''}><p className="text-ink-fade">{label}</p><p className="text-ink">{value}</p></div>
}
