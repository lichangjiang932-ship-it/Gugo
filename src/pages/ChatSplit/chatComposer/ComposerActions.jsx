import { ArrowUp, Pause, Plus, Square } from 'lucide-react'
import { useCallback, useEffect, useId, useRef } from 'react'
import PopoverPortal from '../../../components/ui/PopoverPortal.jsx'
import { isCompositionEvent } from '../../../lib/compositionEvent.js'
import PermissionModeSwitcher from '../../../components/PermissionModeSwitcher.jsx'
import { formatContextPercent, resolveContextMeter } from '../../../lib/contextMeter.js'
import ModelPicker from '../ModelPicker.jsx'
import ContextUsagePanel from '../chatMessages/ContextUsagePanel.jsx'
import { modelReadinessMessageKey } from '../chatModelReadiness.js'

/**
 * 上下文用量圆环:满环 = 上下文窗口用满。颜色随用量变化:
 * 绿 < 60% · 琥珀 60-80% · 红 ≥ 80%。点击展开/收起详情面板。
 *
 * Three states, never two: an exact window draws a solid arc, a catalogue or
 * default window draws a thinner arc plus `≈`, and no window at all draws only
 * a dashed track. Hiding an estimated denominator made the ring say "unknown"
 * next to a concrete percentage elsewhere.
 */
function ContextRing({ percent, known = true, estimated = false }) {
  const radius = 7
  const circumference = 2 * Math.PI * radius
  const clamped = Math.max(0, Math.min(100, Number(percent) || 0))
  // Keep the actual arc proportion. Tiny non-zero values remain explicit in the tooltip.
  const shown = clamped
  const offset = circumference * (1 - shown / 100)
  const color = !known ? 'currentColor' : clamped >= 80
    ? 'rgb(var(--color-danger-rgb))'
    : clamped >= 60
      ? 'rgb(var(--color-warning-rgb))'
      : 'rgb(var(--color-success-rgb))'
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" className="block" aria-hidden="true" data-ring-state={!known ? 'unknown' : estimated ? 'estimated' : 'exact'}>
      <circle cx="9" cy="9" r={radius} fill="none" stroke="currentColor" strokeOpacity={known ? 0.15 : 0.3} strokeWidth="2" strokeLinecap="round" />
      {known && (
        <circle data-testid="context-ring-arc" cx="9" cy="9" r={radius} fill="none" stroke={color} strokeWidth={estimated ? 1.5 : 2} strokeLinecap="butt" strokeDasharray={circumference} strokeDashoffset={offset} transform="rotate(-90 9 9)" />
      )}
    </svg>
  )
}

export default function ComposerActions({
  approvalMode,
  contextPanelOpen,
  contextUsage,
  fileInputRef,
  hasDraftText = false,
  hasAttachments = false,
  isGenerating,
  modelReadiness = { kind: 'ready', canSend: true },
  modelOptions,
  modelPickerOpen,
  onAbort,
  onPause,
  onApprovalModeChange,
  onCloseModelPicker,
  onFileChange,
  onManageModels,
  onModelChange,
  onModelRetry,
  onOpenModelPicker,
  onSend,
  onToggleContext,
  sendBlockedReason = '',
  sendDisabled,
  selectedModel,
  selectedModelProviderId,
  t,
}) {
  const contextPopoverRef = useRef(null)
  const contextTriggerRef = useRef(null)
  const contextPanelRef = useRef(null)
  const contextClosingRef = useRef(false)
  const contextPanelId = useId()
  const closeContext = useCallback((restoreFocus = false) => {
    if (!contextPanelOpen || contextClosingRef.current) return
    contextClosingRef.current = true
    onToggleContext?.()
    if (restoreFocus) contextTriggerRef.current?.focus({ preventScroll: true })
  }, [contextPanelOpen, onToggleContext])
  useEffect(() => {
    if (!contextPanelOpen) return
    contextClosingRef.current = false
    contextPanelRef.current?.querySelector('[role="dialog"]')?.focus({ preventScroll: true })
  }, [contextPanelOpen])
  const readinessMessageKey = modelReadinessMessageKey(modelReadiness)
  // A ready or pending attachment is draft content: the product rule is that an
  // attachment never turns send into pause, so a stray tap cannot freeze a turn
  // the user was still composing for. Only an empty draft pauses.
  // Pausing is its own action; without a handler it degrades to the previous
  // stop behaviour rather than becoming a dead button.
  const requestPause = typeof onPause === 'function' ? onPause : onAbort
  const hasDraftContent = hasDraftText || hasAttachments
  const primaryActionPausesTurn = isGenerating && !hasDraftContent
  const localSendBlockedReason = primaryActionPausesTurn ? ''
    : !hasDraftContent ? t('chatComposer.emptySend')
      : isGenerating && !hasDraftText ? t('chatComposer.textOnly')
        : ''
  const primaryActionLabel = primaryActionPausesTurn
    ? t('chatComposer.pause')
    : !isGenerating && readinessMessageKey
      ? t(readinessMessageKey)
      : t('chatComposer.send')
  const primaryBlockedReason = primaryActionPausesTurn ? ''
    : sendBlockedReason || localSendBlockedReason
  const primaryDisabled = primaryActionPausesTurn ? false : (sendDisabled || Boolean(primaryBlockedReason))
  const primaryTitle = primaryDisabled ? (primaryBlockedReason || primaryActionLabel) : primaryActionLabel
  const usage = contextUsage || {}
  const meter = resolveContextMeter(usage)
  const windowKnown = meter.contextWindowKnown ?? meter.percent !== null
  const windowEstimated = meter.contextWindowEstimated === true
  const percent = meter.percent === null ? 0 : Math.max(0, Math.min(100, meter.percent))
  const tokenSummary = `~${Math.ceil(meter.usedTokens).toLocaleString()} tokens`
  const formattedPercent = formatContextPercent(meter.percent)
  const ringTitle = [t('chat.contextUsage.pendingContext'), formattedPercent, tokenSummary,
    windowKnown ? `/ ${meter.contextWindow.toLocaleString()} tokens` : t('chat.contextUsage.windowUnknown'),
    windowKnown ? t(windowEstimated ? 'chat.contextUsage.windowEstimated' : 'chat.contextUsage.windowExact') : null].filter(Boolean).join(' · ')

  useEffect(() => {
    if (!contextPanelOpen) return undefined
    const closeOnOutsidePointer = (event) => {
      if (!contextPopoverRef.current?.contains(event.target) && !contextPanelRef.current?.contains(event.target)) closeContext()
    }
    const closeOnEscape = (event) => {
      if (event.key === 'Escape' && !event.defaultPrevented && !isCompositionEvent(event)) {
        event.preventDefault(); event.stopPropagation(); closeContext(true)
      }
    }
    window.addEventListener('pointerdown', closeOnOutsidePointer)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('pointerdown', closeOnOutsidePointer)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [closeContext, contextPanelOpen])

  return (
    <div data-testid="chat-composer-actions" className="mt-2.5 flex flex-wrap items-end justify-between gap-x-3 gap-y-2">
      <div className="flex shrink-0 items-center gap-1.5">
        <input
          type="file"
          multiple
          accept="image/*,audio/*,video/*,.txt,.md,.json,.csv,.xml,.yml,.yaml,.log,.js,.jsx,.ts,.tsx,.css,.html,.xlsx,.xls,.xlsm,.ods,.docx,.doc,.pptx,.ppt,.pdf,.zip,.epub,.rtf"
          ref={fileInputRef}
          className="hidden"
          onChange={onFileChange}
        />
        <button type="button" onClick={() => fileInputRef.current?.click()} title={t('chatComposer.attachment')} aria-label={t('chatComposer.attachment')} className="chat-composer-action-button inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-ink-fade transition-colors hover:bg-ink/[0.045] hover:text-ink">
          <Plus className="h-4 w-4" />
        </button>
        <PermissionModeSwitcher mode={approvalMode} onChange={onApprovalModeChange} disabled={isGenerating} />
      </div>
      <div className="ml-auto flex min-w-0 max-w-full items-end gap-1.5">
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
        <div ref={contextPopoverRef} className="relative shrink-0"
          onBlurCapture={(event) => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget) && !contextPanelRef.current?.contains(event.relatedTarget)) closeContext() }}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !isCompositionEvent(event)) { event.preventDefault(); event.stopPropagation(); closeContext(true) }
          }}>
          {contextPanelOpen && (
            <PopoverPortal anchorRef={contextTriggerRef} ref={contextPanelRef} heightLimit={448} onDismiss={closeContext}>
            <div className="w-full overflow-y-auto" style={{ maxHeight: 'inherit' }} data-testid="context-usage-popover">
              <ContextUsagePanel id={contextPanelId} contextUsage={usage} contextWindow={usage.contextWindow} t={t} />
            </div>
            </PopoverPortal>
          )}
          <button
            type="button"
            data-testid="context-ring"
            ref={contextTriggerRef}
            aria-controls={contextPanelOpen ? contextPanelId : undefined}
            onClick={onToggleContext}
            aria-expanded={!!contextPanelOpen}
            aria-haspopup="dialog"
            aria-label={ringTitle}
            title={ringTitle}
            className={`chat-composer-action-button inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors ${contextPanelOpen ? 'bg-paper-2 text-ink' : 'text-ink-fade hover:bg-ink/[0.045] hover:text-ink'}`}
          >
            <ContextRing percent={percent} known={windowKnown} estimated={windowEstimated} />
          </button>
        </div>
        {isGenerating && hasDraftContent && (
          <button
            type="button"
            data-testid="composer-stop-action"
            onClick={onAbort}
            title={t('chatComposer.stop')}
            aria-label={t('chatComposer.stop')}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-ink/10 bg-paper text-ink-soft transition-colors hover:border-ink/20 hover:bg-ink/[0.045]"
          >
            <Square className="h-3 w-3 fill-current" />
          </button>
        )}
        <button
          type="button"
          data-testid="composer-primary-action"
          onClick={primaryActionPausesTurn ? requestPause : onSend}
          disabled={primaryDisabled}
          title={primaryTitle}
          aria-label={primaryTitle}
          className="chat-composer-primary-action flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-ink-soft/20 bg-ink-soft text-paper shadow-[0_1px_2px_rgb(var(--color-ink-rgb)/0.14)] transition-[background-color,color,box-shadow,opacity] hover:bg-ink disabled:cursor-not-allowed disabled:border-ink/10 disabled:bg-ink/10 disabled:text-ink-fade disabled:opacity-100 disabled:shadow-none"
        >
          {primaryActionPausesTurn
            ? <Pause className="h-3.5 w-3.5" />
            : <ArrowUp className="h-4 w-4" strokeWidth={2.4} />}
        </button>
      </div>
    </div>
  )
}
