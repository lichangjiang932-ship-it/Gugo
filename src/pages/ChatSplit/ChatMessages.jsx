import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, FileText, BarChart3, LayoutList, ExternalLink, ChevronDown, RefreshCw, Trash2, Copy, Code2, Quote } from 'lucide-react'
import MarkdownRenderer from '../../components/MarkdownRenderer.jsx'
import ToolCallCard from '../../components/ToolCallCard.jsx'
import SubagentCard from '../../components/SubagentCard.jsx'
import CompactionPill from '../../components/CompactionPill.jsx'
import ChoicePicker from '../../components/ChoicePicker.jsx'
import { hasChoices, stripChoices } from '../../lib/choices.js'
import { buildMessageTimeline } from '../../lib/messageTimeline.js'
import { buildArtifactPreview, shouldCollapseArtifactPreview } from '../../lib/artifactPreview.js'
import { getMemoriesByIdsApi } from '../../lib/memoryClient.js'
import { useT } from '../../i18n/I18nProvider.jsx'

// ★ #22: 入门示例 — 覆盖文档/数据/编程/创意四大类,降低首次使用门槛
const EXAMPLE_QUESTIONS = [
  { icon: FileText, label: '帮我写一份本周项目周报' },
  { icon: BarChart3, label: '把这段销售数据生成 Excel 表格并分析' },
  { icon: FileText, label: '生成一份 5 页的产品介绍 PPT' },
  { icon: LayoutList, label: '帮我列出今天的工作计划' },
]

function SparklesIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-ember">
      <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" />
    </svg>
  )
}

function MemoryUsageDisclosure({ ids = [] }) {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState([])
  const [loadedKey, setLoadedKey] = useState('')
  const [error, setError] = useState(null)
  const idsKey = ids.join(',')
  const errorMessage = error?.key === idsKey ? error.message : ''

  useEffect(() => {
    if (!open || !ids.length || loadedKey === idsKey) return
    let cancelled = false
    getMemoriesByIdsApi(ids)
      .then((data) => {
        if (cancelled) return
        setItems(Array.isArray(data.memories) ? data.memories : [])
        setLoadedKey(idsKey)
        setError(null)
      })
      .catch((err) => {
        if (!cancelled) setError({ key: idsKey, message: err.message || '加载失败' })
      })
    return () => { cancelled = true }
  }, [open, idsKey, loadedKey, ids])

  if (!ids.length) return null

  return (
    <div className="mt-3 rounded-md border border-dashed border-ember/30 bg-ember-soft/30 px-3 py-2 text-xs text-ink-soft">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="inline-flex items-center gap-1 text-ember hover:text-ink transition-colors"
      >
        <span aria-hidden="true">📌</span>
        <span>用了 {ids.length} 条长期记忆</span>
        <span aria-hidden="true">{open ? '▴' : '▾'}</span>
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          {errorMessage && <div className="text-red-500">{errorMessage}</div>}
          {!errorMessage && loadedKey !== idsKey && <div className="text-ink-fade">加载中...</div>}
          {!errorMessage && loadedKey === idsKey && items.length === 0 && (
            <div className="text-ink-fade">这些记忆已不可用</div>
          )}
          {!errorMessage && items.map((memory) => {
            const preview = String(memory.body || '').replace(/\s+/g, ' ').trim().slice(0, 80)
            return (
              <div key={memory.id} className="rounded border border-ink-fade/20 bg-paper/70 px-2.5 py-2">
                <div className="font-medium text-ink truncate">{memory.title}</div>
                <div className="mt-1 text-ink-fade leading-relaxed">{preview}</div>
              </div>
            )
          })}
        </div>
      )}
    </div>
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
  const [manual, setManual] = useState(null)
  if (!text) return null
  // manual 为 null 时跟随默认:思考中展开,出了正文就收起
  const expanded = manual === null ? streaming : manual

  return (
    <div className="mb-2 rounded-md border border-cyan/25 bg-cyan-soft/40 overflow-hidden">
      <button
        type="button"
        onClick={() => setManual(!expanded)}
        className="w-full px-2.5 py-1.5 flex items-center gap-2 text-left hover:bg-cyan-soft/60 transition-colors"
      >
        <ChevronDown className={`w-3 h-3 text-cyan transition-transform ${expanded ? '' : '-rotate-90'}`} />
        <span className="font-mono text-[10px] tracking-wider uppercase text-cyan">思考过程</span>
        <span className="text-xs text-ink-soft">
          {streaming ? '思考中…' : `${text.length} 字`}
        </span>
        {streaming && (
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-cyan animate-pulse" aria-hidden="true" />
        )}
        <span className="ml-auto font-mono text-[10px] text-ink-fade">
          {expanded ? '' : '点击展开'}
        </span>
      </button>
      {expanded && (
        <div className="px-3 pb-2 pt-0.5 border-t border-cyan/15">
          <pre className="whitespace-pre-wrap break-words font-sans text-xs text-ink-soft leading-relaxed max-h-64 overflow-y-auto">
            {text}
          </pre>
        </div>
      )}
    </div>
  )
}

function ToolCallTrace({ calls = [] }) {
  const [open, setOpen] = useState(false)
  const failed = calls.filter((c) => c.status === 'error').length
  const running = calls.filter((c) => c.status === 'running').length
  // 还在跑的时候自动展开,让用户看到进度;跑完了收起来,别淹没正文
  const expanded = open || running > 0

  return (
    <div className="mb-2 rounded-md border border-ink/10 bg-paper/60 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full px-2.5 py-1.5 flex items-center gap-2 text-left hover:bg-paper-2/60 transition-colors"
      >
        <ChevronDown className={`w-3 h-3 text-ink-fade transition-transform ${expanded ? '' : '-rotate-90'}`} />
        <span className="font-mono text-[10px] tracking-wider uppercase text-ink-fade">执行过程</span>
        <span className="text-xs text-ink-soft">
          {running > 0 ? `进行中 · ${calls.length} 步` : `${calls.length} 步`}
          {failed > 0 && <span className="text-red-600 ml-1.5">{failed} 步失败</span>}
        </span>
        <span className="ml-auto font-mono text-[10px] text-ink-fade">
          {expanded ? '' : '点击展开'}
        </span>
      </button>
      {expanded && (
        <div className="px-2 pb-2 pt-0.5 border-t border-ink/10">
          {calls.map((tc) =>
            tc.name === 'Agent'
              ? <SubagentCard key={tc.id} call={tc} />
              : <ToolCallCard key={tc.id} call={tc} />
          )}
          <div className="mt-1.5 pt-1.5 border-t border-dashed border-ink-fade/30 font-mono text-[10px] text-ink-fade">
            ↓ 以下是基于上述执行结果给出的答复
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
  showContextPanel,
  setShowContextPanel,
  selectedModel,
  onExampleClick,
  onEditMessage,
  onRegenerateMessage,
  onDeleteMessage,
  onPermAllow,
  onPermDeny,
  onNavigatePermissions,
  onOpenInPreview,
  onExpandCompaction,
  onQuoteSelection,
}) {
  const { t } = useT()
  const hasMessages = messages.length > 0
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
    const timer = window.setTimeout(() => {
      const target = document.getElementById(targetId)
      target?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }, 80)
    return () => window.clearTimeout(timer)
  }, [messages])

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
    <div ref={(el) => { scrollRef.current = el; containerRef.current = el }} className="flex-1 overflow-y-auto px-7 py-6 relative">
      <div className="w-full max-w-[1080px] ml-0 mr-auto flex flex-col gap-5">
        {workbenchMessage && (
          <div className="p-3 border border-ink-fade/40 rounded-md bg-paper-2 text-xs text-ink-soft">
            {workbenchMessage}
          </div>
        )}
        {showContextPanel && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="border border-dashed border-ember/40 bg-ember-soft/40 rounded-md p-3 text-xs text-ink-soft"
          >
            <div className="flex items-center justify-between mb-2">
              <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-ember">
                CONTEXT · 当前会话上下文
              </span>
              <button onClick={() => setShowContextPanel(false)} className="text-ink-fade hover:text-ink">
                <X className="w-3 h-3" />
              </button>
            </div>
            <div className="grid grid-cols-3 gap-2 text-[11px]">
              <div>
                <span className="text-ink-fade">消息数</span>
                <div className="font-hand text-base text-ink">{messages.length}</div>
              </div>
              <div>
                <span className="text-ink-fade">字符数</span>
                <div className="font-hand text-base text-ink">
                  {messages.reduce((sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 0), 0)}
                </div>
              </div>
              <div>
                <span className="text-ink-fade">模型</span>
                <div className="font-hand text-base text-ink">{selectedModel || '后端默认'}</div>
              </div>
            </div>
            <div className="mt-2 pt-2 border-t border-dashed border-ember/30 text-[11px]">
              <span className="text-ink-fade">提供商：</span>
              <span className="text-ink">由后端 .env 统一配置</span>
              <span className="ml-3 text-ink-fade">API Key 不进入浏览器</span>
            </div>
          </motion.div>
        )}

        {hasMessages ? (
          <>
            {messages.map((msg, i) => {
              const artifactPreview = msg.role === 'assistant' && (msg.meta?.artifactSource || msg.content)
                // G1: 优先用工具产出的 artifactSource(模型显式给的 markdown)
                //     而不是 msg.content(对话回复正文,可能只是个 ack).
                ? buildArtifactPreview({
                    content: msg.meta?.artifactSource || msg.content,
                    meta: msg.meta || {},
                  })
                : null
              const collapseArtifact = shouldCollapseArtifactPreview(artifactPreview)

              return (
              <motion.div
                key={msg.id ?? i}
                id={msg.id ? `message-${msg.id}` : undefined}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.05, duration: 0.35 }}
                className="flex gap-3 items-start w-full"
              >
                {msg.role === 'user' ? (
                  <div className="w-7 h-7 rounded-full border border-ink flex items-center justify-center bg-paper shrink-0">
                    <span className="font-hand text-xs text-ink">{state.user.avatar || '?'}</span>
                  </div>
                ) : (
                  <div className="w-7 h-7 rounded-full border border-ember flex items-center justify-center bg-ember-soft shrink-0">
                    <SparklesIcon />
                  </div>
                )}
                <div className={collapseArtifact ? 'max-w-[920px] w-full' : 'p-3 rounded-md text-sm leading-relaxed max-w-[920px] ' + (msg.role === 'assistant' ? 'bg-paper-2 border border-ink/10' : 'pt-1.5')}>
                  {/* 工具调用不再整块堆在正文之前 —— 改由 buildMessageTimeline
                      按 textOffset 交错插进正文里(见下方 assistant 分支)。
                      折叠态(artifact 卡片)没有正文可交错,仍在这里整块渲染。 */}
                  {msg.role === 'assistant' && collapseArtifact
                    && Array.isArray(msg.meta?.toolCalls) && msg.meta.toolCalls.length > 0 && (
                    <ToolCallTrace calls={msg.meta.toolCalls} />
                  )}
                  {msg.role === 'assistant' ? (
                    collapseArtifact ? (
                      <button
                        type="button"
                        onClick={() => onOpenInPreview?.(msg, artifactPreview)}
                        className="group w-full text-left rounded-md border border-ink-fade/30 bg-paper hover:border-ember/60 hover:shadow-sm transition-all p-3 flex items-center gap-3"
                        title="在右侧预览面板打开"
                      >
                        <div className="w-10 h-10 rounded-md bg-ember-soft border border-ember/30 flex items-center justify-center text-ember shrink-0">
                          {artifactPreview.type === 'pptx' && <BarChart3 className="w-5 h-5" />}
                          {artifactPreview.type === 'docx' && <FileText className="w-5 h-5" />}
                          {artifactPreview.type === 'xlsx' && <LayoutList className="w-5 h-5" />}
                          {artifactPreview.type === 'html' && <ExternalLink className="w-5 h-5" />}
                          {artifactPreview.type === 'html_multi' && <ExternalLink className="w-5 h-5" />}
                          {artifactPreview.type === 'mermaid' && <LayoutList className="w-5 h-5" />}
                          {artifactPreview.type === 'chart' && <BarChart3 className="w-5 h-5" />}
                          {artifactPreview.type === 'svg' && <Code2 className="w-5 h-5" />}
                          {artifactPreview.type === 'react' && <Code2 className="w-5 h-5" />}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ember">
                            {artifactPreview.label}
                          </div>
                          <div className="font-semibold text-ink text-sm truncate" title={artifactPreview.filename}>
                            {artifactPreview.filename}
                          </div>
                          <div className="text-xs text-ink-fade truncate">{artifactPreview.summary}</div>
                        </div>
                        <div className="shrink-0 inline-flex items-center gap-1.5">
                          <span className="text-[11px] text-ink-fade group-hover:text-ember transition-colors hidden sm:inline">
                            在右侧打开
                          </span>
                          <ExternalLink className="w-4 h-4 text-ink-fade group-hover:text-ember transition-colors" />
                        </div>
                      </button>
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
                              : <MarkdownRenderer key={`m-${i}`}>{seg.text}</MarkdownRenderer>
                          ))}
                        </div>
                        {/* ★ #23: streaming 时在尾部显示闪烁光标 */}
                        {msg.meta?.streaming && (
                          <span className="inline-block w-1.5 h-3.5 bg-ember/80 ml-0.5 align-middle animate-pulse" aria-hidden="true" />
                        )}
                        {/* ★ Reasonix-style ask_choice: [[choice:...]] 选择器 */}
                        {hasChoices(msg.content) && !msg.meta?.streaming && (
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
                      </>
                    )
                  ) : (
                    <span className="whitespace-pre-wrap">{msg.content}</span>
                  )}
                  {msg.role === 'assistant' && msg.meta?.injectedMemoryIds?.length > 0 && (
                    <MemoryUsageDisclosure ids={msg.meta.injectedMemoryIds} />
                  )}
                  {msg.role === 'user' && (
                    <div className="mt-2 flex justify-end gap-3 text-[11px] text-ink-fade">
                      <button
                        onClick={() => navigator.clipboard?.writeText(msg.content)}
                        className="inline-flex items-center gap-1 hover:text-ink transition-colors"
                        title="复制内容"
                      >
                        <Copy className="w-3 h-3" />
                        复制
                      </button>
                      <button
                        onClick={() => onEditMessage(msg.id, msg.content)}
                        className="hover:text-ink transition-colors"
                        title="编辑并重发"
                      >
                        编辑
                      </button>
                      {onRegenerateMessage && (
                        <button
                          onClick={() => onRegenerateMessage(msg.id)}
                          className="inline-flex items-center gap-1 hover:text-ink transition-colors"
                          title="重新发送本条"
                        >
                          <RefreshCw className="w-3 h-3" />
                          重发
                        </button>
                      )}
                      {onDeleteMessage && (
                        <button
                          onClick={() => onDeleteMessage(msg.id)}
                          className="inline-flex items-center gap-1 hover:text-red-500 transition-colors"
                          title="删除本条"
                        >
                          <Trash2 className="w-3 h-3" />
                          删除
                        </button>
                      )}
                    </div>
                  )}
                  {msg.role === 'assistant' && msg.meta?.type === 'model_reply' && (
                    <div className={`${artifactPreview ? 'mt-2 px-2' : 'mt-3 pt-2 border-t border-dashed border-ink-fade/40'} flex flex-wrap gap-2 text-[11px] text-ink-fade items-center`}>
                      <span>模型：{msg.meta.modelName}</span>
                      {msg.meta.latency !== undefined && <span>延迟：{msg.meta.latency} ms</span>}
                      {typeof msg.meta.creditsCharged === 'number' && msg.meta.creditsCharged > 0 && (
                        <span title="工具调用每轮都会请求模型,这里是本次对话累计扣的积分">
                          消耗：{msg.meta.creditsCharged} 积分
                          {typeof msg.meta.creditsBalance === 'number' && (
                            <span className="text-ink-fade/70"> · 余 {msg.meta.creditsBalance}</span>
                          )}
                        </span>
                      )}
                      {msg.meta.billingError && (
                        <span className="text-red-500" title={msg.meta.billingError}>计费失败</span>
                      )}
                      <div className="flex-1" />
                      {/* ★ #19: 删除 shouldOfferPptxExport/shouldOfferOfficeExport 双路径,
                          artifact 卡片走 RightPreviewPane 自带的导出,卡不出 artifact 时也不再单独显示导出按钮(避免内容嗅探不一致). */}
                      {/* ★ #11: 不论 artifact 还是普通,都给复制按钮 */}
                      <button
                        onClick={() => navigator.clipboard?.writeText(msg.content)}
                        className="inline-flex items-center gap-1 text-ink-fade hover:text-ink transition-colors"
                        title="复制内容"
                      >
                        <Copy className="w-3 h-3" />
                        复制
                      </button>
                      {onRegenerateMessage && (
                        <button
                          onClick={() => onRegenerateMessage(msg.id)}
                          className="inline-flex items-center gap-1 text-ink-fade hover:text-ink transition-colors"
                          title="基于上一条用户消息重新生成回复"
                        >
                          <RefreshCw className="w-3 h-3" />
                          重新生成
                        </button>
                      )}
                      {onDeleteMessage && (
                        <button
                          onClick={() => onDeleteMessage(msg.id)}
                          className="inline-flex items-center gap-1 text-ink-fade hover:text-red-500 transition-colors"
                          title="删除本条"
                        >
                          <Trash2 className="w-3 h-3" />
                          删除
                        </button>
                      )}
                    </div>
                  )}
                  {msg.role === 'assistant' && msg.meta?.failed && msg.meta?.type !== 'model_reply' && (
                    <div className="mt-3 pt-2 border-t border-dashed border-ember/40 flex flex-wrap items-center gap-2 text-[11px]">
                      <span className="text-ember">这条回复没能完成</span>
                      <div className="flex-1" />
                      {onRegenerateMessage && (
                        <button
                          onClick={() => onRegenerateMessage(msg.id)}
                          className="inline-flex items-center gap-1 h-7 px-2.5 rounded-full border border-ember-line text-ember bg-ember-soft hover:bg-ember/20 transition-colors"
                          title="重新生成这条回复"
                        >
                          <RefreshCw className="w-3 h-3" />
                          重新生成
                        </button>
                      )}
                      {onDeleteMessage && (
                        <button
                          onClick={() => onDeleteMessage(msg.id)}
                          className="inline-flex items-center gap-1 text-ink-fade hover:text-red-500 transition-colors"
                          title="删除本条"
                        >
                          <Trash2 className="w-3 h-3" />
                          删除
                        </button>
                      )}
                    </div>
                  )}
                  {msg.role === 'assistant' && msg.meta?.type === 'context_summary' && (
                    <div className="mt-3 pt-2 border-t border-dashed border-ink-fade/40 text-[11px] text-ink-fade">
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
                        [请求授权] {state.permRequest.skillName}
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
                      允许并继续
                    </button>
                    <button onClick={onPermDeny} className="h-9 px-4 border border-ink/70 rounded-md font-hand text-sm hover:bg-paper-2 transition-colors">
                      拒绝
                    </button>
                    <button onClick={onNavigatePermissions} className="h-9 px-4 border border-dashed border-ink-fade/60 rounded-md font-hand text-sm hover:border-ink-fade transition-colors">
                      细化范围
                    </button>
                    <div className="flex-1" />
                    <span className="text-xs text-ink-soft flex items-center gap-1">
                      <LayoutList className="w-3.5 h-3.5" />
                      权限请求已在本页处理
                    </span>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </>
        ) : (
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="flex-1 flex flex-col items-center justify-center min-h-[360px] gap-8"
          >
            <div className="text-center">
              <h1 className="font-hand text-[32px] text-ink">有什么可以帮你的？</h1>
              <p className="text-sm text-ink-soft mt-2">输入问题，或直接点击下方的示例开始</p>
            </div>
            <div className="flex flex-wrap justify-center gap-3">
              {EXAMPLE_QUESTIONS.map((q, i) => (
                <motion.button
                  key={i}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.15 + i * 0.08 }}
                  onClick={() => onExampleClick(q.label)}
                  className="flex items-center gap-2 px-4 py-2.5 border border-ink-fade/50 rounded-md text-sm text-ink-soft hover:border-ink-fade hover:bg-paper-2 transition-colors"
                >
                  <q.icon className="w-4 h-4 text-ink-fade" />
                  {q.label}
                </motion.button>
              ))}
            </div>
          </motion.div>
        )}
      </div>
      {/* #11 浮动「回到底部」按钮 — 离底超过 80px 才显示 */}
      {!atBottom && messages.length > 0 && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-4 right-6 z-10 inline-flex items-center gap-1.5 h-8 px-3 rounded-full bg-paper border border-ink-fade/60 shadow-sm text-xs text-ink-soft hover:border-ink-fade hover:text-ink transition-colors"
          title="回到底部"
          aria-label="回到底部"
        >
          <ChevronDown className="w-3.5 h-3.5" />
          回到底部
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
