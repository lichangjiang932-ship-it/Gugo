import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from '../lib/router.jsx'
import { ChevronDown, MessageSquarePlus, Plus, Send, Settings } from 'lucide-react'
import LeftRail from '../components/LeftRail'
import MentionsAutocomplete from '../components/MentionsAutocomplete.jsx'
import { applyMention, getMentionQuery } from '../components/mentionsAutocompleteLogic.js'
import { useT } from '../i18n/I18nProvider.jsx'
import { listAgentsApi } from '../lib/agentClient.js'
import {
  listChannelsApi,
  mergeChannelMessages,
  sendChannelMessageApi,
  startChannelMessageSync,
} from '../lib/channelClient.js'
import {
  AgentChip,
  ChannelListGroup,
  CreateChannelPanel,
  MessageBubble,
  SettingsPanel,
} from './channels/ChannelPanels.jsx'
import { groupChannels } from './channels/channelViewUtils.js'

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

  useEffect(() => {
    let cancelled = false
    async function reload() {
      setError('')
      setLoading(true)
      try {
        const [channelData, agentData] = await Promise.all([listChannelsApi({ archived: 'all' }), listAgentsApi()])
        if (cancelled) return
        const nextChannels = channelData.channels || []
        setChannels(nextChannels)
        setAgents(agentData.agents || [])
        setActiveId((current) => current || nextChannels.find((channel) => !channel.archivedAt)?.id || nextChannels[0]?.id || '')
      } catch (requestError) {
        if (!cancelled) setError(requestError.message || t('errors.loadFailed'))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    const timer = window.setTimeout(reload, 0)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [t])

  useEffect(() => {
    if (!activeId) return undefined
    return startChannelMessageSync({
      channelId: activeId,
      applyMessages: (incoming) => setMessages((current) => mergeChannelMessages(current, incoming)),
      reportError: (requestError) => setError(requestError.message || t('errors.loadFailed')),
    })
  }, [activeId, t])

  useEffect(() => { bottomRef.current?.scrollIntoView({ block: 'end' }) }, [messages.length, activeId])

  const selectChannel = (id) => { setShowSettings(false); setMessages([]); setActiveId(id) }
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
    try { await sendChannelMessageApi(activeId, content) }
    catch (requestError) { setDraft(content); setError(requestError.message || t('toast.chatSendFailed')) }
  }
  const handleKeyDown = (event) => {
    if (mentionItems.length && ['ArrowDown', 'ArrowUp', 'Tab'].includes(event.key)) {
      event.preventDefault()
      if (event.key === 'ArrowDown') setMentionIndex((index) => Math.min(index + 1, mentionItems.length - 1))
      if (event.key === 'ArrowUp') setMentionIndex((index) => Math.max(index - 1, 0))
      if (event.key === 'Tab') pickMention(mentionItems[mentionIndex])
      return
    }
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send() }
  }

  return (
    <div className="flex h-screen overflow-hidden bg-paper text-ink">
      <LeftRail />
      <aside className="flex w-[300px] flex-col gap-4 overflow-y-auto border-r border-dashed border-ink-fade/50 bg-paper p-4">
        <div className="flex items-center justify-between gap-2">
          <div><h1 className="font-display text-2xl text-ink">{t('channels.title')}</h1><p className="mt-0.5 text-xs text-ink-fade">{t('channels.subtitle')}</p></div>
          <button type="button" onClick={() => setShowCreate(true)} title={t('channels.newChannel')} className="flex h-9 w-9 items-center justify-center rounded-md border border-ink-fade/40 hover:bg-paper-2"><Plus className="h-4 w-4" /></button>
        </div>
        {error && <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
        <div className="flex flex-col gap-4">
          <ChannelListGroup title={t('channels.group')} channels={grouped.group} activeId={activeId} onSelect={selectChannel} />
          <ChannelListGroup title={t('channels.dm')} channels={grouped.dm} activeId={activeId} onSelect={selectChannel} />
          {!loading && grouped.group.length === 0 && grouped.dm.length === 0 && <div className="rounded-md border border-dashed border-ink-fade/40 bg-paper-2/60 px-3 py-3 text-xs leading-relaxed text-ink-fade">{t('channels.emptyHint')}</div>}
          <button type="button" onClick={() => setShowArchived((open) => !open)} className="flex items-center justify-between px-2 py-1 text-xs text-ink-fade hover:text-ink-soft">{t('channels.archived')}<ChevronDown className={`h-3.5 w-3.5 transition-transform ${showArchived ? 'rotate-180' : ''}`} /></button>
          {showArchived && <ChannelListGroup title="" channels={grouped.archived} activeId={activeId} onSelect={selectChannel} />}
        </div>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {activeChannel ? (
          <>
            <header className="relative flex h-16 items-center justify-between gap-4 border-b border-ink-fade/30 px-5">
              <div className="min-w-0"><div className="flex items-center gap-2"><h2 className="truncate font-display text-xl text-ink">{activeChannel.name}</h2><span className="h-5 rounded border border-ink-fade/40 bg-paper-2 px-1.5 font-mono text-[10px] uppercase text-ink-fade">{activeChannel.kind}</span></div><div className="mt-1 flex items-center gap-1.5 overflow-hidden">{activeAgents.map((agent) => <AgentChip key={agent.id} agent={agent} active={agent.id === activeChannel.defaultAgentId} />)}</div></div>
              <button type="button" onClick={() => setShowSettings((open) => !open)} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-ink-fade/40 hover:bg-paper-2" title={t('channels.settings')}><Settings className="h-4 w-4" /></button>
              {showSettings && <SettingsPanel channel={activeChannel} agents={agents} onClose={() => setShowSettings(false)} onUpdated={(channel) => setChannels((current) => current.map((item) => item.id === channel.id ? channel : item))} t={t} />}
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4"><div className="mx-auto flex max-w-4xl flex-col gap-3">{loading && <div className="text-sm text-ink-fade">{t('common.loading')}</div>}{messages.map((message) => <MessageBubble key={message.id} activeAgents={activeAgents} message={message} t={t} />)}<div ref={bottomRef} /></div></div>
            <footer className="border-t border-ink-fade/30 px-5 py-4"><div className="relative mx-auto max-w-4xl"><MentionsAutocomplete value={draft} cursor={cursor} agents={activeAgents} selectedIndex={mentionIndex} setSelectedIndex={setMentionIndex} onPick={pickMention} /><div className="flex items-end gap-2"><textarea ref={inputRef} value={draft} onChange={(event) => { setDraft(event.target.value); setCursor(event.target.selectionStart) }} onClick={(event) => setCursor(event.currentTarget.selectionStart)} onKeyUp={(event) => setCursor(event.currentTarget.selectionStart)} onKeyDown={handleKeyDown} placeholder={t('channels.inputPlaceholder')} className="min-h-12 max-h-36 flex-1 resize-none rounded-md border border-ink-fade/40 bg-paper px-3 py-3 text-sm outline-none focus:border-focus" /><button type="button" onClick={send} disabled={!draft.trim()} className="flex h-12 w-12 items-center justify-center rounded-md bg-accent text-accent-contrast hover:bg-accent/90 disabled:opacity-50" title={t('channels.send')}><Send className="h-4 w-4" /></button></div></div></footer>
          </>
        ) : <EmptyChannel onCreate={() => setShowCreate(true)} t={t} />}
      </main>
      {showCreate && <CreateChannelPanel agents={agents} t={t} onClose={() => setShowCreate(false)} onCreated={(channel) => { setChannels((current) => [channel, ...current]); setMessages([]); setActiveId(channel.id); setShowCreate(false) }} />}
    </div>
  )
}

function EmptyChannel({ onCreate, t }) {
  return (
    <div className="flex flex-1 items-center justify-center p-6"><div className="flex w-full max-w-md flex-col items-center gap-4 rounded-md border border-ink-fade/40 bg-paper p-6 text-center"><div className="flex h-14 w-14 items-center justify-center rounded-md border border-ink-fade/40 bg-paper-2"><MessageSquarePlus className="h-7 w-7 text-ink-soft" /></div><div><h2 className="font-semibold text-2xl text-ink">{t('channels.emptyTitle')}</h2><p className="mt-2 text-sm leading-relaxed text-ink-soft">{t('channels.emptyHint')}</p></div><div className="flex flex-col items-center gap-2"><button type="button" onClick={onCreate} className="h-10 rounded-md bg-accent px-4 text-sm text-accent-contrast hover:bg-accent/90">{t('channels.emptyCta')}</button><Link to="/settings" className="text-xs text-ink-fade hover:text-ink-soft">{t('channels.emptyBindIm')}</Link></div></div></div>
  )
}
