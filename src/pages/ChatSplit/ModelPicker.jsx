import { useEffect, useId, useMemo, useRef } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { useT } from '../../i18n/I18nProvider.jsx'
import { groupModelOptions } from './modelPickerGroups.js'

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
  selectedModel,
  onOpen,
  onClose,
  onSelect,
  onManage,
}) {
  const { t } = useT()
  const pickerRef = useRef(null)
  const triggerRef = useRef(null)
  const optionRefs = useRef([])
  const listboxId = useId()
  const modelGroups = useMemo(() => groupModelOptions(modelOptions), [modelOptions])
  const orderedModelOptions = useMemo(() => modelGroups.flatMap((group) => group.models), [modelGroups])

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
    const selectedIndex = orderedModelOptions.findIndex((model) => model.name === selectedModel)
    const focusTimer = window.setTimeout(() => {
      optionRefs.current[selectedIndex >= 0 ? selectedIndex : 0]?.focus()
    }, 0)
    return () => window.clearTimeout(focusTimer)
  }, [open, orderedModelOptions, selectedModel])

  const handleTriggerKeyDown = (event) => {
    if (open || !['ArrowDown', 'ArrowUp'].includes(event.key)) return
    event.preventDefault()
    onOpen?.()
  }

  const handleListboxKeyDown = (event) => {
    const options = optionRefs.current.filter(Boolean)
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
        className={`inline-flex h-7 max-w-56 items-center gap-1.5 rounded-pill border px-2.5 text-xs transition-colors ${open ? 'border-accent bg-accent-soft text-accent-ink' : 'border-ink-fade/60 text-ink-soft hover:border-ink-fade'}`}
        title={t('chat.modelPicker.open')}
        data-testid="model-picker-trigger"
      >
        <span className="truncate">{selectedModel || t('chat.modelPicker.backendDefault')}</span>
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
            {modelOptions.length === 0 ? (
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
                    const windowLabel = contextWindowLabel(model.contextWindow, model.contextWindowEstimated)
                    const hasMultiplier = Number.isFinite(Number(model.multiplier))
                    return (
                      <button
                        key={`${group.key}:${model.name}`}
                        ref={(option) => { optionRefs.current[index] = option }}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        tabIndex={selected ? 0 : -1}
                        onClick={() => {
                          onSelect?.(model.name)
                          onClose?.()
                        }}
                        className={`flex w-full items-center gap-3 rounded-control px-2.5 py-2 text-left transition-colors ${selected ? 'bg-accent-soft text-accent-ink' : 'text-ink hover:bg-ink-ghost'}`}
                        data-testid="model-picker-option"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{model.name}</span>
                          {(windowLabel || hasMultiplier) && (
                            <span className="mt-0.5 block text-xs text-ink-fade">
                              {windowLabel ? `${windowLabel} ${t('chat.modelPicker.context')}` : ''}
                              {windowLabel && hasMultiplier ? ' · ' : ''}
                              {hasMultiplier ? `×${model.multiplier}` : ''}
                            </span>
                          )}
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
