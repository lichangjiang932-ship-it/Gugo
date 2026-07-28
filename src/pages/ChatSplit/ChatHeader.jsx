import {
  Download,
  Minimize2,
  RotateCcw,
  LayoutList,
  ChevronDown,
  PanelRight,
  Settings2,
} from 'lucide-react'
import { useState, useRef, useEffect } from 'react'

export default function ChatHeader({
  activeSession,
  messages,
  lastFailedPrompt,
  modelOptions,
  selectedModel,
  hasTasks,
  showWorkbench = false,
  onToggleWorkbench,
  onExport,
  onCompress,
  onRetry,
  onModelChange,
  onManageModels,
  onNavigateTask,
}) {
  // ★ #12: 导出下拉 (JSON / Markdown)
  const [exportOpen, setExportOpen] = useState(false)
  const exportBoxRef = useRef(null)
  useEffect(() => {
    if (!exportOpen) return undefined
    const handler = (e) => {
      if (exportBoxRef.current && !exportBoxRef.current.contains(e.target)) setExportOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [exportOpen])
  return (
    <div className="flex items-center justify-between px-6 py-4 border-b border-dashed border-ink-fade/50">
      <div>
        <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-ink-fade">
          SESSION · {activeSession?.title || '新对话'}
        </span>
        <h2 className="font-hand text-lg text-ink mt-1">
          {activeSession?.title || '新对话'}
        </h2>
      </div>
      <div className="flex gap-2 items-center">
        <button
          type="button"
          onClick={onToggleWorkbench}
          aria-pressed={showWorkbench}
          className={`inline-flex items-center h-7 px-2.5 rounded-full text-xs border transition-colors gap-1.5 ${showWorkbench ? 'border-ink bg-ink text-paper' : 'border-ink-fade/60 text-ink-soft hover:border-ink-fade'}`}
          title="打开代码工作台"
        >
          <PanelRight className="w-3.5 h-3.5" />
          工作台
        </button>
        <div className="relative" ref={exportBoxRef}>
          <button
            onClick={() => setExportOpen((v) => !v)}
            disabled={!activeSession}
            className="inline-flex items-center h-7 px-2 rounded-full text-xs border border-ink-fade/60 text-ink-soft hover:border-ink-fade transition-colors gap-1 disabled:opacity-50"
            title="导出当前会话"
          >
            <Download className="w-3.5 h-3.5" />
            导出
            <ChevronDown className="w-3 h-3" />
          </button>
          {exportOpen && (
            <div className="absolute right-0 mt-1 w-32 rounded-md border border-ink-fade/40 bg-paper shadow-lg z-20 text-xs">
              <button
                onClick={() => { setExportOpen(false); onExport?.('json') }}
                className="block w-full text-left px-3 py-1.5 hover:bg-ink-fade/10"
              >
                JSON (备份)
              </button>
              <button
                onClick={() => { setExportOpen(false); onExport?.('md') }}
                className="block w-full text-left px-3 py-1.5 hover:bg-ink-fade/10"
              >
                Markdown
              </button>
            </div>
          )}
        </div>
        <button
          onClick={onCompress}
          disabled={messages.length <= 8}
          className="inline-flex items-center h-7 px-2 rounded-full text-xs border border-ink-fade/60 text-ink-soft hover:border-ink-fade transition-colors gap-1 disabled:opacity-50"
          title="压缩较早上下文"
        >
          <Minimize2 className="w-3.5 h-3.5" />
          压缩
        </button>
        {lastFailedPrompt && (
          <button
            onClick={onRetry}
            className="inline-flex items-center h-7 px-2 rounded-full text-xs border border-ember-line text-ember bg-ember-soft hover:bg-ember-soft/70 transition-colors gap-1"
            title="重试上一条失败消息"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            重试
          </button>
        )}
        {modelOptions.length > 0 && (
          <select
            value={selectedModel}
            onChange={(e) => onModelChange(e.target.value)}
            className="h-7 px-2 rounded-full text-xs border border-ink-fade/60 bg-paper text-ink-soft outline-none hover:border-ink-fade"
            title="选择后端允许的模型"
          >
            {modelOptions.map((model) => (
              <option key={model.name} value={model.name}>
                {model.name} · x{model.multiplier}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          onClick={onManageModels}
          className="inline-flex items-center h-7 px-2 rounded-full text-xs border border-ink-fade/60 text-ink-soft hover:border-ink-fade transition-colors gap-1"
          title="添加、检测或切换模型服务"
        >
          <Settings2 className="w-3.5 h-3.5" />
          管理模型
        </button>
        <button
          onClick={onNavigateTask}
          className={`inline-flex items-center h-7 px-3 rounded-full text-xs border transition-colors gap-1.5 ${hasTasks ? 'border-ember-line text-ember bg-ember-soft hover:bg-ember-soft/70' : 'border-ink-fade/60 text-ink-soft hover:border-ink-fade'}`}
        >
          <LayoutList className="w-3.5 h-3.5" />
          {hasTasks ? '任务进行中' : '任务面板'}
        </button>
      </div>
    </div>
  )
}
