export default function Section({ icon: Icon, title, subtitle, action, children }) {
  return <section className="rounded-lg border border-ink/20 bg-paper p-5">
    <header className="mb-4 flex items-start justify-between gap-3 border-b border-ink-fade/30 pb-3">
      <div className="flex items-start gap-3"><div className="flex h-9 w-9 items-center justify-center rounded-md bg-ink/5 text-ink"><Icon className="h-4 w-4" /></div><div><h2 className="font-hand text-xl leading-tight text-ink">{title}</h2>{subtitle && <p className="mt-0.5 text-sm text-ink-soft">{subtitle}</p>}</div></div>
      {action}
    </header>
    {children}
  </section>
}
