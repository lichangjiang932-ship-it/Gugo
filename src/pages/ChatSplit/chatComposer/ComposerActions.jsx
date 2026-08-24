import { Plus, Send, Square } from 'lucide-react'
import { useEffect, useRef } from 'react'
import PermissionModeSwitcher from '../../../components/PermissionModeSwitcher.jsx'
import { normalizeOptionalTokenCount } from '../../../lib/contextUsage.js'
import ModelPicker from '../ModelPicker.jsx'
import ContextUsagePanel from '../chatMessages/ContextUsagePanel.jsx'
import { modelReadinessMessageKey } from '../chatModelReadiness.js'

/**
 * 上下文用量圆环:满环 = 上下文窗口用满。颜色随用量变化:
 * 绿 < 60% · 琥珀 60-80% · 红 ≥ 80%。点击展开/收起详情面板。
 */
function ContextRing({ percent }) {
  const radius = 7
  const circumference = 2 * Math.PI * radius
  const clamped = Math.max(0, Math.min(100, Number(percent) || 0))
  const offset = circumference * (1 - clamped / 100)
  const color = clamped >= 80
    ? 'rgb(var(--color-danger-rgb))'
    : clamped >= 60
      ? 'rgb(var(--color-warning-rgb))'
      : 'rgb(var(--color-success-rgb))'
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
  hasDraftText = false,
  isGenerating,
  modelReadiness = { kind: 'ready', canSend: true },
  modelOptions,
  modelPickerOpen,
  onAbort,
  onApprovalModeChange,
  onCloseModelPicker,
  onFileChange,
  onManageModels,
  onModelChange,
  onModelRetry,
  onOpenModelPicker,
  onSend,
  onToggleContext,
  sendDisabled,
  selectedModel,
  selectedModelProviderId,
  t,
}) {
  const contextPopoverRef = useRef(null)
  const readinessMessageKey = modelReadinessMessageKey(modelReadiness)
  const primaryActionStopsTurn = isGenerating && !hasDraftText
  const primaryActionLabel = primaryActionStopsTurn
    ? t('chatComposer.stop')
    : !isGenerating && readinessMessageKey
      ? t(readinessMessageKey)
      : t('chatComposer.send')
  const usage = contextUsage || {}
  const measuredTokens = normalizeOptionalTokenCount(usage.actualPromptTokens)
  const hasMeasuredTokens = measuredTokens !== null
  const serverEstimatedTokens = normalizeOptionalTokenCount(usage.serverEstimatedPromptTokens)
  const usedTokens = measuredTokens
    ?? serverEstimatedTokens
    ?? Number(usage.estimatedTokens || 0)
  const contextWindowAuthoritative = usage.contextWindowAuthoritative !== false
  const contextWindow = contextWindowAuthoritative
    ? Math.max(1, Number(usage.contextWindow || 0))
    : null
  const measuredPercent = contextWindowAuthoritative
    ? (hasMeasuredTokens || serverEstimatedTokens !== null
        ? (usedTokens / contextWindow) * 100
        : Number(usage.percent))
    : 0
  const percent = Number.isFinite(measuredPercent) ? Math.max(0, Math.min(100, measuredPercent)) : 0
  const tokenSummary = `${hasMeasuredTokens ? '' : '~'}${usedTokens.toLocaleString()} tokens`
  const ringTitle = contextWindowAuthoritative
    ? `${Math.round(percent)}% · ${tokenSummary.replace(' tokens', '')} / ${Number(usage.contextWindow || 0).toLocaleString()} tokens`
    : tokenSummary

  useEffect(() => {
    if (!contextPanelOpen) return undefined
    const closeOnOutsidePointer = (event) => {
      if (!contextPopoverRef.current?.contains(event.target)) onToggleContext?.()
    }
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') onToggleContext?.()
    }
    window.addEventListener('pointerdown', closeOnOutsidePointer)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('pointerdown', closeOnOutsidePointer)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [contextPanelOpen, onToggleContext])

  return (
    <div data-testid="chat-composer-actions" className="mt-2.5 flex items-end justify-between gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <input
          type="file"
          multiple
          accept="image/*,audio/*,video/*,.txt,.md,.json,.csv,.xml,.yml,.yaml,.log,.js,.jsx,.ts,.tsx,.css,.html,.xlsx,.xls,.xlsm,.ods,.docx,.doc,.pptx,.ppt,.pdf,.zip,.epub,.rtf"
          ref={fileInputRef}
          className="hidden"
          onChange={onFileChange}
        />
        <button onClick={() => fileInputRef.current?.click()} title={t('chatComposer.attachment')} aria-label={t('chatComposer.attachment')} className="chat-composer-action-button inline-flex h-7 w-7 items-center justify-center rounded-full text-ink-fade transition-colors hover:bg-ink-ghost hover:text-ink-soft">
          <Plus className="h-4 w-4" />
        </button>
        <PermissionModeSwitcher mode={approvalMode} onChange={onApprovalModeChange} disabled={isGenerating} />
      </div>
      <div className="flex min-w-0 items-end gap-1.5">
        <ModelPicker
          open={modelPickerOpen}
          modelOptions={modelOptions}
          modelReadiness={modelReadiness}
          selectedModel={selectedModel}
          selectedModelProviderId={selectedModelProviderId}
          onOpen={onOpenModelPicker}
          onClose={onCloseModelPicker}
          onSelect={onModelChange}
          onManage={onManageModels}
          onRetry={onModelRetry}
        />
        <div ref={contextPopoverRef} className="relative">
          {contextPanelOpen && (
            <div className="absolute bottom-[calc(100%+8px)] right-0 z-50 w-[min(19rem,calc(100vw-1rem))]" data-testid="context-usage-popover">
              <ContextUsagePanel contextUsage={usage} contextWindow={usage.contextWindow} t={t} />
            </div>
          )}
          <button
            type="button"
            data-testid="context-ring"
            onClick={onToggleContext}
            aria-expanded={!!contextPanelOpen}
            aria-haspopup="dialog"
            aria-label={ringTitle}
            title={ringTitle}
            className={`chat-composer-action-button inline-flex h-7 w-7 items-center justify-center rounded-full transition-colors ${contextPanelOpen ? 'bg-paper-2 text-ink-soft' : 'text-ink-fade hover:bg-ink-ghost hover:text-ink-soft'}`}
          >
            <ContextRing percent={percent} />
          </button>
        </div>
        {isGenerating && hasDraftText && (
          <button
            type="button"
            data-testid="composer-stop-action"
            onClick={onAbort}
            title={t('chatComposer.stop')}
            aria-label={t('chatComposer.stop')}
            className="flex h-8 w-8 items-center justify-center rounded-full border border-ink/10 bg-paper text-ink-soft transition-colors hover:border-ink/20 hover:bg-ink/[0.045]"
          >
            <Square className="h-3 w-3 fill-current" />
          </button>
        )}
        <button
          type="button"
          data-testid="composer-primary-action"
          onClick={primaryActionStopsTurn ? onAbort : onSend}
          disabled={!isGenerating && sendDisabled}
          title={primaryActionLabel}
          aria-label={primaryActionLabel}
          className="chat-composer-primary-action flex h-8 w-8 items-center justify-center rounded-full bg-ink text-paper transition-colors hover:bg-ink-soft disabled:cursor-not-allowed disabled:opacity-35"
        >
          {primaryActionStopsTurn
            ? <Square className="h-3.5 w-3.5 fill-current text-paper" />
            : <Send className="h-3.5 w-3.5 text-paper" />}
        </button>
      </div>
    </div>
  )
}
