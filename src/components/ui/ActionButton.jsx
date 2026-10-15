import { LoaderCircle } from 'lucide-react'
import './ActionButton.css'

const TONES = {
  primary: 'border border-transparent bg-accent text-accent-contrast hover:bg-accent/90',
  secondary: 'border border-ink/15 bg-paper text-ink-soft hover:bg-paper-2 hover:text-ink',
  ghost: 'border border-transparent text-ink-soft hover:bg-paper-2 hover:text-ink',
  danger: 'border border-danger/30 bg-danger/10 text-danger hover:bg-danger/15',
}
const SIZES = { sm: 'min-h-8 px-3 py-1.5 text-xs', md: 'min-h-9 px-3.5 py-1.5 text-sm' }

/** Native button semantics and consistent pending/disabled feedback; no business or permission decisions. */
export default function ActionButton({ busy = false, children, className = '', disabled = false,
  selected = false, size = 'md', type = 'button', variant = 'secondary', ...props }) {
  return <button {...props} type={type} disabled={disabled || busy} aria-busy={busy || undefined}
    className={`gugo-action-button inline-flex shrink-0 items-center justify-center gap-1.5 rounded-control font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${SIZES[size] || SIZES.md} ${selected ? 'border border-focus bg-paper-2 text-focus' : TONES[variant] || TONES.secondary} ${className}`}>
    {busy && <LoaderCircle className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
    {children}
  </button>
}
