import { ChevronDown, Circle, TestTube2, X } from 'lucide-react'
import IntegrationToggle from './IntegrationToggle.jsx'
import { normalizeFields, SECRET_SENTINEL } from './integrationFormUtils.js'
import Modal from '../Modal.jsx'

function Field({ field, form, onChange, t }) {
  const value = field.location === 'secret' ? form.secret?.[field.key] || '' : form.config?.[field.key] || ''
  return <label className="flex flex-col gap-1.5">
    <span className="text-xs text-ink-fade">{field.label}</span>
    {field.type === 'select' ? <select value={value} onChange={(event) => onChange(field, event.target.value)} className="h-10 px-3 rounded-md border border-ink-fade/40 bg-paper text-sm outline-none focus:border-focus"><option value="">-</option>{field.options.map((option) => <option key={option} value={option}>{option}</option>)}</select>
      : <input type={field.type === 'password' ? 'password' : field.type === 'url' ? 'url' : 'text'} value={value} placeholder={field.type === 'password' && form.id ? t('integrations.secretPlaceholder') : ''} onFocus={() => { if (field.location === 'secret' && value === SECRET_SENTINEL) onChange(field, '') }} onChange={(event) => onChange(field, event.target.value)} className="h-10 px-3 rounded-md border border-ink-fade/40 bg-paper text-sm outline-none focus:border-focus" />}
  </label>
}

function WechatQrCard({ qr, state, onRefresh, t }) {
  return <div className="rounded-md border border-ink-fade/30 p-3 flex flex-col gap-3">
    <div className="flex items-center justify-between gap-3"><span className="text-sm text-ink-soft">{t('access.wechatDesc')}</span><button type="button" onClick={onRefresh} className="h-8 px-3 rounded-md border border-ink-fade/40 text-xs text-ink-soft hover:bg-paper-2">{t('access.qrLoading')}</button></div>
    {qr?.qrcodeUrl && <div className="flex flex-col sm:flex-row items-center gap-3">
      <div className="relative w-40 h-40 shrink-0"><img src={qr.qrcodeUrl} alt="WeChat QR code" className={`w-40 h-40 rounded-md border border-ink-fade/30 bg-white ${['expired', 'timeout', 'error'].includes(state.phase) ? 'opacity-40 grayscale' : ''}`} />{['expired', 'timeout', 'error'].includes(state.phase) && <button type="button" onClick={onRefresh} className="absolute inset-0 m-auto h-9 w-28 rounded-md bg-ink text-paper text-xs hover:bg-ink-soft self-center">{t('wechat.qr.refresh')}</button>}</div>
      <div className="flex flex-col gap-2 min-w-0">
        {state.phase === 'ready' && <span className="inline-flex items-center gap-1.5 self-start h-6 px-2 rounded-full bg-paper-2 text-xs text-ink-soft font-mono"><Circle className="w-2 h-2 fill-current text-success" />{t('wechat.qr.expiresIn', { seconds: state.secondsLeft })}</span>}
        {state.statusText && !['expired', 'timeout', 'error'].includes(state.phase) && <span className="text-xs text-ink-soft leading-relaxed">{state.statusText}</span>}
        {['expired', 'timeout', 'error'].includes(state.phase) && state.errorText && <span className="text-xs text-danger leading-relaxed">{state.errorText}</span>}
        <span className="text-xs text-ink-fade leading-relaxed">{t('access.wechatHint')}</span>
      </div>
    </div>}
  </div>
}

export default function IntegrationEditor({ form, meta, saving, testingId, testMessage, wechatQr, wechatState, onChange, onSave, onTest, onWechatQr, onClose, t }) {
  const fields = normalizeFields(meta)
  const requiredFields = fields.filter((field) => !field.optional)
  const optionalFields = fields.filter((field) => field.optional)
  return <Modal onClose={onClose} closeOnBackdrop={false} ariaLabelledby="integration-editor-title" className="max-w-lg border-ink">
    <form onSubmit={onSave} className="max-h-[88vh] overflow-y-auto p-5 flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3"><div><h2 id="integration-editor-title" className="font-display text-xl text-ink">{meta?.label || form.provider}</h2><div className="font-mono text-[10px] text-ink-fade">{form.provider}</div></div><button type="button" onClick={onClose} className="p-1 rounded hover:bg-paper-2 text-ink-fade hover:text-ink"><X className="w-4 h-4" /></button></div>
      <label className="flex flex-col gap-1.5"><span className="text-xs text-ink-fade">{t('integrations.name')}</span><input value={form.name} onChange={(event) => onChange('name', event.target.value)} className="h-10 px-3 rounded-md border border-ink-fade/40 bg-paper text-sm outline-none focus:border-focus" /></label>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">{requiredFields.map((field) => <Field key={`${field.location}.${field.key}`} field={field} form={form} onChange={onChange} t={t} />)}</div>
      {!!optionalFields.length && <details className="rounded-md border border-ink-fade/30 px-3 py-2 group"><summary className="cursor-pointer text-sm text-ink-soft select-none list-none flex items-center gap-1.5"><ChevronDown className="w-3.5 h-3.5 transition-transform group-open:rotate-180" />{t('integrations.advancedOptions')}</summary><div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-3">{optionalFields.map((field) => <Field key={`${field.location}.${field.key}`} field={field} form={form} onChange={onChange} t={t} />)}</div></details>}
      {form.provider === 'wechat_personal' && <WechatQrCard qr={wechatQr} state={wechatState} onRefresh={onWechatQr} t={t} />}
      <label className="flex items-center justify-between gap-3 rounded-md border border-ink-fade/30 p-3"><span className="text-sm text-ink-soft">{form.enabled ? t('integrations.enabled') : t('integrations.disabled')}</span><IntegrationToggle enabled={form.enabled} onClick={() => onChange('enabled', !form.enabled)} label={t('integrations.enabled')} /></label>
      {testMessage && <div className="rounded-md border border-ink-fade/40 bg-paper-2 px-3 py-2 text-sm text-ink-soft">{testMessage}</div>}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button type="button" onClick={() => form.id && onTest(form.id, { inline: true })} disabled={!form.id || testingId === form.id} className="h-9 px-3 rounded-md border border-ink-fade/40 text-sm text-ink-soft hover:bg-paper-2 disabled:opacity-50 inline-flex items-center gap-1.5"><TestTube2 className="w-3.5 h-3.5" />{testingId === form.id ? t('integrations.testing') : t('integrations.test')}</button>
        <div className="flex gap-2"><button type="button" onClick={onClose} className="h-9 px-4 rounded-md border border-ink-fade/40 text-sm text-ink-soft hover:bg-paper-2">{t('integrations.cancel')}</button><button disabled={saving || !form.name.trim()} className="h-9 px-4 rounded-md bg-accent text-accent-contrast text-sm hover:bg-accent/90 disabled:opacity-50">{form.enabled ? `${t('integrations.save')} & ${t('integrations.enabled')}` : t('integrations.save')}</button></div>
      </div>
    </form>
  </Modal>
}
