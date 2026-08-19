export default function IntegrationToggle({ enabled, onClick, disabled, label }) {
  return <button type="button" onClick={onClick} disabled={disabled} aria-label={label} aria-pressed={enabled} className={`relative w-10 h-5 rounded-full transition-colors shrink-0 disabled:opacity-50 ${enabled ? 'bg-accent' : 'bg-ink-fade/40'}`}>
    <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-paper transition-all ${enabled ? 'left-[22px]' : 'left-0.5'}`} />
  </button>
}
