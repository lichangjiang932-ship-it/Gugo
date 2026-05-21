import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, FileText, BarChart3, LayoutList, ExternalLink, ChevronDown, RefreshCw, Trash2, Copy, Code2, Sparkles, Compass } from 'lucide-react'
import MarkdownRenderer from '../../components/MarkdownRenderer.jsx'
import ToolCallCard from '../../components/ToolCallCard.jsx'
import { buildArtifactPreview, shouldCollapseArtifactPreview } from '../../lib/artifactPreview.js'

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

function TypingIndicator() {
  return (
    <div className="flex items-center gap-1 px-1 py-2">
      <span className="w-1.5 h-1.5 rounded-full bg-ember/60 animate-bounce" style={{ animationDelay: '0ms' }} />
      <span className="w-1.5 h-1.5 rounded-full bg-ember/60 animate-bounce" style={{ animationDelay: '150ms' }} />
      <span className="w-1.5 h-1.5 rounded-full bg-ember/60 animate-bounce" style={{ animationDelay: '300ms' }} />
    </div>
  )
}

function EmptyState({ onExampleClick }) {
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.6 }}
      className="flex-1 flex flex-col items-center justify-center min-h-[360px] gap-10">
      <motion.div initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.6, delay: 0.1, ease: [0.16, 1, 0.3, 1] }} className="relative">
        <div className="w-16 h-16 rounded-2xl border border-ember/30 bg-ember-soft/40 flex items-center justify-center">
          <Compass className="w-7 h-7 text-ember" />
        </div>
      </motion.div>
      <div className="text-center">
        <motion.h1 initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, delay: 0.2 }}
          className="font-display italic text-[34px] text-ink leading-tight">有什么可以帮你的？</motion.h1>
        <motion.p initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, delay: 0.3 }}
          className="text-sm text-ink-soft mt-3">输入问题，或直接点击下方的示例开始</motion.p>
      </div>
      <div className="flex flex-wrap justify-center gap-3 max-w-[600px]">
        {EXAMPLE_QUESTIONS.map((q, i) => (
          <motion.button key={i} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.35 + i * 0.08, duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
            whileHover={{ y: -2 }} whileTap={{ scale: 0.98 }}
            onClick={() => onExampleClick?.(q.label)}
            className="flex items-center gap-2.5 px-4 py-3 border border-ink-fade/25 rounded-xl text-sm text-ink-soft hover:border-ink-fade/50 hover:bg-paper-2/40 hover:shadow-sm transition-all duration-200 bg-paper/40">
            <q.icon className="w-4 h-4 text-ink-fade" />
            {q.label}
          </motion.button>
        ))}
      </div>
    </motion.div>
  )
}

// Safe message renderer with error boundary
function MessageItem({ msg, i, state, onEditMessage, onRegenerateMessage, onDeleteMessage, onOpenInPreview }) {
  try {
    const isUser = msg.role === 'user'
    const isAssistant = msg.role === 'assistant'
    const artifactSource = msg.meta?.artifactSource || (typeof msg.content === 'string' ? msg.content : '')
    const artifactPreview = isAssistant && artifactSource
      ? buildArtifactPreview({ content: artifactSource, meta: msg.meta || {} })
      : null
    const collapseArtifact = shouldCollapseArtifactPreview(artifactPreview)

    return (
      <motion.div key={msg.id ?? i} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
        transition={{ delay: Math.min(i * 0.04, 0.3), duration: 0.35 }}
        className="flex gap-3.5 items-start w-full">
        {/* Avatar */}
        {isUser ? (
          <div className="w-8 h-8 rounded-xl border border-ink/50 flex items-center justify-center bg-paper-2 shrink-0 shadow-sm">
            <span className="font-hand text-xs text-ink">{state?.user?.avatar || '?'}</span>
          </div>
        ) : (
          <div className="w-8 h-8 rounded-xl border border-ember/40 flex items-center justify-center bg-ember-soft/50 shrink-0 shadow-sm">
            <SparklesIcon />
          </div>
        )}

        {/* Content */}
        <div className="max-w-[920px] w-full">
          {/* Tool calls */}
          {isAssistant && Array.isArray(msg.meta?.toolCalls) && msg.meta.toolCalls.length > 0 && (
            <div className="mb-3 flex flex-col gap-1.5">
              {msg.meta.toolCalls.map((tc) => (
                <ToolCallCard key={tc.id || Math.random()} call={tc} />
              ))}
            </div>
          )}

          {/* Message body */}
          {isAssistant ? (
            collapseArtifact ? (
              <button type="button" onClick={() => onOpenInPreview?.(msg, artifactPreview)}
                className="group w-full text-left rounded-xl border border-ink-fade/25 bg-paper/60 hover:border-ember/50 hover:shadow-md transition-all duration-300 p-4 flex items-center gap-3.5">
                <div className="w-11 h-11 rounded-xl bg-ember-soft/60 border border-ember/25 flex items-center justify-center text-ember shrink-0">
                  {artifactPreview?.type === 'pptx' && <BarChart3 className="w-5 h-5" />}
                  {artifactPreview?.type === 'docx' && <FileText className="w-5 h-5" />}
                  {artifactPreview?.type === 'xlsx' && <LayoutList className="w-5 h-5" />}
                  {artifactPreview?.type === 'html' && <ExternalLink className="w-5 h-5" />}
                  {artifactPreview?.type === 'react' && <Code2 className="w-5 h-5" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ember">{artifactPreview?.label}</div>
                  <div className="font-semibold text-ink text-sm truncate">{artifactPreview?.filename}</div>
                  <div className="text-xs text-ink-fade truncate">{artifactPreview?.summary}</div>
                </div>
                <ExternalLink className="w-4 h-4 text-ink-fade group-hover:text-ember transition-colors shrink-0" />
              </button>
            ) : (
              <div className={isAssistant ? 'p-4 rounded-2xl bg-paper-2/50 border border-ink/8' : 'pt-1'}>
                <MarkdownRenderer>{typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)}</MarkdownRenderer>
                {msg.meta?.streaming && <div className="mt-2"><TypingIndicator /></div>}
              </div>
            )
          ) : (
            <>
              <span className="whitespace-pre-wrap text-[15px] leading-relaxed text-ink">{typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)}</span>
              <div className="mt-3 flex justify-end gap-3 text-[11px] text-ink-fade">
                <button onClick={() => navigator.clipboard?.writeText(String(msg.content))}
                  className="inline-flex items-center gap-1 hover:text-ink transition-colors px-1.5 py-0.5 rounded-md hover:bg-paper-2/50">
                  <Copy className="w-3 h-3" />复制
                </button>
                <button onClick={() => onEditMessage?.(msg.id, msg.content)}
                  className="hover:text-ink transition-colors px-1.5 py-0.5 rounded-md hover:bg-paper-2/50">编辑</button>
                {onRegenerateMessage && (
                  <button onClick={() => onRegenerateMessage(msg.id)}
                    className="inline-flex items-center gap-1 hover:text-ink transition-colors px-1.5 py-0.5 rounded-md hover:bg-paper-2/50">
                    <RefreshCw className="w-3 h-3" />重发
                  </button>
                )}
                {onDeleteMessage && (
                  <button onClick={() => onDeleteMessage(msg.id)}
                    className="inline-flex items-center gap-1 hover:text-red-500 transition-colors px-1.5 py-0.5 rounded-md hover:bg-red-50/30">
                    <Trash2 className="w-3 h-3" />删除
                  </button>
                )}
              </div>
            </>
          )}

          {/* Assistant meta */}
          {isAssistant && msg.meta?.type === 'model_reply' && (
            <div className="mt-4 pt-3 border-t border-dashed border-ink-fade/20 flex flex-wrap gap-2.5 text-[11px] text-ink-fade items-center">
              <span className="font-medium">{msg.meta.modelName || ''}</span>
              {msg.meta.latency !== undefined && <span>&middot; {msg.meta.latency}ms</span>}
              {typeof msg.meta.creditsCharged === 'number' && msg.meta.creditsCharged > 0 && (
                <span>&middot; {msg.meta.creditsCharged} 积分
                  {typeof msg.meta.creditsBalance === 'number' && <span className="text-ink-fade/60"> &middot; 余 {msg.meta.creditsBalance}</span>}
                </span>
              )}
              <div className="flex-1" />
              <button onClick={() => navigator.clipboard?.writeText(String(msg.content))}
                className="inline-flex items-center gap-1 hover:text-ink transition-colors px-1.5 py-0.5 rounded-md hover:bg-paper-2/50">
                <Copy className="w-3 h-3" />复制
              </button>
              {onRegenerateMessage && (
                <button onClick={() => onRegenerateMessage(msg.id)}
                  className="inline-flex items-center gap-1 hover:text-ink transition-colors px-1.5 py-0.5 rounded-md hover:bg-paper-2/50">
                  <RefreshCw className="w-3 h-3" />重新生成
                </button>
              )}
              {onDeleteMessage && (
                <button onClick={() => onDeleteMessage(msg.id)}
                  className="inline-flex items-center gap-1 hover:text-red-500 transition-colors px-1.5 py-0.5 rounded-md hover:bg-red-50/30">
                  <Trash2 className="w-3 h-3" />删除
                </button>
              )}
            </div>
          )}
        </div>
      </motion.div>
    )
  } catch (err) {
    console.error('Message render error:', err, msg)
    return (
      <div key={msg.id ?? i} className="p-3 border border-red-300/30 rounded-xl bg-red-50/20 text-xs text-red-700">
        消息渲染错误: {err.message}
      </div>
    )
  }
}

export default function ChatMessages({
  messages,
  state,
  workbenchMessage,
  showContextPanel,
  setShowContextPanel,
  selectedModel,
  isGenerating,
  onExampleClick,
  onEditMessage,
  onRegenerateMessage,
  onDeleteMessage,
  onPermAllow,
  onPermDeny,
  onNavigatePermissions,
  onOpenInPreview,
}) {
  const scrollRef = useRef(null)
  const [atBottom, setAtBottom] = useState(true)
  const lastCountRef = useRef(0)

  // Ensure messages is always an array
  const safeMessages = Array.isArray(messages) ? messages : []
  const hasMessages = safeMessages.length > 0

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => { setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80) }
    el.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const grew = safeMessages.length > lastCountRef.current
    const lastMsg = safeMessages[safeMessages.length - 1]
    const streaming = lastMsg?.meta?.streaming
    if ((grew || streaming) && atBottom) el.scrollTop = el.scrollHeight
    lastCountRef.current = safeMessages.length
  }, [safeMessages, atBottom])

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto px-7 py-6 relative">
      <div className="w-full max-w-[1080px] ml-0 mr-auto flex flex-col gap-5">
        {/* Workbench Message */}
        <AnimatePresence>
          {workbenchMessage && (
            <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
              className="p-3 border border-ink-fade/25 rounded-xl bg-paper-2/40 text-xs text-ink-soft backdrop-blur-sm">
              {workbenchMessage}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Context Panel */}
        <AnimatePresence>
          {showContextPanel && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
              className="border border-ember/20 bg-ember-soft/30 rounded-xl p-4 text-xs text-ink-soft backdrop-blur-sm">
              <div className="flex items-center justify-between mb-3">
                <span className="section-label text-ember">CONTEXT</span>
                <button onClick={() => setShowContextPanel(false)} className="text-ink-fade hover:text-ink p-1 rounded-md hover:bg-paper-2/50 transition-colors">
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
              <div className="grid grid-cols-3 gap-3 text-[11px]">
                <div className="p-2.5 rounded-lg bg-paper/40 border border-ink-fade/15">
                  <span className="text-ink-fade block mb-1">消息数</span>
                  <div className="font-hand text-lg text-ink">{safeMessages.length}</div>
                </div>
                <div className="p-2.5 rounded-lg bg-paper/40 border border-ink-fade/15">
                  <span className="text-ink-fade block mb-1">字符数</span>
                  <div className="font-hand text-lg text-ink">
                    {safeMessages.reduce((sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 0), 0)}
                  </div>
                </div>
                <div className="p-2.5 rounded-lg bg-paper/40 border border-ink-fade/15">
                  <span className="text-ink-fade block mb-1">模型</span>
                  <div className="font-hand text-lg text-ink truncate">{selectedModel || '后端默认'}</div>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Messages */}
        {hasMessages ? (
          <>
            {safeMessages.map((msg, i) => (
              <MessageItem key={msg.id ?? i} msg={msg} i={i} state={state}
                onEditMessage={onEditMessage} onRegenerateMessage={onRegenerateMessage}
                onDeleteMessage={onDeleteMessage} onOpenInPreview={onOpenInPreview} />
            ))}

            {/* Permission Request */}
            <AnimatePresence>
              {state?.permRequest && (
                <motion.div initial={{ opacity: 0, scale: 0.96, y: 8 }} animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0, scale: 0.96, y: 8 }}
                  className="ml-11 p-5 border border-ember/30 rounded-2xl bg-ember-soft/40 animate-pulse-ember backdrop-blur-sm">
                  <div className="flex items-center justify-between mb-4">
                    <span className="section-label text-ember">请求授权 &middot; {state.permRequest.skillName}</span>
                  </div>
                  <div className="flex flex-col gap-2 mb-5">
                    {(state.permRequest.perms || []).map((p, pi) => (
                      <div key={pi} className="flex items-center gap-2.5 text-sm text-ink-soft">
                        <span className="w-1 h-1 rounded-full bg-ember/60" />
                        {p.name} &middot; {p.detail}
                      </div>
                    ))}
                  </div>
                  <div className="flex gap-2.5 items-center flex-wrap">
                    <button onClick={onPermAllow} className="h-9 px-5 bg-ember text-paper rounded-xl font-hand text-sm hover:bg-ember/90 transition-colors shadow-sm">允许并继续</button>
                    <button onClick={onPermDeny} className="h-9 px-5 border border-ink/30 rounded-xl font-hand text-sm hover:bg-paper-2/50 transition-colors">拒绝</button>
                    <button onClick={onNavigatePermissions} className="h-9 px-5 border border-dashed border-ink-fade/40 rounded-xl font-hand text-sm hover:border-ink-fade/70 transition-colors">细化范围</button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </>
        ) : (
          <EmptyState onExampleClick={onExampleClick} />
        )}
      </div>

      {/* Scroll to bottom */}
      <AnimatePresence>
        {!atBottom && hasMessages && (
          <motion.button initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }}
            onClick={() => { const el = scrollRef.current; if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }) }}
            className="absolute bottom-5 right-7 z-10 inline-flex items-center gap-1.5 h-9 px-4 rounded-full bg-paper/80 backdrop-blur-md border border-ink-fade/25 shadow-lg text-xs text-ink-soft hover:border-ink-fade/50 hover:text-ink transition-all">
            <ChevronDown className="w-3.5 h-3.5" />回到底部
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  )
}
