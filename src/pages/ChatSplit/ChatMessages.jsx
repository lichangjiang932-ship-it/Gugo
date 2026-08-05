import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, FileText, BarChart3, LayoutList, ExternalLink, ChevronDown, Copy, Code2, Quote, Download, Presentation, Sheet, ListChecks } from 'lucide-react'
import MarkdownRenderer from '../../components/MarkdownRenderer.jsx'
import ToolCallCard from '../../components/ToolCallCard.jsx'
import SubagentCard from '../../components/SubagentCard.jsx'
import CompactionPill from '../../components/CompactionPill.jsx'
import ChoicePicker from '../../components/ChoicePicker.jsx'
import { hasChoices, stripChoices } from '../../lib/choices.js'
import { buildMessageTimeline } from '../../lib/messageTimeline.js'
import { buildArtifactPreview, shouldCollapseArtifactPreview } from '../../lib/artifactPreview.js'
import { estimateClientContextUsage } from '../../lib/contextUsage.js'
import { formatMessageDateTime, formatMessageTime } from '../../lib/messageTime.js'
import { DEFAULT_MESSAGE_WINDOW_SIZE, getExpandedWindowCount, getMessageWindow } from '../../lib/messageWindow.js'
import { useT } from '../../i18n/I18nProvider.jsx'
import { withDownloadToken } from '../../lib/jobClient.js'

function ServerArtifactCards({ artifacts = [] }) {
  if (!Array.isArray(artifacts) || artifacts.length === 0) return null
  return <div className="mt-3 space-y-2" data-testid="server-turn-artifacts">{artifacts.map((artifact) => (
    <a
      key={artifact.id || artifact.url}
      href={withDownloadToken(artifact.url)}
      download={artifact.filename || ''}
      className="flex items-center gap-3 rounded-md border border-ink-fade/30 bg-paper p-3 transition-colors hover:border-ember/60"
    >
      <span className="flex h-9 w-9 items-center justify-center rounded-md bg-ember-soft text-ember"><FileText className="h-4 w-4" /></span>
      <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-ink">{artifact.filename || artifact.title || 'artifact'}</span><span className="block text-xs text-ink-fade">{artifact.type || 'file'}</span></span>
      <Download className="h-4 w-4 text-ink-fade" />
    </a>
  ))}</div>
}

function ArtifactOpenCard({ preview, onOpen, className = '' }) {
  const { t } = useT()
  if (!preview) return null
  return (
    <button
      type="button"
      data-testid="artifact-open-card"
      onClick={onOpen}
      className={`group w-full text-left rounded-md border border-ink-fade/30 bg-paper hover:border-ember/60 hover:shadow-sm transition-all p-3 flex items-center gap-3 ${className}`}
      title={`${preview.label} · ${t('chatPreview.preview')}`}
    >
      <div className="w-10 h-10 rounded-md bg-ember-soft border border-ember/30 flex items-center justify-center text-ember shrink-0">
        {preview.type === 'pptx' && <BarChart3 className="w-5 h-5" />}
        {preview.type === 'docx' && <FileText className="w-5 h-5" />}
        {preview.type === 'xlsx' && <LayoutList className="w-5 h-5" />}
        {(preview.type === 'html' || preview.type === 'html_multi') && <ExternalLink className="w-5 h-5" />}
        {(preview.type === 'mermaid' || preview.type === 'chart') && <BarChart3 className="w-5 h-5" />}
        {(preview.type === 'svg' || preview.type === 'react') && <Code2 className="w-5 h-5" />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ember">{preview.label}</div>
        <div className="font-semibold text-ink text-sm truncate" title={preview.filename}>{preview.filename}</div>
        <div className="text-xs text-ink-fade truncate">{preview.summary}</div>
      </div>
      <div className="shrink-0 inline-flex items-center gap-1.5">
        <span className="text-[11px] text-ink-fade group-hover:text-ember transition-colors hidden sm:inline">{t('chatPreview.preview')}</span>
        <ExternalLink className="w-4 h-4 text-ink-fade group-hover:text-ember transition-colors" />
      </div>
    </button>
  )
}

const STARTER_PROMPTS = [
  { key: 'weeklyReport', icon: FileText },
  { key: 'salesExcel', icon: Sheet },
  { key: 'productPpt', icon: Presentation },
  { key: 'workPlan', icon: ListChecks },
]

function AtelierMark() {
  return (
    <div
      data-testid="atelier-mark"
      className="mb-6 flex h-16 w-16 items-center justify-center rounded-[22px] bg-ink text-paper shadow-[0_16px_40px_rgb(var(--color-ink-rgb)/0.18)] ring-1 ring-paper/20"
      aria-hidden="true"
    >
      <svg viewBox="0 0 56 56" className="h-10 w-10" fill="none">
        <path d="M38.5 17.5A15 15 0 1 0 41 31H29" stroke="currentColor" strokeWidth="4.5" strokeLinecap="round" />
        <path d="M41 31v9" stroke="currentColor" strokeWidth="4.5" strokeLinecap="round" />
        <circle cx="42.5" cy="13.5" r="3.5" className="fill-ember" />
      </svg>
    </div>
  )
}

function splitUserSkillCommand(content = '') {
  const raw = String(content || '')
  const match = raw.match(/^\/([a-z0-9_-]+)(?:\s+([\s\S]*))?$/i)
  if (!match) return { command: '', body: raw }
  return { command: `/${match[1]}`, body: match[2] || '' }
}

function NewConversationWelcome({ onPromptSelect }) {
  const { t } = useT()
  return (
    <section
      className="flex min-h-[420px] flex-1 flex-col items-center justify-center py-10"
      aria-labelledby="new-conversation-title"
      data-testid="new-conversation-welcome"
    >
      <AtelierMark />
      <h1 id="new-conversation-title" className="font-hand text-2xl text-ink sm:text-3xl">
        {t('chatMessages.emptyTitle')}
      </h1>
      <p className="mt-2 max-w-md text-center text-sm leading-6 text-ink-soft">
        {t('chatMessages.emptyHint')}
      </p>
      <div className="mt-7 grid w-full max-w-[680px] gap-2.5 sm:grid-cols-2">
        {STARTER_PROMPTS.map(({ key, icon: Icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => onPromptSelect?.(t(`chatMessages.${key}`))}
            className="group flex min-h-16 items-center gap-3 rounded-xl border border-ink/10 bg-paper-2/50 px-4 py-3 text-left text-sm leading-5 text-ink-soft transition-all hover:-translate-y-0.5 hover:border-ember/45 hover:bg-paper hover:text-ink hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember/50"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-paper text-ember ring-1 ring-ink/10 transition-colors group-hover:bg-ember-soft">
              <Icon className="h-4 w-4" aria-hidden="true" />
            </span>
            <span>{t(`chatMessages.${key}`)}</span>
          </button>
        ))}
      </div>
    </section>
  )
}

/**
 * 工具调用轨迹。
 *
 * ★ 以前这些卡片直接堆在回复正文上面,一大坨没有任何说明 —— 用户会以为
 * 「回复在上、操作在下」,把执行顺序读反。实际上工具是先跑的,模型看到结果
 * 才写的回复,所以位置没错,错的是没标出来。
 * 现在加一条明确的「执行过程」标头,默认折叠成一行,展开才看细节;
 * 下面紧跟着就是基于这些结果写出的答复。
 */
/**
 * 推理模型的思考过程。
 *
 * ★ qwen3.5 / DeepSeek-R1 这类模型回答前会先想很久 —— 实测本地
 * qwen3.5-9b 的 reasoning_content 339ms 就开始流,而正文要等到 11.6 秒。
 * 不显示的话这十几秒屏幕上什么都没有,用户以为卡死了。
 * 思考中默认展开(让用户看到它在动),出正文后自动收起(别淹没答案)。
 */
function ReasoningTrace({ text = '', streaming = false }) {
  const { t } = useT()
  const [manual, setManual] = useState(null)
  const panelId = useId()
  if (!text) return null
  // manual 为 null 时跟随默认:思考中展开,出了正文就收起
  const expanded = manual === true

  return (
    <div className="chat-activity-panel mb-2 overflow-hidden">
      <button
        type="button"
        onClick={() => setManual(!expanded)}
        aria-expanded={expanded}
        aria-controls={panelId}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-paper-2/55"
      >
        <ChevronDown className={`w-3 h-3 text-cyan transition-transform ${expanded ? '' : '-rotate-90'}`} />
        <span className="font-mono text-[10px] tracking-wider uppercase text-ink-fade">{t('chatMessages.reasoning')}</span>
        <span className="text-xs text-ink-soft">
          {streaming ? t('chatMessages.reasoningActive') : t('chatMessages.characters', { count: text.length })}
        </span>
        {streaming && (
          <span className="inline-flex items-center gap-1" role="status" aria-live="polite">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-cyan animate-pulse" aria-hidden="true" />
            <span className="sr-only">{t('chatMessages.reasoningActive')}</span>
          </span>
        )}
      </button>
      {expanded && (
        <div id={panelId} className="border-t border-ink/10 px-3 py-2">
          <pre className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words font-sans text-xs leading-5 text-ink-soft">
            {text}
          </pre>
        </div>
      )}
    </div>
  )
}

function ToolCallTrace({ calls = [] }) {
  const { t } = useT()
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const failed = calls.filter((c) => c.status === 'error').length
  const running = calls.filter((c) => c.status === 'running').length
  // 还在跑的时候自动展开,让用户看到进度;跑完了收起来,别淹没正文
  const expanded = open

  return (
    <div className="chat-activity-panel mb-2 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={expanded}
        aria-controls={panelId}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-paper-2/55"
      >
        <ChevronDown className={`w-3 h-3 text-ink-fade transition-transform ${expanded ? '' : '-rotate-90'}`} />
        <span className="font-mono text-[10px] tracking-wider uppercase text-ink-fade">{t('chatMessages.execution')}</span>
        <span className="text-xs text-ink-soft">
          {running > 0 ? t('chatMessages.runningSteps', { count: calls.length }) : t('chatMessages.steps', { count: calls.length })}
          {failed > 0 && <span className="text-red-600 ml-1.5">{t('chatMessages.failedSteps', { count: failed })}</span>}
        </span>
      </button>
      {expanded && (
        <div id={panelId} className="border-t border-ink/10 px-2 py-1.5">
          {calls.map((tc) =>
            tc.name === 'Agent'
              ? <SubagentCard key={tc.id} call={tc} />
              : <ToolCallCard key={tc.id} call={tc} />
          )}
          <div className="mt-1 border-t border-dashed border-ink-fade/25 px-1 pt-1 font-mono text-[9px] text-ink-fade">
            {t('chatMessages.answerFollows')}
          </div>
        </div>
      )}
    </div>
  )
}

export default function ChatMessages({
  messages,
  state,
  workbenchMessage,
  showContextUsage = true,
  showContextPanel,
  setShowContextPanel,
  selectedModel,
  isGenerating = false,
  contextWindow = 1_000_000,
  toolSpecs = [],
  systemPrompt = '',
  onPermAllow,
  onPermDeny,
  onNavigatePermissions,
  onOpenInPreview,
  onExpandCompaction,
  onQuoteSelection,
  onPromptSelect,
}) {
  const { t, lang } = useT()
  const hasMessages = messages.length > 0
  const [visibleCount, setVisibleCount] = useState(DEFAULT_MESSAGE_WINDOW_SIZE)
  const { hiddenCount, visibleMessages } = getMessageWindow(messages, visibleCount)
  const generatingMessageId = isGenerating
    ? [...messages].reverse().find((message) => message?.role === 'assistant')?.id
    : null
  const contextUsage = estimateClientContextUsage({
    messages,
    tools: toolSpecs,
    systemPrompt,
    contextWindow,
  })
  const estimatedContextTokens = contextUsage.estimatedTokens
  const contextPercent = contextUsage.percent
  // ★ PR3: 选中文本浮动「引用」气泡 — 仅在 assistant 消息内选词时显示
  const [quoteBubble, setQuoteBubble] = useState(null) // { top, left, text } | null
  const containerRef = useRef(null)

  // ★ #19: 移除 handleDownloadPptx/Office 双路径 — artifact 卡片走 RightPreviewPane.handleDownload,
  // 普通 markdown 不再嗅探导出 (避免 shouldOfferOfficeExport vs detectArtifactType 两套规则不一致)

  // #11 自动滚到底 + 浮动「回到底部」按钮
  // 规则:用户已贴底 → 新消息自动滚;用户上滑离开底部 → 不打扰,显示按钮让其手动回
  const scrollRef = useRef(null)
  const [atBottom, setAtBottom] = useState(true)
  const lastCountRef = useRef(messages.length)
  const pendingScrollRestoreRef = useRef(null)

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el || (typeof window !== 'undefined' && window.location.hash.startsWith('#message-'))) return
    el.scrollTop = el.scrollHeight
  }, [])

  useLayoutEffect(() => {
    const pending = pendingScrollRestoreRef.current
    const el = scrollRef.current
    if (!pending || !el) return
    el.scrollTop = pending.top + (el.scrollHeight - pending.height)
    pendingScrollRestoreRef.current = null
  }, [visibleCount])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight
      setAtBottom(distance < 80) // 80px 容差,刚好够看到下一条进入
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  // 新消息或流式追加时,如果用户在底部就跟着滚
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const grew = messages.length > lastCountRef.current
    const lastMsg = messages[messages.length - 1]
    // 流式中:最后一条 assistant 还在更新 content,也算"内容增长"
    const streaming = lastMsg?.role === 'assistant' && lastMsg?.meta?.streaming
    if ((grew || streaming) && atBottom) {
      el.scrollTop = el.scrollHeight
    }
    lastCountRef.current = messages.length
  }, [messages, atBottom])

  useEffect(() => {
    if (typeof window === 'undefined' || !window.location.hash.startsWith('#message-')) return
    const targetId = decodeURIComponent(window.location.hash.slice(1))
    const messageId = targetId.slice('message-'.length)
    const targetIndex = messages.findIndex((message) => String(message?.id) === messageId)
    if (targetIndex >= 0 && targetIndex < hiddenCount) {
      const expandTimer = window.setTimeout(() => {
        setVisibleCount(getExpandedWindowCount(messages.length, targetIndex))
      }, 0)
      return () => window.clearTimeout(expandTimer)
    }
    const timer = window.setTimeout(() => {
      const target = document.getElementById(targetId)
      target?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }, 80)
    return () => window.clearTimeout(timer)
  }, [messages, hiddenCount])

  const loadEarlierMessages = () => {
    const el = scrollRef.current
    if (el) pendingScrollRestoreRef.current = { height: el.scrollHeight, top: el.scrollTop }
    setVisibleCount((count) => Math.min(messages.length, count + DEFAULT_MESSAGE_WINDOW_SIZE))
  }

  const scrollToBottom = () => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }

  // ★ PR3: 选中文本气泡 — 监听 mouseup/keyup,只有选中范围落在 [data-quotable] 元素内才弹
  useEffect(() => {
    const handleSelectionChange = () => {
      const sel = typeof window !== 'undefined' ? window.getSelection() : null
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        setQuoteBubble(null)
        return
      }
      const text = sel.toString().trim()
      if (!text) {
        setQuoteBubble(null)
        return
      }
      const range = sel.getRangeAt(0)
      // 必须完全落在某个 [data-quotable] 内
      const anchorNode = range.startContainer
      const focusNode = range.endContainer
      const startEl = anchorNode.nodeType === 1 ? anchorNode : anchorNode.parentElement
      const endEl = focusNode.nodeType === 1 ? focusNode : focusNode.parentElement
      const startBlock = startEl?.closest?.('[data-quotable="true"]')
      const endBlock = endEl?.closest?.('[data-quotable="true"]')
      if (!startBlock || startBlock !== endBlock) {
        setQuoteBubble(null)
        return
      }
      const container = containerRef.current
      if (!container) return
      const rect = range.getBoundingClientRect()
      const containerRect = container.getBoundingClientRect()
      // 气泡定位:落在选区上方 8px,水平居中,限制在容器内
      const top = rect.top - containerRect.top + container.scrollTop - 36
      const left = Math.max(8, rect.left - containerRect.left + rect.width / 2)
      setQuoteBubble({ top, left, text })
    }
    document.addEventListener('mouseup', handleSelectionChange)
    document.addEventListener('keyup', handleSelectionChange)
    return () => {
      document.removeEventListener('mouseup', handleSelectionChange)
      document.removeEventListener('keyup', handleSelectionChange)
    }
  }, [])

  const handleQuoteClick = () => {
    if (!quoteBubble?.text) return
    onQuoteSelection?.(quoteBubble.text)
    setQuoteBubble(null)
    if (typeof window !== 'undefined') window.getSelection()?.removeAllRanges()
  }

  return (
    <div ref={(el) => { scrollRef.current = el; containerRef.current = el }} className="chat-scroll-region relative flex-1 overflow-y-auto px-4 py-4 sm:px-7">
      <div className="chat-conversation-column mx-auto flex w-full max-w-[840px] flex-col gap-5">
        {workbenchMessage && (
          <div className="rounded-lg border border-ink/10 bg-paper-2/55 px-3 py-2 text-xs text-ink-soft">
            {workbenchMessage}
          </div>
        )}
        {showContextUsage && (
        <button
          type="button"
          onClick={() => setShowContextPanel((visible) => !visible)}
          aria-expanded={showContextPanel}
          className="chat-context-bar ml-auto w-full max-w-[360px] self-end rounded-lg border border-ink/10 bg-paper-2/45 px-2.5 py-1.5 text-left transition-colors hover:border-ember/45 hover:bg-paper-2/75"
          title={t('chat.contextUsage.openDetails')}
        >
          <div className="flex items-center gap-2.5 text-[10px]">
            <span className="shrink-0 font-mono uppercase tracking-[0.14em] text-ink-fade">
              {t('chat.contextUsage.compactLabel')}
            </span>
            <div className="h-1 min-w-14 flex-1 overflow-hidden rounded-full bg-ink-ghost/70">
              <div
                className={`h-full rounded-full ${contextPercent >= 80 ? 'bg-red-500' : contextPercent >= 60 ? 'bg-amber-500' : 'bg-ember'}`}
                style={{ width: `${contextPercent}%` }}
              />
            </div>
            <span className="shrink-0 font-mono text-ink-soft">
              ~{estimatedContextTokens.toLocaleString()} / {contextUsage.contextWindow.toLocaleString()} · {contextPercent}%
            </span>
          </div>
        </button>
        )}
        {showContextUsage && showContextPanel && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="ml-auto w-full max-w-[430px] rounded-lg border border-ink/10 bg-paper-2/65 p-3 text-xs text-ink-soft"
          >
            <div className="flex items-center justify-between mb-2">
              <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-ember">
                {t('chatMessages.contextTitle')}
              </span>
              <button
                type="button"
                onClick={() => setShowContextPanel(false)}
                className="text-ink-fade hover:text-ink"
                title={t('chat.contextUsage.closeDetails')}
                aria-label={t('chat.contextUsage.closeDetails')}
              >
                <X className="w-3 h-3" />
              </button>
            </div>
            <div className="grid grid-cols-3 gap-2 text-[11px]">
              <div>
                <span className="text-ink-fade">{t('chat.contextUsage.messages')}</span>
                <div className="font-hand text-base text-ink">{messages.length}</div>
              </div>
              <div>
                <span className="text-ink-fade">{t('chat.contextUsage.visibleCharacters')}</span>
                <div className="font-hand text-base text-ink">{contextUsage.visibleCharacters.toLocaleString()}</div>
              </div>
              <div>
                <span className="text-ink-fade">{t('chat.contextUsage.model')}</span>
                <div className="font-hand text-base text-ink">{selectedModel || t('chat.contextUsage.backendDefault')}</div>
              </div>
            </div>
            <div className="mt-2 pt-2 border-t border-dashed border-ember/30 text-[11px]">
              <div className="mb-2">
                <div className="flex items-center justify-between text-ink-fade">
                  <span>{t('chat.contextUsage.estimatedUsage')}</span>
                  <span>{estimatedContextTokens.toLocaleString()} / {Number(contextWindow).toLocaleString()} tokens · {contextPercent}%</span>
                </div>
                <div className="mt-1 h-1.5 rounded-full bg-ink-ghost overflow-hidden">
                  <div className="h-full rounded-full bg-ember" style={{ width: `${contextPercent}%` }} />
                </div>
              </div>
              <div className="mb-2 grid grid-cols-2 gap-x-4 gap-y-1 text-ink-fade sm:grid-cols-4">
                <span>{t('chat.contextUsage.messagePayload')} ~{contextUsage.messageTokens.toLocaleString()}</span>
                <span>{t('chat.contextUsage.toolCalls')} ~{contextUsage.toolCallTokens.toLocaleString()}</span>
                <span>{t('chat.contextUsage.attachments')} ~{contextUsage.attachmentTokens.toLocaleString()}</span>
                <span>{t('chat.contextUsage.toolDefinitions')} ~{contextUsage.toolSpecTokens.toLocaleString()}</span>
              </div>
              <div className="mb-2 text-ink-fade">{t('chat.contextUsage.estimateNotice')}</div>
              <span className="text-ink-fade">{t('chatMessages.provider')}</span>
              <span className="text-ink">{t('chatMessages.backendConfigured')}</span>
              <span className="ml-3 text-ink-fade">{t('chatMessages.keyServerOnly')}</span>
            </div>
          </motion.div>
        )}

        {hasMessages ? (
          <>
            {hiddenCount > 0 && (
              <div className="flex flex-col items-center gap-1 py-1 text-[11px] text-ink-fade">
                <button
                  type="button"
                  onClick={loadEarlierMessages}
                  className="rounded-full border border-ink-fade/40 bg-paper px-3 py-1.5 text-ink-soft transition-colors hover:border-ember/50 hover:text-ink"
                >
                  {t('chatWindow.loadEarlier')}
                </button>
                <span>{t('chatWindow.olderHidden', { count: hiddenCount })}</span>
              </div>
            )}
            {visibleMessages.map((msg, i) => {
              const artifactPreview = msg.role === 'assistant' && (msg.meta?.artifactSource || msg.content)
                // G1: 优先用工具产出的 artifactSource(模型显式给的 markdown)
                //     而不是 msg.content(对话回复正文,可能只是个 ack).
                ? buildArtifactPreview({
                    content: msg.meta?.artifactSource || msg.content,
                    meta: msg.meta || {},
                  })
                : null
              const isMessageComplete = !isGenerating && !msg.meta?.streaming
              const isCurrentStreamingMessage = msg.id === generatingMessageId || !!msg.meta?.streaming
              const showArtifactPreview = !!artifactPreview && isMessageComplete
              const collapseArtifact = showArtifactPreview && shouldCollapseArtifactPreview(artifactPreview, {
                content: msg.content,
                artifactSource: msg.meta?.artifactSource,
              })
              const userSkillCommand = msg.role === 'user' ? splitUserSkillCommand(msg.content) : null

              return (
              <motion.div
                key={msg.id ?? hiddenCount + i}
                id={msg.id ? `message-${msg.id}` : undefined}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2 }}
                className={`group/message flex w-full py-1.5 sm:py-2 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div className={collapseArtifact
                  ? 'max-w-[840px] w-full'
                  : msg.role === 'assistant'
                    ? 'chat-assistant-message w-full max-w-[840px] text-[15px] leading-7'
                    : 'max-w-[min(720px,86%)] flex flex-col items-end'}>
                  {msg.role === 'assistant' && !collapseArtifact && isCurrentStreamingMessage && (
                    <div className="mb-2 flex items-center gap-2 text-[11px] text-ink-fade" role="status" aria-live="polite">
                      <span className="h-1.5 w-1.5 rounded-full bg-ember animate-pulse" aria-hidden="true" />
                      <span>{t('chatMessages.reasoningActive')}</span>
                    </div>
                  )}
                  {/* 工具调用不再整块堆在正文之前 —— 改由 buildMessageTimeline
                      按 textOffset 交错插进正文里(见下方 assistant 分支)。
                      折叠态(artifact 卡片)没有正文可交错,仍在这里整块渲染。 */}
                  {msg.role === 'assistant' && collapseArtifact
                    && Array.isArray(msg.meta?.toolCalls) && msg.meta.toolCalls.length > 0 && (
                    <ToolCallTrace calls={msg.meta.toolCalls} />
                  )}
                  {msg.role === 'assistant' ? (
                    collapseArtifact ? (
                      <ArtifactOpenCard
                        preview={artifactPreview}
                        onOpen={() => onOpenInPreview?.(msg, artifactPreview)}
                      />
                    ) : (
                      <>
                        <div data-quotable="true">
                          {/* 思考过程排在最前面 —— 它确实发生在正文之前 */}
                          <ReasoningTrace
                            text={msg.meta?.reasoning || ''}
                            streaming={!!msg.meta?.streaming && !msg.content}
                          />
                          {/* ★ 按真实发生顺序交错渲染:说一段 → 干几件事 → 再说一段。
                              以前是「一整块工具调用 + 最后的正文」,读起来像先给结论后干活。 */}
                          {buildMessageTimeline(stripChoices(msg.content), msg.meta?.toolCalls).map((seg, i) => (
                            seg.kind === 'tools'
                              ? <ToolCallTrace key={`t-${i}`} calls={seg.calls} />
                              : <MarkdownRenderer key={`m-${i}`} streaming={isGenerating || !!msg.meta?.streaming}>{seg.text}</MarkdownRenderer>
                          ))}
                        </div>
                        {/* ★ #23: streaming 时在尾部显示闪烁光标 */}
                        {msg.meta?.streaming && (
                          <span className="inline-block w-1.5 h-3.5 bg-ember/80 ml-0.5 align-middle animate-pulse" aria-hidden="true" />
                        )}
                        {/* ★ Reasonix-style ask_choice: [[choice:...]] 选择器 */}
                        {hasChoices(msg.content) && isMessageComplete && (
                          <ChoicePicker
                            text={msg.content}
                            onChoose={(id, title) => {
                              // 把选择注入为下一条用户消息
                              window.dispatchEvent(new CustomEvent('choice-selected', {
                                detail: { messageId: msg.id, choiceId: id, choiceTitle: title },
                              }))
                            }}
                          />
                        )}
                        {/* ★ batchF P2b: 嗅探出来的 artifact 不再替代正文,作为辅助 CTA 出现在正文下方 */}
                        {showArtifactPreview && (
                          <ArtifactOpenCard
                            preview={artifactPreview}
                            onOpen={() => onOpenInPreview?.(msg, artifactPreview)}
                            className="mt-3"
                          />
                        )}
                        <ServerArtifactCards artifacts={msg.meta?.serverArtifacts} />
                      </>
                    )
                  ) : (
                    <div
                      data-testid="user-message-bubble"
                      className={`chat-user-message max-w-full rounded-2xl rounded-br-md border bg-paper-2 px-3.5 py-2 text-[14px] leading-6 ${
                        userSkillCommand?.command ? 'chat-user-skill-message border-ink/20' : 'border-ink/10'
                      }`}
                    >
                      {userSkillCommand?.command && (
                        <span
                          data-testid="sent-skill-command"
                          className="mb-1.5 inline-flex h-6 items-center rounded-md bg-ink px-2 font-mono text-xs font-medium leading-none text-paper shadow-sm"
                        >
                          {userSkillCommand.command}
                        </span>
                      )}
                      <span className={`whitespace-pre-wrap ${userSkillCommand?.command ? 'block text-ink' : ''}`}>
                        {userSkillCommand?.command ? userSkillCommand.body : msg.content}
                      </span>
                    </div>
                  )}
                  {msg.role === 'user' && (
                    <div className="mt-1 flex h-4 items-center justify-end gap-3 pr-1 text-[10px] leading-none text-ink-fade">
                      <span
                        data-testid="user-message-time"
                        className="chat-message-meta opacity-0 pointer-events-none transition-opacity group-hover/message:opacity-100 group-hover/message:pointer-events-auto group-focus-within/message:opacity-100 group-focus-within/message:pointer-events-auto"
                        title={formatMessageDateTime(msg.timestamp, lang)}
                      >
                        {formatMessageTime(msg.timestamp, lang)}
                      </span>
                      {!isGenerating && !msg.meta?.streaming && (
                      <div className="chat-message-actions flex items-center gap-3 opacity-0 pointer-events-none transition-opacity group-hover/message:opacity-100 group-hover/message:pointer-events-auto group-focus-within/message:opacity-100 group-focus-within/message:pointer-events-auto">
                        <button
                          onClick={() => navigator.clipboard?.writeText(msg.content)}
                          className="inline-flex items-center gap-1 hover:text-ink transition-colors"
                          title={t('chatMessages.copyContent')}
                        >
                          <Copy className="w-3 h-3" />
                          {t('chatMessages.copy')}
                        </button>
                      </div>
                      )}
                    </div>
                  )}
                  {msg.role === 'assistant' && (
                    <div className={`${showArtifactPreview ? 'mt-2 px-2' : 'mt-4'} flex flex-wrap items-center gap-2 text-[11px] text-ink-fade/85`}>
                      <div
                        data-testid="assistant-message-meta"
                        className="chat-message-meta flex items-center gap-2 opacity-0 pointer-events-none transition-opacity group-hover/message:opacity-100 group-hover/message:pointer-events-auto group-focus-within/message:opacity-100 group-focus-within/message:pointer-events-auto"
                      >
                        <span title={formatMessageDateTime(msg.timestamp, lang)}>
                          {formatMessageTime(msg.timestamp, lang)}
                        </span>
                        {msg.meta?.type === 'model_reply' && (
                          <span>{t('chatMessages.model', { name: msg.meta.modelName })}</span>
                        )}
                        {msg.meta?.type === 'model_reply' && msg.meta.latency !== undefined && (
                          <span>{t('chatMessages.latency', { value: msg.meta.latency })}</span>
                        )}
                      </div>
                      <div className="flex-1" />
                      {/* ★ #19: 删除 shouldOfferPptxExport/shouldOfferOfficeExport 双路径,
                          artifact 卡片走 RightPreviewPane 自带的导出,卡不出 artifact 时也不再单独显示导出按钮(避免内容嗅探不一致). */}
                      {/* ★ #11: 不论 artifact 还是普通,都给复制按钮 */}
                      {!isGenerating && msg.id !== generatingMessageId && !msg.meta?.streaming && (
                      <div data-testid="assistant-message-actions" className="chat-message-actions ml-auto flex items-center gap-2 opacity-0 pointer-events-none transition-opacity group-hover/message:opacity-100 group-hover/message:pointer-events-auto group-focus-within/message:opacity-100 group-focus-within/message:pointer-events-auto">
                        <button
                          onClick={() => navigator.clipboard?.writeText(msg.content)}
                          className="inline-flex items-center gap-1 text-ink-fade hover:text-ink transition-colors"
                          title={t('chatMessages.copyContent')}
                        >
                          <Copy className="w-3 h-3" />
                          {t('chatMessages.copy')}
                        </button>
                      </div>
                      )}
                    </div>
                  )}
                  {msg.role === 'assistant' && msg.meta?.failed && msg.meta?.type !== 'model_reply' && (
                    <div className="mt-3 pt-2 border-t border-dashed border-ember/40 flex flex-wrap items-center gap-2 text-[11px]">
                      <span className="text-ember">{t('chatMessages.replyIncomplete')}</span>
                    </div>
                  )}
                  {msg.role === 'assistant' && msg.meta?.type === 'context_summary' && (
                    <div className="mt-3 border-t border-ink/10 pt-2 text-[11px] text-ink-fade">
                      <CompactionPill
                        count={msg.meta.compressedCount || 0}
                        archiveId={msg.meta.archiveId || msg.meta.compactionArchiveId}
                        onExpand={onExpandCompaction}
                      />
                    </div>
                  )}
                </div>
              </motion.div>
              )
            })}

            {/* Inline permission card */}
            <AnimatePresence>
              {state.permRequest && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.96 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.96 }}
                  className="ml-10 p-4 border border-ember rounded-md bg-ember-soft animate-pulse-ember"
                >
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[9px] tracking-wider text-ember">
                        {t('chatMessages.permissionRequest', { name: state.permRequest.skillName })}
                      </span>
                    </div>
                  </div>
                  <div className="flex flex-col gap-1.5 mb-4">
                    {state.permRequest.perms.map((p, pi) => (
                      <div key={pi} className="flex items-center gap-2 text-sm text-ink-soft">
                        <span className="font-mono text-ink-fade">–</span>
                        {p.name} · {p.detail}
                      </div>
                    ))}
                  </div>
                  <div className="flex gap-2 items-center">
                    <button onClick={onPermAllow} className="h-9 px-4 bg-ember text-paper rounded-md font-hand text-sm hover:bg-ember/90 transition-colors">
                      {t('chatMessages.allowContinue')}
                    </button>
                    <button onClick={onPermDeny} className="h-9 px-4 border border-ink/70 rounded-md font-hand text-sm hover:bg-paper-2 transition-colors">
                      {t('chatMessages.deny')}
                    </button>
                    <button onClick={onNavigatePermissions} className="h-9 px-4 border border-dashed border-ink-fade/60 rounded-md font-hand text-sm hover:border-ink-fade transition-colors">
                      {t('chatMessages.refineScope')}
                    </button>
                    <div className="flex-1" />
                    <span className="text-xs text-ink-soft flex items-center gap-1">
                      <LayoutList className="w-3.5 h-3.5" />
                      {t('chatMessages.permissionHandled')}
                    </span>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </>
        ) : <NewConversationWelcome onPromptSelect={onPromptSelect} />}
      </div>
      {/* #11 浮动「回到底部」按钮 — 离底超过 80px 才显示 */}
      {!atBottom && messages.length > 0 && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-4 right-6 z-10 inline-flex items-center gap-1.5 h-8 px-3 rounded-full bg-paper border border-ink-fade/60 shadow-sm text-xs text-ink-soft hover:border-ink-fade hover:text-ink transition-colors"
          title={t('chatMessages.backToBottom')}
          aria-label={t('chatMessages.backToBottom')}
        >
          <ChevronDown className="w-3.5 h-3.5" />
          {t('chatMessages.backToBottom')}
        </button>
      )}
      {/* ★ PR3: 选中文本「引用」浮动气泡 */}
      {quoteBubble && (
        <button
          type="button"
          onMouseDown={(e) => { e.preventDefault(); handleQuoteClick() }}
          style={{ top: quoteBubble.top, left: quoteBubble.left, transform: 'translateX(-50%)' }}
          className="absolute z-20 inline-flex items-center gap-1 h-7 px-2.5 rounded-full bg-ink text-paper text-xs font-medium shadow-lg hover:bg-ember transition-colors"
          title={t('nav.quoteSelectionTitle')}
          aria-label={t('nav.quoteSelectionTitle')}
        >
          <Quote className="w-3 h-3" />
          {t('nav.quoteSelection')}
        </button>
      )}
    </div>
  )
}
