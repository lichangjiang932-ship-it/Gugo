export default function StepDot({ status }) {
  const colors = { completed: 'bg-ink', running: 'bg-ember', failed: 'bg-red-500', cancelled: 'bg-ink-fade' }
  return <span className={`w-2.5 h-2.5 rounded-full ${colors[status] || 'bg-ink-ghost'}`} aria-hidden="true" />
}
