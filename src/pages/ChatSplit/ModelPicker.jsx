import { useEffect, useId, useMemo, useRef } from 'react'
import { Check, ChevronDown, RefreshCw } from 'lucide-react'
import { useT } from '../../i18n/I18nProvider.jsx'
import { resolveModelOptionReadiness } from './chatModelReadiness.js'
import { groupModelOptions } from './modelPickerGroups.js'

const READINESS_PRESENTATION = Object.freeze({
  'agent-ready': {
    labelKey: 'chat.modelPicker.readinessAgent',
    detailKey: 'chat.modelPicker.readinessAgentDetail',
    className: 'bg-emerald-50 text-emerald-700',
  },
  'chat-only': {
    labelKey: 'chat.modelPicker.readinessChatOnly',
    detailKey: 'chat.modelPicker.readinessChatOnlyDetail',
    className: 'bg-amber-50 text-amber-700',
  },
  untested: {
    labelKey: 'chat.modelPicker.readinessUntested',
    detailKey: 'chat.modelPicker.readinessUntestedDetail',
    className: 'bg-paper-2 text-ink-fade',
  },
  unavailable: {
    labelKey: 'chat.modelPicker.readinessUnavailable',
    detailKey: 'chat.modelPicker.readinessUnavailableDetail',
    className: 'bg-rose-50 text-rose-700',
  },
})

function contextWindowLabel(value, estimated = false) {
  const tokens = Number(value)
  if (!Number.isFinite(tokens) || tokens <= 0) return ''
  let label = String(tokens)
  if (tokens >= 1_000_000) label = `${Number((tokens / 1_000_000).toFixed(1))}M`
  else if (tokens >= 1_000) label = `${Math.round(tokens / 1_000)}K`
  return estimated ? `~${label}` : label
}

export default function ModelPicker({
  open,
  modelOptions = [],
  modelReadiness,
  selectedModel,
  selectedModelProviderId = '',
  onOpen,
  onClose,
  onSelect,
  onManage,
  onRetry,
}) {
  const { t } = useT()
  const pickerRef = useRef(null)
  const triggerRef = useRef(null)
  const optionRefs = useRef([])
  const listboxId = useId()
  const modelGroups = useMemo(() => groupModelOptions(modelOptions), [modelOptions])
  const orderedModelOptions = useMemo(() => modelGroups.flatMap((group) => group.models), [modelGroups])
  const readiness = modelReadiness || {
    kind: modelOptions.length > 0 ? 'ready' : 'empty',
    canSend: modelOptions.length > 0 && !!selectedModel,
  }
  // Provider readiness describes only the current selection. Keep the complete
  // server catalog browsable so an unavailable selection never traps the user
  // by hiding healthy alternatives.
  const catalogUnavailable = ['loading', 'unconfigured', 'error', 'empty'].includes(readiness.kind)
  const triggerLabelKey = {
    loading: 'chat.modelPicker.loading',
    unconfigured: 'chat.modelPicker.unconfigured',
    error: 'chat.modelPicker.loadError',
    empty: 'chat.modelPicker.configuredEmpty',
    'selection-required': 'chat.modelPicker.selectRequired',
  }[readiness.kind]
  const stateMessageKey = {
    loading: 'chat.modelPicker.loadingDetail',
    unconfigured: 'chat.modelPicker.unconfiguredDetail',
    error: 'chat.modelPicker.loadErrorDetail',
    empty: 'chat.modelPicker.configuredEmptyDetail',
  }[readiness.kind]

  useEffect(() => {
    if (!open) return undefined
    const handlePointerDown = (event) => {
      if (!pickerRef.current?.contains(event.target)) onClose?.()
    }
    const handleKeyDown = (event) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose?.()
      window.setTimeout(() => triggerRef.current?.focus(), 0)
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open, onClose])

  useEffect(() => {
    if (!open || typeof window === 'undefined') return undefined
    const selectedIndex = orderedModelOptions.findIndex((model) => (
      model.name === selectedModel
      && (!selectedModelProviderId || model.provider === selectedModelProviderId)
    ))
    const focusTimer = window.setTimeout(() => {
      const selectedOption = optionRefs.current[selectedIndex]
      const firstSelectable = optionRefs.current.find((option) => option && !option.disabled)
      ;(selectedOption && !selectedOption.disabled ? selectedOption : firstSelectable)?.focus()
    }, 0)
    return () => window.clearTimeout(focusTimer)
  }, [open, orderedModelOptions, selectedModel, selectedModelProviderId])

  const handleTriggerKeyDown = (event) => {
    if (open || !['ArrowDown', 'ArrowUp'].includes(event.key)) return
    event.preventDefault()
    onOpen?.()
  }

  const handleListboxKeyDown = (event) => {
    const options = optionRefs.current.filter((option) => option && !option.disabled)
    if (!options.length) return
    const currentIndex = options.indexOf(document.activeElement)
    const focusOption = (nextIndex) => {
      const normalized = ((nextIndex % options.length) + options.length) % options.length
      options[normalized]?.focus()
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      focusOption(currentIndex + 1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      focusOption(currentIndex - 1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      focusOption(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      focusOption(options.length - 1)
    }
  }

  return (
    <div ref={pickerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? onClose?.() : onOpen?.())}
        onKeyDown={handleTriggerKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        className={`inline-flex h-7 max-w-56 items-center gap-1.5 rounded-pill border px-2.5 text-xs transition-colors ${open ? 'border-accent bg-accent-soft text-accent-ink' : readiness.canSend ? 'border-ink-fade/60 text-ink-soft hover:border-ink-fade' : 'border-amber-400/70 bg-amber-50 text-amber-800 hover:border-amber-500'}`}
        title={t('chat.modelPicker.open')}
        data-testid="model-picker-trigger"
      >
        {readiness.kind === 'loading' && <RefreshCw className="h-3 w-3 shrink-0 animate-spin" aria-hidden="true" />}
        <span className="truncate">{selectedModel || t(triggerLabelKey || 'chat.modelPicker.selectRequired')}</span>
        <ChevronDown className={`h-3 w-3 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div
          className="absolute bottom-full right-0 z-40 mb-2 w-[min(22rem,calc(100vw-3rem))] overflow-hidden rounded-card border border-ink-fade/40 bg-paper shadow-xl"
          data-testid="model-picker-panel"
        >
          <div className="border-b border-ink-fade/30 px-3 py-2.5">
            <div className="text-sm font-medium text-ink">{t('chat.modelPicker.title')}</div>
            <div className="mt-0.5 text-xs text-ink-fade">{t('chat.modelPicker.subtitle')}</div>
          </div>
          <div
            id={listboxId}
            role="listbox"
            aria-label={t('chat.modelPicker.title')}
            onKeyDown={handleListboxKeyDown}
            className="max-h-72 overflow-y-auto p-1.5"
          >
            {catalogUnavailable ? (
              <div className="px-3 py-4 text-center text-xs text-ink-fade" data-testid={`model-picker-state-${readiness.kind}`}>
                <p>{t(stateMessageKey || 'chat.modelPicker.empty')}</p>
                {(readiness.kind === 'error' || readiness.kind === 'empty') && (
                  <button
                    type="button"
                    onClick={onRetry}
                    className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-control border border-ink-fade/50 px-3 font-medium text-ink-soft hover:border-ink-fade hover:text-ink"
                  >
                    <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                    {t('chat.modelPicker.retry')}
                  </button>
                )}
              </div>
            ) : modelOptions.length === 0 ? (
              <div className="px-2 py-4 text-center text-xs text-ink-fade">{t('chat.modelPicker.empty')}</div>
            ) : modelGroups.map((group, groupIndex) => {
              const groupLabel = group.label || t('chat.modelPicker.defaultGroup')
              const groupLabelId = `${listboxId}-group-${groupIndex}`
              return (
                <div key={group.key} role="group" aria-labelledby={groupLabelId} data-testid="model-picker-group">
                  <div id={groupLabelId} className="sticky top-0 z-10 flex items-center gap-2 bg-paper/95 px-2.5 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-ink-fade backdrop-blur">
                    <span className="min-w-0 flex-1 truncate">{groupLabel}</span>
                    <span aria-hidden="true">{group.models.length}</span>
                  </div>
                  {group.models.map((model, modelIndex) => {
                    const index = group.startIndex + modelIndex
                    const selected = model.name === selectedModel
                      && (!selectedModelProviderId || model.provider === selectedModelProviderId)
                    const windowLabel = contextWindowLabel(model.contextWindow, model.contextWindowEstimated)
                    const optionReadiness = resolveModelOptionReadiness(model)
                    const readinessPresentation = READINESS_PRESENTATION[optionReadiness.kind]
                    const optionDisabled = optionReadiness.canSelect === false
                    return (
                      <button
                        key={`${group.key}:${model.name}`}
                        ref={(option) => { optionRefs.current[index] = option }}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        aria-disabled={optionDisabled}
                        disabled={optionDisabled}
                        tabIndex={!optionDisabled && selected ? 0 : -1}
                        title={t(readinessPresentation.detailKey)}
                        onClick={() => {
                          onSelect?.(model.name, model.provider || '')
                          onClose?.()
                        }}
                        className={`flex w-full items-center gap-3 rounded-control px-2.5 py-2 text-left transition-colors ${optionDisabled ? 'cursor-not-allowed bg-rose-50/40 text-ink-fade opacity-75' : selected ? 'bg-accent-soft text-accent-ink' : 'text-ink hover:bg-ink-ghost'}`}
                        data-testid="model-picker-option"
                        data-readiness-kind={optionReadiness.kind}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{model.name}</span>
                          <span className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-ink-fade">
                            {windowLabel && <span>{`${windowLabel} ${t('chat.modelPicker.context')}`}</span>}
                            <span
                              className={`rounded-full px-1.5 py-0.5 font-medium ${readinessPresentation.className}`}
                              data-testid="model-picker-readiness"
                            >
                              {t(readinessPresentation.labelKey)}
                            </span>
                          </span>
                          <span className="mt-1 block text-xs leading-snug text-ink-fade">
                            {t(readinessPresentation.detailKey)}
                          </span>
                        </span>
                        {selected && <Check className="h-4 w-4 shrink-0" aria-hidden="true" />}
                      </button>
                    )
                  })}
                </div>
              )
            })}
          </div>
          <button
            type="button"
            data-testid="model-picker-manage"
            onClick={() => {
              onClose?.()
              onManage?.()
            }}
            className="w-full border-t border-ink-fade/30 px-3 py-2.5 text-left text-xs text-ink-soft hover:bg-ink-ghost hover:text-ink"
          >
            {t('chat.modelPicker.manage')}
          </button>
        </div>
      )}
    </div>
  )
}
