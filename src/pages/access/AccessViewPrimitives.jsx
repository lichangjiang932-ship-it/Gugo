import { useEffect, useRef, useState } from 'react'
import { Ban, Inbox, Info, LoaderCircle, ShieldCheck } from 'lucide-react'
import { ACCESS_CAPABILITY_LEVELS } from '../../lib/accessCatalog.js'

const CAPABILITY_PRESENTATION = Object.freeze({
  [ACCESS_CAPABILITY_LEVELS.NATIVE_API]: { labelKey: 'access.capabilityNativeApi', hintKey: 'access.capabilityNativeApiHint', className: 'border-blue-200 bg-blue-50 text-blue-700' },
  [ACCESS_CAPABILITY_LEVELS.MCP_SERVER]: { labelKey: 'access.capabilityMcp', hintKey: 'access.capabilityMcpHint', className: 'border-emerald-200 bg-emerald-50 text-emerald-700' },
  [ACCESS_CAPABILITY_LEVELS.SOCIAL_BRIDGE]: { labelKey: 'access.capabilitySocialBridge', hintKey: 'access.capabilitySocialBridgeHint', className: 'border-violet-200 bg-violet-50 text-violet-700' },
  [ACCESS_CAPABILITY_LEVELS.BROWSER_SHORTCUT]: { labelKey: 'access.capabilityBrowserNative', hintKey: 'access.capabilityBrowserNativeHint', className: 'border-amber-200 bg-amber-50 text-amber-800' },
})

const CONNECTION_METHOD_KEYS = Object.freeze({
  built_in: 'access.methodBuiltIn', oauth: 'access.methodOAuth', qr: 'access.methodQr', bot_token: 'access.methodBotToken',
  app_credentials: 'access.methodAppCredentials', mail_password: 'access.methodMailPassword', mcp: 'access.methodMcp',
  browser: 'access.methodBrowser', qr_browser: 'access.methodQrBrowser',
})

export function ConnectorSection({ title, hint, children }) {
  return <section><div className="mb-3"><h2 className="font-semibold text-xl text-ink">{title}</h2><p className="mt-0.5 text-xs text-ink-fade">{hint}</p></div><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{children}</div></section>
}

export function ConnectorCapabilityBadge({ capabilityLevel, t }) {
  const presentation = CAPABILITY_PRESENTATION[capabilityLevel]
  if (!presentation) return null
  return <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-medium ${presentation.className}`} data-testid={`connector-capability-${capabilityLevel}`} data-capability-level={capabilityLevel}>{t(presentation.labelKey)}</span>
}

export function ConnectionMethodBadge({ method, t }) {
  const key = CONNECTION_METHOD_KEYS[method]
  if (!key) return null
  return <span className="inline-flex rounded-full border border-ink-fade/30 bg-paper-2 px-2 py-0.5 text-[10px] text-ink-soft" data-connection-method={method}>{t(key)}</span>
}

export function CapabilityLegend({ t }) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef(null)
  const triggerRef = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    const handlePointerDown = (event) => {
      if (!containerRef.current?.contains(event.target)) setOpen(false)
    }
    const handleKeyDown = (event) => {
      if (event.key !== 'Escape') return
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('mousedown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="access-capability-popover"
        onClick={() => setOpen((current) => !current)}
        className="inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full border border-ink-fade/40 bg-paper px-3 text-xs text-ink-soft transition-colors hover:border-ink-fade hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/45"
        data-testid="access-capability-help"
      >
        <Info className="h-3.5 w-3.5" aria-hidden="true" />
        {t('access.capabilityLegend')}
      </button>
      {open && (
        <aside
          id="access-capability-popover"
          role="dialog"
          aria-label={t('access.capabilityLegend')}
          className="absolute right-0 top-10 z-30 w-[min(22rem,calc(100vw-3rem))] rounded-xl border border-ink-fade/30 bg-paper p-3 shadow-xl"
          data-testid="access-capability-popover"
        >
          <div className="space-y-2.5">{Object.entries(CAPABILITY_PRESENTATION).map(([level, presentation]) => <div key={level} className="flex items-start gap-2 text-xs text-ink-soft"><ConnectorCapabilityBadge capabilityLevel={level} t={t} /><span className="leading-5">{t(presentation.hintKey)}</span></div>)}</div>
        </aside>
      )}
    </div>
  )
}

export function Toggle({ enabled, onClick, disabled, label }) {
  return <button type="button" onClick={onClick} disabled={disabled} aria-label={label} aria-pressed={enabled} className={`relative h-6 w-11 rounded-full transition-colors disabled:opacity-50 ${enabled ? 'bg-blue-600' : 'bg-ink-fade/40'}`}><span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-all ${enabled ? 'left-[22px]' : 'left-0.5'}`} /></button>
}

export function BridgeInboundInbox({ messages, busyId, highlightedId, onAllow, onReject, t }) {
  if (!Array.isArray(messages) || messages.length === 0) return null
  return (
    <section className="mb-7 rounded-2xl border border-amber-300/70 bg-amber-50/60 p-4 shadow-sm" data-testid="bridge-inbound-inbox">
      <div className="flex items-start gap-3"><span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-amber-100 text-amber-800"><Inbox className="h-4 w-4" /></span><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><h2 className="font-semibold text-xl text-ink">{t('access.inboundInboxTitle')}</h2>{messages.length > 0 && <span className="rounded-full bg-amber-200/70 px-2 py-0.5 text-[10px] font-medium text-amber-900">{messages.length}</span>}</div><p className="mt-0.5 text-xs leading-5 text-ink-soft">{t('access.inboundInboxHint')}</p></div></div>
      <div className="mt-4 space-y-3">{messages.map((message) => <InboundMessage key={message.id} message={message} busy={busyId === message.id} highlighted={highlightedId === message.id} onAllow={onAllow} onReject={onReject} t={t} />)}</div>
    </section>
  )
}

function InboundMessage({ message, busy, highlighted, onAllow, onReject, t }) {
  const sender = message.senderName || message.externalUserId || t('access.unknownSender')
  const text = message.payload?.text?.trim()
  const attachmentCount = Array.isArray(message.payload?.attachments) ? message.payload.attachments.length : 0
  const date = new Date(message.createdAt)
  return (
    <article id={`bridge-parking-${message.id}`} className={`rounded-xl border bg-paper p-4 transition-shadow ${highlighted ? 'border-accent ring-2 ring-accent/25 shadow-md' : 'border-amber-200'}`} data-testid={`bridge-parking-${message.id}`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><strong className="text-sm font-medium text-ink">{sender}</strong><span className="rounded-full border border-ink-fade/30 bg-paper-2 px-2 py-0.5 font-mono text-[9px] uppercase tracking-wide text-ink-fade">{message.provider}</span><time dateTime={Number.isNaN(date.getTime()) ? undefined : date.toISOString()} className="text-[10px] text-ink-fade">{Number.isNaN(date.getTime()) ? '' : date.toLocaleString()}</time></div><p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-ink-soft">{text || t('access.attachmentMessage').replace('{count}', String(attachmentCount))}</p></div><div className="flex shrink-0 flex-wrap gap-2 sm:justify-end"><button type="button" disabled={busy} onClick={() => onReject(message.id)} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-red-200 px-3 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50"><Ban className="h-3.5 w-3.5" />{t('access.rejectSender')}</button><button type="button" disabled={busy} onClick={() => onAllow(message.id)} className="inline-flex h-8 min-w-28 items-center justify-center gap-1.5 rounded-md bg-ink px-3 text-xs text-paper hover:bg-ink-soft disabled:opacity-50">{busy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}{busy ? t('access.delivering') : t('access.allowAndDeliver')}</button></div></div>
    </article>
  )
}
