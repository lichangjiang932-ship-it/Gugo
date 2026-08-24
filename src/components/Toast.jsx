import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react'

const ToastContext = createContext(null)
const DEFAULT_DURATION = 3500

const ICONS = {
  info: Info,
  success: CheckCircle2,
  warn: AlertTriangle,
  error: XCircle,
}

function normalizeToast(input, type) {
  if (typeof input === 'string') return { title: input, body: '', type }
  return {
    title: input?.title || input?.message || '',
    body: input?.body || '',
    type: input?.type || type,
    duration: input?.duration,
  }
}

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])

  const removeToast = useCallback((id) => {
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  const show = useCallback((input, options = {}) => {
    const toast = normalizeToast(input, options.type || 'info')
    if (!toast.title && !toast.body) return null
    const id = crypto.randomUUID?.() || `toast-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const duration = options.duration ?? toast.duration ?? DEFAULT_DURATION
    const next = {
      id,
      type: ['info', 'success', 'warn', 'error'].includes(toast.type) ? toast.type : 'info',
      title: toast.title,
      body: toast.body,
    }
    setToasts((current) => [...current, next].slice(-5))
    if (duration > 0) {
      window.setTimeout(() => removeToast(id), duration)
    }
    return id
  }, [removeToast])

  const value = useMemo(() => ({
    show,
    info: (input, options) => show(input, { ...options, type: 'info' }),
    success: (input, options) => show(input, { ...options, type: 'success' }),
    warn: (input, options) => show(input, { ...options, type: 'warn' }),
    error: (input, options) => show(input, { ...options, type: 'error' }),
    removeToast,
  }), [removeToast, show])

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-layer fixed top-20 right-4 flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2 pointer-events-none" aria-live="polite" aria-relevant="additions">
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onClose={() => removeToast(toast.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  )
}

function ToastItem({ toast, onClose }) {
  const Icon = ICONS[toast.type] || Info
  const tone =
    toast.type === 'success'
      ? 'border-success/40 text-success'
      : toast.type === 'warn'
      ? 'border-warning/50 text-warning'
      : toast.type === 'error'
      ? 'border-danger/45 text-danger'
      : 'border-cyan/40 text-cyan'
  return (
    <div className={`pointer-events-auto rounded-md border bg-paper shadow-lg px-3 py-2.5 flex items-start gap-2 ${tone}`}>
      <Icon className="w-4 h-4 mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        {toast.title && <p className="text-sm font-medium text-ink leading-snug">{toast.title}</p>}
        {toast.body && <p className="text-xs text-ink-soft leading-relaxed mt-0.5">{toast.body}</p>}
      </div>
      <button
        type="button"
        onClick={onClose}
        className="w-6 h-6 shrink-0 inline-flex items-center justify-center rounded text-ink-fade hover:bg-ink/10 hover:text-ink"
        aria-label="Close toast"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useToast() {
  const ctx = useContext(ToastContext)
  if (ctx) return ctx
  return {
    show: () => null,
    info: () => null,
    success: () => null,
    warn: () => null,
    error: () => null,
    removeToast: () => {},
  }
}
