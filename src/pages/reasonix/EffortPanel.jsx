import { useCallback, useEffect, useState } from 'react'
import { Gauge, Sparkles } from 'lucide-react'
import { getEffort, setEffort } from '../../lib/reasonixClient.js'
import Section from './Section.jsx'

export default function EffortPanel({ copy }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const refresh = useCallback(async () => { try { setData((await getEffort()).effort); setError('') } catch (caught) { setError(caught.message) } }, [])
  // eslint-disable-next-line react-hooks/set-state-in-effect -- mount-time async fetch; state updates happen after the request settles.
  useEffect(() => { refresh() }, [refresh])
  const change = async (effort) => { try { setData((await setEffort(effort)).effort); setError('') } catch (caught) { setError(caught.message) } }
  if (!data) return <Section icon={Gauge} title={copy.title} subtitle={copy.loading}>{error && <div className="text-sm text-danger">{error}</div>}</Section>
  return <Section icon={Gauge} title={copy.title} subtitle={copy.subtitle}>
    <div className="grid grid-cols-2 gap-2 md:grid-cols-4">{Object.entries(data.presets).map(([id, preset]) => {
      const active = data.effort === id
      return <button key={id} onClick={() => change(id)} className={`rounded-md border p-3 text-left transition-colors ${active ? 'border-accent bg-accent-soft/40' : 'border-ink/30 hover:border-ink-fade'}`}><div className="flex items-center justify-between"><span className="font-semibold text-lg text-ink">{preset.label}</span>{active && <Sparkles className="h-4 w-4 text-accent-ink" />}</div><div className="mt-2 font-mono text-xs text-ink-soft">{copy.preset(preset.maxSteps, preset.reasoningDepth)}</div></button>
    })}</div>
    {error && <div className="mt-3 text-sm text-danger">{error}</div>}
  </Section>
}
