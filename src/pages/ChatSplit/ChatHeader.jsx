import { useState, useRef, useEffect } from 'react'
import { motion } from 'framer-motion'
import { Download, Minimize2, RotateCcw, LayoutList, ChevronDown } from 'lucide-react'

const AGENT_MODES = [
  { id: 'chat', label: 'Chat', color: '#5E4F40' },
  { id: 'plan', label: 'Plan', color: '#2E8FA3' },
  { id: 'code', label: 'Code', color: '#8B6F47' },
  { id: 'research', label: 'Research', color: '#6B7FA3' },
  { id: 'write', label: 'Write', color: '#7A6B8B' },
  { id: 'debug', label: 'Debug', color: '#A55B5B' },
]

export default function ChatHeader({
  activeSession,
  messages,
  lastFailedPrompt,
  modelOptions,
  selectedModel,
  hasTasks,
  agentMode = 'chat',
  onAgentModeChange,
  onExport,
  onCompress,
  onRetry,
  onModelChange,
  onNavigateTask,
}) {
  const [exportOpen, setExportOpen] = useState(false)
  const exportBoxRef = useRef(null)
  const modeRef = useRef(null)

  useEffect(() => {
    if (!exportOpen) return undefined
    const handler = (e) => {
      if (exportBoxRef.current && !exportBoxRef.current.contains(e.target)) setExportOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [exportOpen])

  const activeModeIdx = AGENT_MODES.findIndex(m => m.id === agentMode)

  return (
    <div className="flex items-center justify-between px-6 py-3.5 border-b border-ink-fade/15 bg-paper/60 backdrop-blur-md shrink-0 z-10">
      <div>
        <span className="section-label">
          SESSION · {activeSession?.title || '新对话'}
        </span>
        <h2 className="font-hand text-xl text-ink mt-0.5 leading-tight">
          {activeSession?.title || '新对话'}
        </h2>
      </div>

      <div className="flex gap-2 items-center">
        {/* Agent Mode Selector - Pill Tabs with Slide Indicator */}
        <div
          ref={modeRef}
          className="inline-flex rounded-full border border-ink-fade/30 bg-paper-2/60 p-[3px] relative"
          title="Agent mode"
        >
          <motion.div
            className="absolute top-[3px] bottom-[3px] rounded-full bg-ink"
            initial={false}
            animate={{
              left: `${(activeModeIdx / AGENT_MODES.length) * 100}%`,
              width: `${100 / AGENT_MODES.length}%`,
            }}
            transition={{ type: 'spring', stiffness: 350, damping: 30 }}
            style={{ padding: '0 3px' }}
          />
          {AGENT_MODES.map((mode) => (
            <button
              key={mode.id}
              onClick={() => onAgentModeChange?.(mode.id)}
              className={`relative z-10 h-[26px] px-3 text-[11px] font-medium rounded-full transition-colors duration-200 ${
                agentMode === mode.id ? 'text-paper' : 'text-ink-soft hover:text-ink'
              }`}
            >
              {mode.label}
            </button>
          ))}
        </div>

        {/* Export Dropdown */}
        <div className="relative" ref={exportBoxRef}>
          <button
            onClick={() => setExportOpen((v) => !v)}
            disabled={!activeSession}
            className="inline-flex items-center h-[30px] px-3 rounded-full text-xs border border-ink-fade/30 text-ink-soft hover:border-ink-fade/60 hover:bg-paper-2/60 transition-all duration-200 gap-1.5 disabled:opacity-40"
            title="导出当前会话"
          >
            <Download className="w-3.5 h-3.5" />
            导出
            <ChevronDown className="w-3 h-3" />
          </button>
          {exportOpen && (
            <motion.div
              initial={{ opacity: 0, y: -4, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ duration: 0.15 }}
              className="absolute right-0 mt-1.5 w-36 rounded-xl border border-ink-fade/20 bg-paper shadow-xl z-30 text-xs overflow-hidden"
            >
              <button
                onClick={() => { setExportOpen(false); onExport?.('json') }}
                className="block w-full text-left px-3.5 py-2 hover:bg-paper-2/60 transition-colors"
              >
                JSON (备份)
              </button>
              <button
                onClick={() => { setExportOpen(false); onExport?.('md') }}
                className="block w-full text-left px-3.5 py-2 hover:bg-paper-2/60 transition-colors"
              >
                Markdown
              </button>
            </motion.div>
          )}
        </div>

        {/* Compress */}
        <button
          onClick={onCompress}
          disabled={messages.length <= 8}
          className="inline-flex items-center h-[30px] px-3 rounded-full text-xs border border-ink-fade/30 text-ink-soft hover:border-ink-fade/60 hover:bg-paper-2/60 transition-all duration-200 gap-1.5 disabled:opacity-40"
          title="压缩较早上下文"
        >
          <Minimize2 className="w-3.5 h-3.5" />
          压缩
        </button>

        {/* Retry */}
        {lastFailedPrompt && (
          <motion.button
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            onClick={onRetry}
            className="inline-flex items-center h-[30px] px-3 rounded-full text-xs border border-ember-line/60 text-ember bg-ember-soft/50 hover:bg-ember-soft hover:border-ember-line transition-all duration-200 gap-1.5"
            title="重试上一条失败消息"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            重试
          </motion.button>
        )}

        {/* Model Selector */}
        {modelOptions.length > 0 && (
          <select
            value={selectedModel}
            onChange={(e) => onModelChange(e.target.value)}
            className="h-[30px] px-3 rounded-full text-xs border border-ink-fade/30 bg-paper/60 text-ink-soft outline-none hover:border-ink-fade/60 transition-all cursor-pointer"
            title="选择后端允许的模型"
          >
            {modelOptions.map((model) => (
              <option key={model.name} value={model.name}>
                {model.name} · x{model.multiplier}
              </option>
            ))}
          </select>
        )}

        {/* Tasks Button */}
        {hasTasks && (
          <motion.button
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            onClick={onNavigateTask}
            className="inline-flex items-center h-[30px] px-3.5 rounded-full text-xs border border-ember-line/60 text-ember bg-ember-soft/50 gap-1.5 hover:bg-ember-soft hover:border-ember-line transition-all duration-200 animate-pulse-ember"
          >
            <LayoutList className="w-3.5 h-3.5" />
            任务进行中
          </motion.button>
        )}

        <button
          onClick={onNavigateTask}
          className="inline-flex items-center h-[30px] px-3.5 rounded-full text-xs border border-ink-fade/30 text-ink-soft hover:border-ink-fade/60 hover:bg-paper-2/60 transition-all duration-200 gap-1.5"
        >
          <LayoutList className="w-3.5 h-3.5" />
          任务面板
        </button>
      </div>
    </div>
  )
}
