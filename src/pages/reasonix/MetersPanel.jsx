import { useEffect, useState } from 'react'
import { Activity } from 'lucide-react'
import { listMeters } from '../../lib/reasonixClient.js'
import Section from './Section.jsx'

export default function MetersPanel({ copy }) {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  useEffect(() => { let alive = true; listMeters(20).then((result) => { if (alive) { setItems(result.meters || []); setError('') } }).catch((caught) => { if (alive) setError(caught.message) }).finally(() => { if (alive) setLoading(false) }); return () => { alive = false } }, [])
  return <Section icon={Activity} title={copy.title} subtitle={copy.subtitle}>
    {error && <div className="mb-3 rounded-md border border-ember/40 bg-ember-soft/30 p-2 text-sm text-ember">{error}</div>}
    {loading ? <div className="text-sm text-ink-fade">{copy.loading}</div> : items.length === 0 ? <div className="rounded-md border border-dashed border-ink-fade/40 p-8 text-center text-sm text-ink-fade">{copy.empty}</div> : <div className="overflow-x-auto rounded-md border border-ink-fade/30"><table className="w-full text-sm"><thead className="bg-ink/5 text-ink-soft"><tr>{copy.headers.map((header, index) => <th key={header} className={`px-3 py-2 font-normal ${index ? 'text-right' : 'text-left'}`}>{header}</th>)}</tr></thead><tbody className="divide-y divide-ink-fade/20">{items.map((item) => <tr key={item.sessionId}><td className="max-w-[160px] truncate px-3 py-2 font-mono text-xs text-ink-soft">{item.sessionId}</td><td className="px-3 py-2 text-right">{item.turns}</td><td className="px-3 py-2 text-right font-mono">{item.tokensIn.toLocaleString()}</td><td className="px-3 py-2 text-right font-mono">{item.tokensOut.toLocaleString()}</td><td className="px-3 py-2 text-right font-mono">{(item.cacheHitRate * 100).toFixed(1)}%</td></tr>)}</tbody></table></div>}
  </Section>
}
