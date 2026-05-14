import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, FileText, BarChart3, LayoutList, Download } from 'lucide-react'
import MarkdownRenderer from '../../components/MarkdownRenderer.jsx'
import {
  buildPresentationFilename,
  downloadPptxFromMarkdown,
  parseMarkdownSlides,
  shouldOfferPptxExport,
} from '../../lib/presentationExport.js'
import {
  buildOfficeFilename,
  downloadDocxFromMarkdown,
  downloadXlsxFromMarkdown,
  parseMarkdownDocument,
  parseSpreadsheetRows,
  shouldOfferOfficeExport,
} from '../../lib/officeExport.js'

const EXAMPLE_QUESTIONS = [
  { icon: FileText, label: '生成周报' },
  { icon: BarChart3, label: '分析数据' },
]

function SparklesIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-ember">
      <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z" />
    </svg>
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
  onPermAllow,
  onPermDeny,
  onNavigatePermissions,
}) {
  const hasMessages = messages.length > 0
  const [exportingId, setExportingId] = useState('')

  const handleDownloadPptx = async (msg) => {
    const exportKey = `${msg.id}:pptx`
    setExportingId(exportKey)
    try {
      const slides = parseMarkdownSlides(msg.content)
      const title = slides[0]?.title || msg.meta?.artifactTitle || 'presentation'
      await downloadPptxFromMarkdown(msg.content, {
        title,
        filename: buildPresentationFilename(title),
      })
    } catch (err) {
      window.alert?.(err.message || 'PPTX 导出失败')
    } finally {
      setExportingId('')
    }
  }

  const handleDownloadOffice = async (msg, type) => {
    const exportKey = `${msg.id}:${type}`
    setExportingId(exportKey)
    try {
      if (type === 'docx') {
        const doc = parseMarkdownDocument(msg.content)
        await downloadDocxFromMarkdown(msg.content, {
          title: doc.title,
          filename: buildOfficeFilename(doc.title, 'docx'),
        })
      } else if (type === 'xlsx') {
        const rows = parseSpreadsheetRows(msg.content)
        const title = msg.meta?.artifactTitle || rows[0]?.[0] || 'export'
        await downloadXlsxFromMarkdown(msg.content, {
          title,
          filename: buildOfficeFilename(title, 'xlsx'),
        })
      }
    } catch (err) {
      window.alert?.(err.message || '文件导出失败')
    } finally {
      setExportingId('')
    }
  }

  return (
    <div className="flex-1 overflow-y-auto px-7 py-6">
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
            {messages.map((msg, i) => (
              <motion.div
                key={msg.id ?? i}
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
                <div className={'p-3 rounded-md text-sm leading-relaxed max-w-[920px] ' + (msg.role === 'assistant' ? 'bg-paper-2 border border-ink/10' : 'pt-1.5')}>
                  {msg.role === 'assistant' ? (
                    <MarkdownRenderer>{msg.content}</MarkdownRenderer>
                  ) : (
                    <span className="whitespace-pre-wrap">{msg.content}</span>
                  )}
                  {msg.role === 'user' && (
                    <div className="mt-2 flex justify-end gap-2 text-[11px] text-ink-fade">
                      <button
                        onClick={() => onEditMessage(msg.id, msg.content)}
                        className="hover:text-ink transition-colors"
                        title="编辑并重发"
                      >
                        编辑
                      </button>
                    </div>
                  )}
                  {msg.role === 'assistant' && msg.meta?.type === 'model_reply' && (
                    <div className="mt-3 pt-2 border-t border-dashed border-ink-fade/40 flex flex-wrap gap-2 text-[11px] text-ink-fade items-center">
                      <span>模型：{msg.meta.modelName}</span>
                      {msg.meta.latency !== undefined && <span>延迟：{msg.meta.latency} ms</span>}
                      <div className="flex-1" />
                      {shouldOfferPptxExport(msg.meta) && (
                        <button
                          onClick={() => handleDownloadPptx(msg)}
                          disabled={exportingId === `${msg.id}:pptx`}
                          className="inline-flex items-center gap-1 text-ember hover:text-ink transition-colors disabled:opacity-50"
                          title="导出为 PowerPoint 文件"
                        >
                          <Download className="w-3.5 h-3.5" />
                          {exportingId === `${msg.id}:pptx` ? '生成中' : '下载 PPTX'}
                        </button>
                      )}
                      {(() => {
                        const officeType = shouldOfferOfficeExport(msg.meta)
                        if (!officeType) return null
                        return (
                          <button
                            onClick={() => handleDownloadOffice(msg, officeType)}
                            disabled={exportingId === `${msg.id}:${officeType}`}
                            className="inline-flex items-center gap-1 text-ember hover:text-ink transition-colors disabled:opacity-50"
                            title={`导出为 ${officeType.toUpperCase()} 文件`}
                          >
                            <Download className="w-3.5 h-3.5" />
                            {exportingId === `${msg.id}:${officeType}` ? '生成中' : `下载 ${officeType.toUpperCase()}`}
                          </button>
                        )
                      })()}
                      <button
                        onClick={() => navigator.clipboard?.writeText(msg.content)}
                        className="text-ink-fade hover:text-ink transition-colors"
                        title="复制内容"
                      >
                        复制
                      </button>
                    </div>
                  )}
                  {msg.role === 'assistant' && msg.meta?.type === 'context_summary' && (
                    <div className="mt-3 pt-2 border-t border-dashed border-ink-fade/40 text-[11px] text-ink-fade">
                      已压缩{msg.meta.compressedCount} 条较早消息
                    </div>
                  )}
                </div>
              </motion.div>
            ))}

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
                        ● 请求授权 · {state.permRequest.skillName}
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
    </div>
  )
}
