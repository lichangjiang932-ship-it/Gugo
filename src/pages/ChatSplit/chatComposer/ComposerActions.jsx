import { Paperclip, Send, Square } from 'lucide-react'
import PermissionModeSwitcher from '../../../components/PermissionModeSwitcher.jsx'
import ModelPicker from '../ModelPicker.jsx'

/**
 * 上下文用量圆环:满环 = 上下文窗口用满。颜色随用量变化:
 * 绿 < 60% · 琥珀 60-80% · 红 ≥ 80%。点击展开/收起详情面板。
 */
function ContextRing({ percent }) {
  const radius = 7
  const circumference = 2 * Math.PI * radius
  const clamped = Math.max(0, Math.min(100, Number(percent) || 0))
  const offset = circumference * (1 - clamped / 100)
  const color = clamped >= 80 ? '#ef4444' : clamped >= 60 ? '#f59e0b' : '#10b981'
  return (
    <svg width="16" height="16" viewBox="0 0 18 18" className="block" aria-hidden="true">
      <circle cx="9" cy="9" r={radius} fill="none" stroke="currentColor" strokeOpacity="0.15" strokeWidth="2" />
      <circle cx="9" cy="9" r={radius} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={offset} transform="rotate(-90 9 9)" />
    </svg>
  )
}

export default function ComposerActions({
  approvalMode,
  contextPanelOpen,
  contextUsage,
  fileInputRef,
  isGenerating,
  modelOptions,
  modelPickerOpen,
  onAbort,
  onApprovalModeChange,
  onCloseModelPicker,
  onFileChange,
  onManageModels,
  onModelChange,
  onOpenModelPicker,
  onSend,
  onToggleContext,
  sendDisabled,
  selectedModel,
  t,
}) {
  const primaryActionLabel = t(isGenerating ? 'chatComposer.stop' : 'chatComposer.send')
  const usage = contextUsage || {}
  const percent = Number.isFinite(Number(usage.percent)) ? Math.max(0, Math.min(100, Number(usage.percent))) : 0
  const ringTitle = `${Math.round(percent)}% · ${Number(usage.estimatedTokens || 0).toLocaleString()} / ${Number(usage.contextWindow || 0).toLocaleString()} tokens`

  return (
    <div data-testid="chat-composer-actions" className="mt-2.5 flex items-center justify-between gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <input
          type="file"
          multiple
          accept="image/*,.txt,.md,.json,.csv,.xml,.yml,.yaml,.log,.js,.jsx,.ts,.tsx,.css,.html,.xlsx,.xls,.xlsm,.ods,.docx,.doc,.pptx,.ppt,.pdf,.zip,.epub,.rtf"
          ref={fileInputRef}
          className="hidden"
          onChange={onFileChange}
        />
        <button onClick={() => fileInputRef.current?.click()} title={t('chatComposer.attachment')} aria-label={t('chatComposer.attachment')} className="inline-flex h-7 w-7 items-center justify-center rounded-md text-ink-fade transition-colors hover:bg-ink-ghost hover:text-ink-soft">
          <Paperclip className="h-3.5 w-3.5" />
        </button>
        <PermissionModeSwitcher mode={approvalMode} onChange={onApprovalModeChange} disabled={isGenerating} />
      </div>
      <div className="flex min-w-0 items-center gap-1.5">
        <ModelPicker open={modelPickerOpen} modelOptions={modelOptions} selectedModel={selectedModel} onOpen={onOpenModelPicker} onClose={onCloseModelPicker} onSelect={onModelChange} onManage={onManageModels} />
        {/* 上下文用量圆环(替代原语音按钮):点击查看详情 */}
        <button
          type="button"
          data-testid="context-ring"
          onClick={onToggleContext}
          aria-pressed={!!contextPanelOpen}
          aria-label={ringTitle}
          title={ringTitle}
          className={`inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors ${contextPanelOpen ? 'bg-paper-2 text-ink-soft' : 'text-ink-fade hover:bg-ink-ghost hover:text-ink-soft'}`}
        >
          <ContextRing percent={percent} />
        </button>
        <button
          type="button"
          data-testid="composer-primary-action"
          onClick={isGenerating ? onAbort : onSend}
          disabled={!isGenerating && sendDisabled}
          title={primaryActionLabel}
          aria-label={primaryActionLabel}
          className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${isGenerating ? 'bg-ember hover:bg-ember/90' : 'bg-ink hover:bg-ink-soft'}`}
        >
          {isGenerating
            ? <Square className="h-3.5 w-3.5 fill-current text-paper" />
            : <Send className="h-3.5 w-3.5 text-paper" />}
        </button>
      </div>
    </div>
  )
}
