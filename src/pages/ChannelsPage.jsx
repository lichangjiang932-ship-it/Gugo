import { useEffect, useMemo, useRef, useState } from 'react'
import { Archive, Bot, ChevronDown, Hash, MessageCircle, Plus, Send, Settings, User, X } from 'lucide-react'
import LeftRail from '../components/LeftRail'
import MentionsAutocomplete from '../components/MentionsAutocomplete.jsx'
import { applyMention, getMentionQuery } from '../components/mentionsAutocompleteLogic.js'
import { useT } from '../i18n/I18nProvider.jsx'
import { listAgentsApi } from '../lib/agentClient.js'
import { getAuthToken } from '../lib/accountClient.js'
import {
  addChannelAgentApi,
  archiveChannelApi,
  channelStreamUrl,
  createChannelApi,
  listChannelMessagesApi,
  listChannelsApi,
  removeChannelAgentApi,
  sendChannelMessageApi,
  updateChannelApi,
} from '../lib/channelClient.js'

function groupChannels(channels) {
  return {
    dm: channels.filter((channel) => channel.kind === 'dm' && !channel.archivedAt),
    group: channels.filter((channel) => channel.kind !== 'dm' && !channel.archivedAt),
    archived: channels.filter((channel) => channel.archivedAt),
  }
}

function agentLabel(agent) {
  return agent?.name || agent?.id || 'Agent'
}

function formatTime(ts) {
  if (!ts) return ''
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function MentionedText({ text, agents }) {
  const aliases = useMemo(() => {
    const out = []
    for (const agent of agents || []) {
      if (agent.name) out.push(agent.name)
      if (agent.handle) out.push(agent.handle)
      if (agent.id) out.push(agent.id)
    }
    return out.sort((a, b) => b.length - a.length)
  }, [agents])
  const parts = []
  let cursor = 0
  const body = String(text || '')
  while (cursor < body.length) {
    const at = body.indexOf('@', cursor)
    if (at < 0) break
    const match = aliases.find((alias) => body.slice(at + 1).toLocaleLowerCase().startsWith(alias.toLocaleLowerCase()))
    if (!match) {
      cursor = at + 1
      continue
    }
    if (at > cursor) parts.push({ text: body.slice(cursor, at), mention: false })
    parts.push({ text: body.slice(at, at + match.length + 1), mention: true })
    cursor = at + match.length + 1
  }
  if (cursor < body.length) parts.push({ text: body.slice(cursor), mention: false })
  if (!parts.length) return body
  return parts.map((part, index) => part.mention ? (
    <mark key={index} className="rounded bg-ember-soft px-1 text-ember">{part.text}</mark>
  ) : (
    <span key={index}>{part.text}</span>
  ))
}

function ChannelListGroup({ title, channels, activeId, onSelect }) {
  if (!channels.length) return null
  return (
    <section className="flex flex-col gap-1">
      <div className="px-2 text-[10px] font-mono uppercase tracking-wider text-ink-fade">{title}</div>
      {channels.map((channel) => {
        const active = channel.id === activeId
        const Icon = channel.kind === 'dm' ? MessageCircle : Hash
        return (
          <button
            key={channel.id}
            type="button"
            onClick={() => onSelect(channel.id)}
            className={`w-full min-w-0 flex items-center gap-2 px-2 py-2 rounded-md text-left ${
              active ? 'bg-paper-2 border border-ink-fade/40 text-ink' : 'text-ink-soft hover:bg-paper-2/60'
            }`}
          >
            <Icon className="w-4 h-4 shrink-0 text-ink-fade" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm truncate">{channel.name}</span>
              <span className="block text-[11px] text-ink-fade truncate">
                {channel.agents?.map(agentLabel).join(', ') || 'No agents'}
              </span>
            </span>
          </button>
        )
      })}
    </section>
  )
}

function AgentChip({ agent, active, onRemove }) {
  return (
    <span className={`inline-flex items-center gap-1.5 h-7 max-w-40 px-2 rounded-md border text-xs ${
      active ? 'border-ember/50 bg-ember-soft text-ember' : 'border-ink-fade/40 bg-paper-2 text-ink-soft'
    }`}>
      <span className="truncate">{agentLabel(agent)}</span>
      {agent.role === 'owner' ? <span className="font-mono text-[9px] uppercase text-ink-fade">owner</span> : null}
      {onRemove ? (
        <button type="button" onClick={() => onRemove(agent)} className="text-ink-fade hover:text-ink">
          <X className="w-3 h-3" />
        </button>
      ) : null}
    </span>
  )
}

function SettingsPanel({ channel, agents, onClose, onUpdated, t }) {
  const [name, setName] = useState(channel.name)
  const [defaultAgentId, setDefaultAgentId] = useState(channel.defaultAgentId || '')
  const [addAgentId, setAddAgentId] = useState('')
  const [saving, setSaving] = useState(false)
  const memberIds = new Set(channel.agents?.map((agent) => agent.id) || [])
  const available = agents.filter((agent) => !memberIds.has(agent.id))

  const saveBasics = async () => {
    setSaving(true)
    try {
      const data = await updateChannelApi(channel.id, { name, defaultAgentId: defaultAgentId || null })
      onUpdated(data.channel)
    } finally {
      setSaving(false)
    }
  }

  const addAgent = async () => {
    if (!addAgentId) return
    setSaving(true)
    try {
      const data = await addChannelAgentApi(channel.id, { agentId: addAgentId })
      setAddAgentId('')
      onUpdated(data.channel)
    } finally {
      setSaving(false)
    }
  }

  const removeAgent = async (agent) => {
    setSaving(true)
    try {
      const data = await removeChannelAgentApi(channel.id, agent.id)
      onUpdated(data.channel)
    } finally {
      setSaving(false)
    }
  }

  const archive = async () => {
    setSaving(true)
    try {
      const data = await archiveChannelApi(channel.id)
      onUpdated(data.channel)
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="absolute right-4 top-14 z-40 w-[360px] rounded-md border border-ink-fade/40 bg-paper shadow-xl p-4 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-lg text-ink">{t('channels.settings')}</h2>
        <button type="button" onClick={onClose} className="p-1 rounded hover:bg-paper-2 text-ink-fade hover:text-ink">
          <X className="w-4 h-4" />
        </button>
      </div>
      <label className="flex flex-col gap-1.5">
        <span className="text-xs text-ink-fade">{t('channels.name')}</span>
        <input value={name} onChange={(e) => setName(e.target.value)} className="h-9 px-3 rounded-md border border-ink-fade/40 bg-paper text-sm outline-none focus:border-ember" />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-xs text-ink-fade">{t('channels.defaultAgent')}</span>
        <select value={defaultAgentId} onChange={(e) => setDefaultAgentId(e.target.value)} className="h-9 px-3 rounded-md border border-ink-fade/40 bg-paper text-sm">
          <option value="">{t('channels.noDefault')}</option>
          {channel.agents?.map((agent) => <option key={agent.id} value={agent.id}>{agentLabel(agent)}</option>)}
        </select>
      </label>
      <button type="button" disabled={saving} onClick={saveBasics} className="h-9 px-3 rounded-md bg-ink text-paper text-sm hover:bg-ink-soft disabled:opacity-50">
        {saving ? t('common.saving') : t('common.save')}
      </button>
      <div className="flex flex-col gap-2">
        <span className="text-xs text-ink-fade">{t('channels.members')}</span>
        <div className="flex flex-wrap gap-1.5">
          {channel.agents?.map((agent) => (
            <AgentChip key={agent.id} agent={agent} active={agent.id === channel.defaultAgentId} onRemove={channel.agents.length > 1 ? removeAgent : null} />
          ))}
        </div>
      </div>
      <div className="flex gap-2">
        <select value={addAgentId} onChange={(e) => setAddAgentId(e.target.value)} className="min-w-0 flex-1 h-9 px-2 rounded-md border border-ink-fade/40 bg-paper text-sm">
          <option value="">{t('channels.addAgent')}</option>
          {available.map((agent) => <option key={agent.id} value={agent.id}>{agentLabel(agent)}</option>)}
        </select>
        <button type="button" disabled={!addAgentId || saving} onClick={addAgent} className="h-9 px-3 rounded-md border border-ink-fade/40 text-sm hover:bg-paper-2 disabled:opacity-50">
          <Plus className="w-4 h-4" />
        </button>
      </div>
      {!channel.archivedAt ? (
        <button type="button" disabled={saving} onClick={archive} className="h-9 px-3 rounded-md border border-ink-fade/40 text-sm text-ink-soft hover:bg-paper-2 inline-flex items-center justify-center gap-2">
          <Archive className="w-4 h-4" />
          {t('channels.archive')}
        </button>
      ) : null}
    </div>
  )
}

function CreateChannelPanel({ agents, onClose, onCreated, t }) {
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
      const data = await createChannelApi({
        name,
        kind,
        agentIds,
        defaultAgentId: defaultAgentId || agentIds[0] || null,
      })
      onCreated(data.channel)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-ink/35 flex items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-md rounded-md border border-ink bg-paper shadow-xl p-5 flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-xl text-ink">{t('channels.newChannel')}</h2>
          <button type="button" onClick={onClose} className="p-1 rounded hover:bg-paper-2 text-ink-fade hover:text-ink">
            <X className="w-4 h-4" />
          </button>
        </div>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('channels.name')} className="h-10 px-3 rounded-md border border-ink-fade/40 bg-paper text-sm outline-none focus:border-ember" />
        <div className="grid grid-cols-2 gap-1 rounded-md border border-ink-fade/40 p-1">
          {['group', 'dm'].map((item) => (
            <button key={item} type="button" onClick={() => { setKind(item); setSelected([]); setDefaultAgentId('') }} className={`h-8 rounded text-sm ${kind === item ? 'bg-paper-2 text-ink' : 'text-ink-fade hover:bg-paper-2/60'}`}>
              {t(`channels.${item}`)}
            </button>
          ))}
        </div>
        <div className="max-h-56 overflow-y-auto flex flex-col gap-1">
          {agents.map((agent) => {
            const checked = selected.includes(agent.id)
            const disabled = kind === 'dm' && !checked && selected.length >= 1
            return (
              <label key={agent.id} className={`flex items-center gap-2 px-2 py-2 rounded-md ${disabled ? 'opacity-45' : 'hover:bg-paper-2'}`}>
                <input type="checkbox" disabled={disabled} checked={checked} onChange={() => toggle(agent.id)} />
                <span className="text-sm text-ink-soft">{agentLabel(agent)}</span>
              </label>
            )
          })}
        </div>
        <select value={defaultAgentId} onChange={(e) => setDefaultAgentId(e.target.value)} className="h-9 px-3 rounded-md border border-ink-fade/40 bg-paper text-sm">
          <option value="">{t('channels.defaultAgent')}</option>
          {selected.map((id) => {
            const agent = agents.find((item) => item.id === id)
            return <option key={id} value={id}>{agentLabel(agent)}</option>
          })}
        </select>
        <button disabled={saving || !name.trim() || selected.length === 0} className="h-10 rounded-md bg-ember text-paper text-sm hover:bg-ember/90 disabled:opacity-50">
          {saving ? t('common.saving') : t('channels.create')}
        </button>
      </form>
    </div>
  )
}

export default function ChannelsPage() {
  const { t } = useT()
  const [channels, setChannels] = useState([])
  const [agents, setAgents] = useState([])
  const [activeId, setActiveId] = useState('')
  const [messages, setMessages] = useState([])
  const [draft, setDraft] = useState('')
  const [cursor, setCursor] = useState(0)
  const [mentionIndex, setMentionIndex] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const inputRef = useRef(null)
  const bottomRef = useRef(null)

  const activeChannel = channels.find((channel) => channel.id === activeId) || null
  const grouped = useMemo(() => groupChannels(channels), [channels])
  const activeAgents = activeChannel?.agents || []

  const mentionState = getMentionQuery(draft, cursor)
  const mentionItems = mentionState
    ? activeAgents.filter((agent) => `${agent.name || ''} ${agent.id || ''}`.toLocaleLowerCase().includes(mentionState.query.toLocaleLowerCase())).slice(0, 8)
    : []

  const replaceChannel = (channel) => {
    setChannels((current) => current.map((item) => item.id === channel.id ? channel : item))
  }

  const reload = async () => {
    setError('')
    setLoading(true)
    try {
      const [channelData, agentData] = await Promise.all([
        listChannelsApi({ archived: 'all' }),
        listAgentsApi(),
      ])
      const nextChannels = channelData.channels || []
      setChannels(nextChannels)
      setAgents(agentData.agents || [])
      if (!activeId && nextChannels.length) setActiveId(nextChannels.find((channel) => !channel.archivedAt)?.id || nextChannels[0].id)
    } catch (err) {
      setError(err.message || t('errors.loadFailed'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => { reload() }, 0)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!activeId) return undefined
    let cancelled = false
    listChannelMessagesApi(activeId, { limit: 50 }).then((data) => {
      if (!cancelled) setMessages(data.messages || [])
    }).catch((err) => setError(err.message || t('errors.loadFailed')))
    return () => { cancelled = true }
  }, [activeId, t])

  useEffect(() => {
    if (!activeId) return undefined
    const token = getAuthToken()
    const url = token ? `${channelStreamUrl(activeId)}?token=${encodeURIComponent(token)}` : channelStreamUrl(activeId)
    const events = new EventSource(url)
    events.addEventListener('channel_message', (event) => {
      try {
        const message = JSON.parse(event.data)
        setMessages((current) => current.some((item) => item.id === message.id) ? current : [...current, message])
      } catch {
        // Ignore malformed SSE payloads.
      }
    })
    return () => events.close()
  }, [activeId])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [messages.length, activeId])

  const pickMention = (agent, state = mentionState) => {
    const next = applyMention(draft, state, agent)
    setDraft(next)
    setCursor(next.length)
    setMentionIndex(0)
    window.setTimeout(() => inputRef.current?.focus(), 0)
  }

  const send = async () => {
    const content = draft.trim()
    if (!content || !activeId) return
    setDraft('')
    setCursor(0)
    try {
      await sendChannelMessageApi(activeId, content)
    } catch (err) {
      setDraft(content)
      setError(err.message || t('toast.chatSendFailed'))
    }
  }

  const handleKeyDown = (event) => {
    if (mentionItems.length) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setMentionIndex((index) => Math.min(index + 1, mentionItems.length - 1))
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setMentionIndex((index) => Math.max(index - 1, 0))
        return
      }
      if (event.key === 'Tab') {
        event.preventDefault()
        pickMention(mentionItems[mentionIndex])
        return
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      send()
    }
  }

  const senderAgent = (message) => activeAgents.find((agent) => agent.id === message.senderId) || message.sender

  return (
    <div className="h-screen flex bg-paper text-ink overflow-hidden">
      <LeftRail />
      <aside className="w-[300px] border-r border-dashed border-ink-fade/50 bg-paper p-4 flex flex-col gap-4 overflow-y-auto">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h1 className="font-display text-2xl text-ink">{t('channels.title')}</h1>
            <p className="text-xs text-ink-fade mt-0.5">{t('channels.subtitle')}</p>
          </div>
          <button type="button" onClick={() => setShowCreate(true)} title={t('channels.newChannel')} className="w-9 h-9 rounded-md border border-ink-fade/40 hover:bg-paper-2 flex items-center justify-center">
            <Plus className="w-4 h-4" />
          </button>
        </div>
        {error ? <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div> : null}
        <div className="flex flex-col gap-4">
          <ChannelListGroup title={t('channels.group')} channels={grouped.group} activeId={activeId} onSelect={(id) => { setShowSettings(false); setActiveId(id) }} />
          <ChannelListGroup title={t('channels.dm')} channels={grouped.dm} activeId={activeId} onSelect={(id) => { setShowSettings(false); setActiveId(id) }} />
          <button type="button" onClick={() => setShowArchived((open) => !open)} className="flex items-center justify-between px-2 py-1 text-xs text-ink-fade hover:text-ink-soft">
            {t('channels.archived')}
            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showArchived ? 'rotate-180' : ''}`} />
          </button>
          {showArchived ? <ChannelListGroup title="" channels={grouped.archived} activeId={activeId} onSelect={(id) => { setShowSettings(false); setActiveId(id) }} /> : null}
        </div>
      </aside>

      <main className="flex-1 min-w-0 flex flex-col overflow-hidden">
        {activeChannel ? (
          <>
            <header className="relative h-16 border-b border-ink-fade/30 px-5 flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h2 className="font-display text-xl text-ink truncate">{activeChannel.name}</h2>
                  <span className="h-5 px-1.5 rounded border border-ink-fade/40 bg-paper-2 text-[10px] font-mono uppercase text-ink-fade">{activeChannel.kind}</span>
                </div>
                <div className="mt-1 flex items-center gap-1.5 overflow-hidden">
                  {activeAgents.map((agent) => <AgentChip key={agent.id} agent={agent} active={agent.id === activeChannel.defaultAgentId} />)}
                </div>
              </div>
              <button type="button" onClick={() => setShowSettings((open) => !open)} className="w-9 h-9 rounded-md border border-ink-fade/40 hover:bg-paper-2 flex items-center justify-center shrink-0" title={t('channels.settings')}>
                <Settings className="w-4 h-4" />
              </button>
              {showSettings ? (
                <SettingsPanel channel={activeChannel} agents={agents} onClose={() => setShowSettings(false)} onUpdated={replaceChannel} t={t} />
              ) : null}
            </header>

            <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
              {loading ? <div className="text-sm text-ink-fade">{t('common.loading')}</div> : null}
              <div className="max-w-4xl mx-auto flex flex-col gap-3">
                {messages.map((message) => {
                  const isUser = message.senderKind === 'user'
                  const agent = senderAgent(message)
                  return (
                    <article key={message.id} className={`flex gap-3 ${isUser ? 'justify-end' : 'justify-start'}`}>
                      {!isUser ? (
                        <div className="w-9 h-9 rounded-md border border-ink-fade/40 bg-paper-2 flex items-center justify-center shrink-0 overflow-hidden">
                          {agent?.avatarUrl ? <img src={agent.avatarUrl} alt="" className="w-full h-full object-cover" /> : <Bot className="w-4 h-4 text-ink-fade" />}
                        </div>
                      ) : null}
                      <div className={`max-w-[76%] rounded-md border px-3 py-2 ${
                        isUser ? 'bg-ink text-paper border-ink' : 'bg-paper-2 border-ink-fade/30 text-ink'
                      }`}>
                        <div className={`flex items-center gap-2 text-[11px] mb-1 ${isUser ? 'text-paper/70' : 'text-ink-fade'}`}>
                          {isUser ? <User className="w-3 h-3" /> : <Bot className="w-3 h-3" />}
                          <span>{isUser ? t('channels.you') : agentLabel(agent)}</span>
                          {!isUser ? <span className="rounded border border-ink-fade/30 px-1 font-mono uppercase">agent</span> : null}
                          <span>{formatTime(message.createdAt)}</span>
                        </div>
                        <div className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                          <MentionedText text={message.content} agents={activeAgents} />
                        </div>
                      </div>
                    </article>
                  )
                })}
                <div ref={bottomRef} />
              </div>
            </div>

            <footer className="border-t border-ink-fade/30 px-5 py-4">
              <div className="max-w-4xl mx-auto relative">
                <MentionsAutocomplete
                  value={draft}
                  cursor={cursor}
                  agents={activeAgents}
                  selectedIndex={mentionIndex}
                  setSelectedIndex={setMentionIndex}
                  onPick={pickMention}
                />
                <div className="flex items-end gap-2">
                  <textarea
                    ref={inputRef}
                    value={draft}
                    onChange={(event) => { setDraft(event.target.value); setCursor(event.target.selectionStart) }}
                    onClick={(event) => setCursor(event.currentTarget.selectionStart)}
                    onKeyUp={(event) => setCursor(event.currentTarget.selectionStart)}
                    onKeyDown={handleKeyDown}
                    placeholder={t('channels.inputPlaceholder')}
                    className="min-h-12 max-h-36 flex-1 resize-none rounded-md border border-ink-fade/40 bg-paper px-3 py-3 text-sm outline-none focus:border-ember"
                  />
                  <button type="button" onClick={send} disabled={!draft.trim()} className="w-12 h-12 rounded-md bg-ember text-paper hover:bg-ember/90 disabled:opacity-50 flex items-center justify-center" title={t('channels.send')}>
                    <Send className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </footer>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-sm text-ink-fade">{t('channels.empty')}</div>
        )}
      </main>

      {showCreate ? (
        <CreateChannelPanel
          agents={agents}
          t={t}
          onClose={() => setShowCreate(false)}
          onCreated={(channel) => {
            setChannels((current) => [channel, ...current])
            setActiveId(channel.id)
            setShowCreate(false)
          }}
        />
      ) : null}
    </div>
  )
}
