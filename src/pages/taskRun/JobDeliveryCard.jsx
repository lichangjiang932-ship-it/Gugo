import { AlertTriangle, CheckCircle2 } from 'lucide-react'

export default function JobDeliveryCard({ finalStep, evidence, t }) {
  if (!finalStep?.output) return null
  const issues = Array.isArray(finalStep.output.issues) ? finalStep.output.issues : []
  const incomplete = finalStep.output.complete === false || issues.length > 0
  return (
    <section className={`rounded-md border p-4 ${incomplete ? 'border-warning/40 bg-warning/5' : 'border-success/40 bg-success/5'}`}>
      <div className="flex items-center gap-2">{incomplete ? <AlertTriangle className="w-4 h-4 text-warning" /> : <CheckCircle2 className="w-4 h-4 text-success" />}<h3 className="font-semibold text-lg text-ink">{t(incomplete ? 'taskCenter.deliveryIncomplete' : 'taskCenter.delivery')}</h3></div>
      {finalStep.output.summary && <p className={`mt-2 text-sm font-medium ${incomplete ? 'text-warning' : 'text-ink'}`}>{finalStep.output.summary}</p>}
      {issues.length > 0 && <ul className="mt-2 space-y-1 border-l-2 border-warning/50 pl-3">{issues.map((issue) => <li key={issue} className="text-xs leading-5 text-warning">{issue}</li>)}</ul>}
      {finalStep.output.text && <div className="mt-2 max-h-72 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-6 text-ink-soft">{finalStep.output.text}</div>}
      {evidence.length > 0 && <details className="mt-3 border-t border-dashed border-ink-fade/40 pt-3"><summary className="cursor-pointer text-xs font-medium text-ink">{t('taskCenter.evidence', { count: evidence.length })}</summary><div className="mt-2 space-y-2">{evidence.map((item, index) => <p key={`${index}-${item.slice(0, 24)}`} className="whitespace-pre-wrap break-words text-xs leading-5 text-ink-soft">{item}</p>)}</div></details>}
    </section>
  )
}
