import { useMemo, useState } from 'react'
import { Archive, Bot, Hash, MessageCircle, Plus, User, X } from 'lucide-react'
import {
  addChannelAgentApi,
  archiveChannelApi,
  createChannelApi,
  removeChannelAgentApi,
  updateChannelApi,
} from '../../lib/channelClient.js'
import { agentLabel } from './channelViewUtils.js'

export function ChannelListGroup({ title, channels, activeId, onSelect }) {
  if (!channels.length) return null
  return (
    <section className="flex flex-col gap-1">
      <div className="px-2 font-mono text-[10px] uppercase tracking-wider text-ink-fade">{title}</div>
      {channels.map((channel) => {
        const active = channel.id === activeId
        const Icon = channel.kind === 'dm' ? MessageCircle : Hash
        return (
          <button key={channel.id} type="button" onClick={() => onSelect(channel.id)} className={`flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-2 text-left ${active ? 'border border-ink-fade/40 bg-paper-2 text-ink' : 'text-ink-soft hover:bg-paper-2/60'}`}>
            <Icon className="h-4 w-4 shrink-0 text-ink-fade" />
            <span className="min-w-0 flex-1"><span className="block truncate text-sm">{channel.name}</span><span className="block truncate text-[11px] text-ink-fade">{channel.agents?.map(agentLabel).join(', ') || 'No agents'}</span></span>
          </button>
        )
      })}
    </section>
  )
}

export function AgentChip({ agent, active, onRemove }) {
  return (
    <span className={`inline-flex h-7 max-w-40 items-center gap-1.5 rounded-md border px-2 text-xs ${active ? 'border-ember/50 bg-ember-soft text-ember' : 'border-ink-fade/40 bg-paper-2 text-ink-soft'}`}>
      <span className="truncate">{agentLabel(agent)}</span>
      {agent.role === 'owner' && <span className="font-mono text-[9px] uppercase text-ink-fade">owner</span>}
      {onRemove && <button type="button" onClick={() => onRemove(agent)} className="text-ink-fade hover:text-ink"><X className="h-3 w-3" /></button>}
    </span>
  )
}

export function SettingsPanel({ channel, agents, onClose, onUpdated, t }) {
  const [name, setName] = useState(channel.name)
  const [defaultAgentId, setDefaultAgentId] = useState(channel.defaultAgentId || '')
  const [addAgentId, setAddAgentId] = useState('')
  const [saving, setSaving] = useState(false)
  const memberIds = new Set(channel.agents?.map((agent) => agent.id) || [])
  const available = agents.filter((agent) => !memberIds.has(agent.id))
  const runUpdate = async (request, close = false) => {
    setSaving(true)
    try { onUpdated((await request()).channel); if (close) onClose() } finally { setSaving(false) }
  }
  return (
    <div className="absolute right-4 top-14 z-40 flex w-[360px] flex-col gap-4 rounded-md border border-ink-fade/40 bg-paper p-4 shadow-xl">
      <div className="flex items-center justify-between"><h2 className="font-display text-lg text-ink">{t('channels.settings')}</h2><button type="button" onClick={onClose} className="rounded p-1 text-ink-fade hover:bg-paper-2 hover:text-ink"><X className="h-4 w-4" /></button></div>
      <label className="flex flex-col gap-1.5"><span className="text-xs text-ink-fade">{t('channels.name')}</span><input value={name} onChange={(event) => setName(event.target.value)} className="h-9 rounded-md border border-ink-fade/40 bg-paper px-3 text-sm outline-none focus:border-ember" /></label>
      <label className="flex flex-col gap-1.5"><span className="text-xs text-ink-fade">{t('channels.defaultAgent')}</span><select value={defaultAgentId} onChange={(event) => setDefaultAgentId(event.target.value)} className="h-9 rounded-md border border-ink-fade/40 bg-paper px-3 text-sm"><option value="">{t('channels.noDefault')}</option>{channel.agents?.map((agent) => <option key={agent.id} value={agent.id}>{agentLabel(agent)}</option>)}</select></label>
      <button type="button" disabled={saving} onClick={() => runUpdate(() => updateChannelApi(channel.id, { name, defaultAgentId: defaultAgentId || null }))} className="h-9 rounded-md bg-ink px-3 text-sm text-paper hover:bg-ink-soft disabled:opacity-50">{saving ? t('common.saving') : t('common.save')}</button>
      <div className="flex flex-col gap-2"><span className="text-xs text-ink-fade">{t('channels.members')}</span><div className="flex flex-wrap gap-1.5">{channel.agents?.map((agent) => <AgentChip key={agent.id} agent={agent} active={agent.id === channel.defaultAgentId} onRemove={channel.agents.length > 1 ? () => runUpdate(() => removeChannelAgentApi(channel.id, agent.id)) : null} />)}</div></div>
      <div className="flex gap-2"><select value={addAgentId} onChange={(event) => setAddAgentId(event.target.value)} className="h-9 min-w-0 flex-1 rounded-md border border-ink-fade/40 bg-paper px-2 text-sm"><option value="">{t('channels.addAgent')}</option>{available.map((agent) => <option key={agent.id} value={agent.id}>{agentLabel(agent)}</option>)}</select><button type="button" disabled={!addAgentId || saving} onClick={() => runUpdate(async () => { const result = await addChannelAgentApi(channel.id, { agentId: addAgentId }); setAddAgentId(''); return result })} className="h-9 rounded-md border border-ink-fade/40 px-3 text-sm hover:bg-paper-2 disabled:opacity-50"><Plus className="h-4 w-4" /></button></div>
      {!channel.archivedAt && <button type="button" disabled={saving} onClick={() => runUpdate(() => archiveChannelApi(channel.id), true)} className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-ink-fade/40 px-3 text-sm text-ink-soft hover:bg-paper-2"><Archive className="h-4 w-4" />{t('channels.archive')}</button>}
    </div>
  )
}

export function CreateChannelPanel({ agents, onClose, onCreated, t }) {
  const [name, setName] = useState('')
  const [kind, setKind] = useState('group')
  const [selected, setSelected] = useState([])
  const [defaultAgentId, setDefaultAgentId] = useState('')
  const [saving, setSaving] = useState(false)
  const toggle = (agentId) => {
    setSelected((current) => current.includes(agentId) ? current.filter((id) => id !== agentId) : [...current, agentId])
    if (!defaultAgentId) setDefaultAgentId(agentId)
  }
  const submit = async (event) => {
    event.preventDefault()
    setSaving(true)
    try {
      const agentIds = kind === 'dm' ? selected.slice(0, 1) : selected
      onCreated((await createChannelApi({ name, kind, agentIds, defaultAgentId: defaultAgentId || agentIds[0] || null })).channel)
    } finally { setSaving(false) }
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/35 p-4">
      <form onSubmit={submit} className="flex w-full max-w-md flex-col gap-4 rounded-md border border-ink bg-paper p-5 shadow-xl">
        <div className="flex items-center justify-between"><h2 className="font-display text-xl text-ink">{t('channels.newChannel')}</h2><button type="button" onClick={onClose} className="rounded p-1 text-ink-fade hover:bg-paper-2 hover:text-ink"><X className="h-4 w-4" /></button></div>
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder={t('channels.name')} className="h-10 rounded-md border border-ink-fade/40 bg-paper px-3 text-sm outline-none focus:border-ember" />
        <div className="grid grid-cols-2 gap-1 rounded-md border border-ink-fade/40 p-1">{['group', 'dm'].map((item) => <button key={item} type="button" onClick={() => { setKind(item); setSelected([]); setDefaultAgentId('') }} className={`h-8 rounded text-sm ${kind === item ? 'bg-paper-2 text-ink' : 'text-ink-fade hover:bg-paper-2/60'}`}>{t(`channels.${item}`)}</button>)}</div>
        <div className="flex max-h-56 flex-col gap-1 overflow-y-auto">{agents.map((agent) => { const checked = selected.includes(agent.id); const disabled = kind === 'dm' && !checked && selected.length >= 1; return <label key={agent.id} className={`flex items-center gap-2 rounded-md px-2 py-2 ${disabled ? 'opacity-45' : 'hover:bg-paper-2'}`}><input type="checkbox" disabled={disabled} checked={checked} onChange={() => toggle(agent.id)} /><span className="text-sm text-ink-soft">{agentLabel(agent)}</span></label> })}</div>
        <select value={defaultAgentId} onChange={(event) => setDefaultAgentId(event.target.value)} className="h-9 rounded-md border border-ink-fade/40 bg-paper px-3 text-sm"><option value="">{t('channels.defaultAgent')}</option>{selected.map((id) => <option key={id} value={id}>{agentLabel(agents.find((item) => item.id === id))}</option>)}</select>
        <button disabled={saving || !name.trim() || selected.length === 0} className="h-10 rounded-md bg-ember text-sm text-paper hover:bg-ember/90 disabled:opacity-50">{saving ? t('common.saving') : t('channels.create')}</button>
      </form>
    </div>
  )
}

export function MentionedText({ text, agents }) {
  const aliases = useMemo(() => (agents || []).flatMap((agent) => [agent.name, agent.handle, agent.id].filter(Boolean)).sort((a, b) => b.length - a.length), [agents])
  const parts = []
  let cursor = 0
  const body = String(text || '')
  while (cursor < body.length) {
    const at = body.indexOf('@', cursor)
    if (at < 0) break
    const match = aliases.find((alias) => body.slice(at + 1).toLocaleLowerCase().startsWith(alias.toLocaleLowerCase()))
    if (!match) { cursor = at + 1; continue }
    if (at > cursor) parts.push({ text: body.slice(cursor, at), mention: false })
    parts.push({ text: body.slice(at, at + match.length + 1), mention: true })
    cursor = at + match.length + 1
  }
  if (cursor < body.length) parts.push({ text: body.slice(cursor), mention: false })
  if (!parts.length) return body
  return parts.map((part, index) => part.mention ? <mark key={index} className="rounded bg-ember-soft px-1 text-ember">{part.text}</mark> : <span key={index}>{part.text}</span>)
}

export function MessageBubble({ activeAgents, message, t }) {
  const isUser = message.senderKind === 'user'
  const agent = activeAgents.find((item) => item.id === message.senderId) || message.sender
  const time = message.createdAt ? new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
  return (
    <article className={`flex gap-3 ${isUser ? 'justify-end' : 'justify-start'}`}>
      {!isUser && <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-md border border-ink-fade/40 bg-paper-2">{agent?.avatarUrl ? <img src={agent.avatarUrl} alt="" className="h-full w-full object-cover" /> : <Bot className="h-4 w-4 text-ink-fade" />}</div>}
      <div className={`max-w-[76%] rounded-md border px-3 py-2 ${isUser ? 'border-ink bg-ink text-paper' : 'border-ink-fade/30 bg-paper-2 text-ink'}`}>
        <div className={`mb-1 flex items-center gap-2 text-[11px] ${isUser ? 'text-paper/70' : 'text-ink-fade'}`}>{isUser ? <User className="h-3 w-3" /> : <Bot className="h-3 w-3" />}<span>{isUser ? t('channels.you') : agentLabel(agent)}</span>{!isUser && <span className="rounded border border-ink-fade/30 px-1 font-mono uppercase">agent</span>}<span>{time}</span></div>
        <div className="whitespace-pre-wrap break-words text-sm leading-relaxed"><MentionedText text={message.content} agents={activeAgents} /></div>
      </div>
    </article>
  )
}
