import { Check, Circle, Pencil, TestTube2, Trash2, X } from 'lucide-react'
import IntegrationToggle from './IntegrationToggle.jsx'
import { formatTestTime, getLastTest } from './integrationFormUtils.js'
import { providerIcon } from './providerIcon.js'

export default function IntegrationList({ integrations, providersById, testingId, onTest, onEdit, onToggle, onRemove, t }) {
  return <div className="flex flex-col gap-2">{integrations.map((integration) => {
    const meta = providersById[integration.provider]
    const Icon = providerIcon(integration.provider)
    const lastTest = getLastTest(integration)
    const statusTone = lastTest?.ok === true ? 'text-emerald-700' : lastTest?.ok === false ? 'text-red-700' : 'text-ink-fade'
    const StatusIcon = lastTest?.ok === true ? Check : lastTest?.ok === false ? X : Circle
    return <div key={integration.id} className="p-3 border border-ink-fade/30 rounded-md flex flex-col md:flex-row md:items-center gap-3">
      <div className="flex items-center gap-3 min-w-0 md:w-64"><span className="w-9 h-9 rounded-md border border-ink-fade/40 flex items-center justify-center shrink-0 bg-paper-2"><Icon className="w-4 h-4 text-ink-soft" /></span><span className="min-w-0"><span className="block text-sm text-ink truncate">{integration.name || meta?.label || integration.provider}</span><span className="inline-flex mt-1 h-5 px-1.5 rounded border border-ink-fade/40 bg-paper-2 font-mono text-[10px] text-ink-fade items-center">{meta?.label || integration.provider}</span></span></div>
      <div className="flex-1 min-w-0 font-mono text-[10px] text-ink-fade flex items-center gap-2" title={lastTest?.message || ''}><StatusIcon className={`w-3.5 h-3.5 ${statusTone}`} /><span className={statusTone}>{lastTest ? t('integrations.lastTest', { time: formatTestTime(lastTest.at) }) : t('integrations.lastTestNever')}</span></div>
      <div className="flex items-center justify-end gap-2">
        <button type="button" onClick={() => onTest(integration.id)} disabled={testingId === integration.id} className="h-8 px-2 rounded-md border border-ink-fade/40 text-xs text-ink-soft hover:bg-paper-2 disabled:opacity-50 inline-flex items-center gap-1"><TestTube2 className="w-3.5 h-3.5" />{testingId === integration.id ? t('integrations.testing') : t('integrations.test')}</button>
        <button type="button" onClick={() => onEdit(integration)} className="w-8 h-8 rounded-md border border-ink-fade/40 text-ink-soft hover:bg-paper-2 inline-flex items-center justify-center" title={t('common.save')}><Pencil className="w-3.5 h-3.5" /></button>
        <IntegrationToggle enabled={integration.enabled !== false} onClick={() => onToggle(integration, integration.enabled === false)} label={integration.enabled === false ? t('integrations.disabled') : t('integrations.enabled')} />
        <button type="button" onClick={() => onRemove(integration)} className="w-8 h-8 rounded-md border border-accent-line text-accent-ink hover:bg-accent-soft inline-flex items-center justify-center" title={t('integrations.delete')}><Trash2 className="w-3.5 h-3.5" /></button>
      </div>
    </div>
  })}</div>
}
