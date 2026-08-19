import { X } from 'lucide-react'
import { formatLoginCodeCountdownLabel, shouldDisableLoginCodeButton } from '../../lib/loginCountdown.js'

const inputClass = 'h-9 rounded-md border border-ink/40 bg-paper px-3 text-sm text-ink outline-none focus:border-focus'

export default function LoginModal({ login, onChange, onClose, onSendCode, onVerify, t }) {
  if (!login.open) return null
  const set = (field, value) => onChange({ [field]: value })
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/35 p-4">
    <div className="flex w-full max-w-md flex-col gap-4 rounded-md border border-ink bg-paper p-5 shadow-xl">
      <div className="flex items-center justify-between"><div><span className="font-mono text-[9px] uppercase tracking-[0.22em] text-ink-fade">LOGIN REQUIRED</span><h2 className="mt-1 font-semibold text-xl text-ink">{t('leftRailLogin.title')}</h2></div><button onClick={onClose} aria-label={t('leftRailLogin.close')} className="text-ink-fade hover:text-ink"><X className="h-4 w-4" /></button></div>
      <div className="-mt-1 flex gap-2 border-b border-ink-fade/30">
        {['password', 'code'].map((mode) => <button key={mode} type="button" onClick={() => onChange({ mode, message: '' })} className={`border-b-2 px-3 py-1.5 text-sm transition-colors ${login.mode === mode ? 'border-accent text-ink' : 'border-transparent text-ink-fade hover:text-ink-soft'}`}>{t(`leftRailLogin.${mode}Mode`)}</button>)}
      </div>
      {login.mode === 'code' && <form onSubmit={onSendCode} className="flex flex-col gap-3"><Field label={t('leftRailLogin.email')} value={login.email} onChange={(value) => set('email', value)} placeholder="you@example.com" /><button disabled={shouldDisableLoginCodeButton({ accountLoading: login.loading, loginEmail: login.email, countdown: login.countdown })} className="h-9 self-start rounded-md bg-ink px-4 text-sm text-paper disabled:cursor-not-allowed disabled:opacity-50">{formatLoginCodeCountdownLabel(login.countdown)}</button></form>}
      <form onSubmit={onVerify} className="flex flex-col gap-3">
        {login.mode === 'password' && <Field label={t('leftRailLogin.email')} value={login.email} onChange={(value) => set('email', value)} placeholder="you@example.com" autoComplete="email" />}
        <Field type={login.mode === 'password' ? 'password' : 'text'} label={t(`leftRailLogin.${login.mode === 'password' ? 'password' : 'code'}`)} value={login.mode === 'password' ? login.password : login.code} onChange={(value) => set(login.mode === 'password' ? 'password' : 'code', value)} placeholder={t(`leftRailLogin.${login.mode === 'password' ? 'passwordPlaceholder' : 'codePlaceholder'}`)} autoComplete={login.mode === 'password' ? 'current-password' : undefined} />
        <button disabled={login.loading || !login.email.trim() || (login.mode === 'password' ? !login.password : !login.code.trim())} className="h-9 self-start rounded-md bg-accent px-4 text-sm text-accent-contrast transition-colors hover:bg-accent/90 disabled:opacity-50">{t('leftRailLogin.submit')}</button>
      </form>
      {login.message && <div className="rounded-md border border-ink-fade/40 bg-paper-2 p-3 text-sm text-ink-soft">{login.message}</div>}
    </div>
  </div>
}

function Field({ label, value, onChange, type = 'text', ...props }) {
  return <label className="flex flex-col gap-1"><span className="text-xs text-ink-fade">{label}</span><input type={type} value={value} onChange={(event) => onChange(event.target.value)} className={inputClass} {...props} /></label>
}
