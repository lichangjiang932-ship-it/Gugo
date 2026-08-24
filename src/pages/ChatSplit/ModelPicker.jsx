import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { ChevronDown, RefreshCw } from 'lucide-react'
import { useT } from '../../i18n/I18nProvider.jsx'
import ModelPickerPanel from './modelPicker/ModelPickerPanel.jsx'
import { modelTriggerLabel } from './modelPicker/modelPickerState.js'
import useModelPickerView from './modelPicker/useModelPickerView.js'

function selectableOptions(listboxRef) {
  return [...(listboxRef.current?.querySelectorAll('[data-testid="model-picker-option"]:not(:disabled)') || [])]
    .filter((option) => !option.closest('[hidden]'))
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
  const modelRowRef = useRef(null)
  const listboxRef = useRef(null)
  const panelId = useId()
  const listboxId = useId()
  const [panelView, setPanelView] = useState('settings')
  const view = useModelPickerView({ modelOptions, selectedModel, selectedModelProviderId })
  const readiness = modelReadiness || {
    kind: modelOptions.length > 0 ? 'ready' : 'empty',
    canSend: modelOptions.length > 0 && !!selectedModel,
  }
  // Provider readiness describes only the current selection. Keep the complete
  // server catalog browsable so an unavailable selection never traps the user.
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
  const stateTitleKey = {
    loading: 'chat.modelPicker.loading',
    unconfigured: 'chat.modelPicker.unconfigured',
    error: 'chat.modelPicker.loadError',
    empty: 'chat.modelPicker.configuredEmpty',
  }[readiness.kind]
  const showStateManagementAction = ['unconfigured', 'error', 'empty'].includes(readiness.kind)
  const triggerModelLabel = modelTriggerLabel({
    modelOptions,
    selectedModel,
    selectedModelProviderId,
  })

  const closePicker = useCallback(() => {
    setPanelView('settings')
    onClose?.()
  }, [onClose])

  const openPicker = () => {
    setPanelView('settings')
    onOpen?.()
  }

  useEffect(() => {
    if (!open) return undefined
    const handlePointerDown = (event) => {
      if (!pickerRef.current?.contains(event.target)) closePicker()
    }
    const handleKeyDown = (event) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      closePicker()
      window.setTimeout(() => triggerRef.current?.focus(), 0)
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [closePicker, open])

  useEffect(() => {
    if (!open || typeof window === 'undefined') return undefined
    const focusTimer = window.setTimeout(() => {
      if (panelView === 'settings') {
        modelRowRef.current?.focus()
        return
      }
      const options = selectableOptions(listboxRef)
      const selectedOption = options.find((option) => (
        option.dataset.modelName === selectedModel
        && (!selectedModelProviderId || option.dataset.modelProvider === selectedModelProviderId)
      ))
      ;(selectedOption || options[0])?.focus()
    }, 0)
    return () => window.clearTimeout(focusTimer)
  }, [modelOptions, open, panelView, selectedModel, selectedModelProviderId])

  const handleTriggerKeyDown = (event) => {
    if (open || !['ArrowDown', 'ArrowUp'].includes(event.key)) return
    event.preventDefault()
    openPicker()
  }

  const handleListboxKeyDown = (event) => {
    const options = selectableOptions(listboxRef)
    if (!options.length) return
    const currentIndex = options.indexOf(document.activeElement)
    const focusOption = (nextIndex) => {
      const normalized = ((nextIndex % options.length) + options.length) % options.length
      options[normalized]?.focus()
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      focusOption(currentIndex < 0 ? 0 : currentIndex + 1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      focusOption(currentIndex < 0 ? options.length - 1 : currentIndex - 1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      focusOption(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      focusOption(options.length - 1)
    }
  }

  const handleSelectModel = (model) => {
    onSelect?.(model.name, model.provider || '')
    closePicker()
  }

  return (
    <div ref={pickerRef} className="relative flex flex-col-reverse items-end gap-1">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? closePicker() : openPicker())}
        onKeyDown={handleTriggerKeyDown}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        className={`inline-flex h-7 max-w-44 items-center gap-1 rounded-control border border-transparent px-1.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30 ${open ? 'bg-ink/[0.06] text-ink' : readiness.canSend ? 'text-ink-soft hover:bg-ink/[0.045] hover:text-ink' : 'text-danger hover:bg-danger/5'}`}
        title={triggerModelLabel || t('chat.modelPicker.open')}
        data-testid="model-picker-trigger"
      >
        {readiness.kind === 'loading' && <RefreshCw className="h-3 w-3 shrink-0 animate-spin" aria-hidden="true" />}
        <span className="truncate">{triggerModelLabel || t(triggerLabelKey || 'chat.modelPicker.selectRequired')}</span>
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-ink-fade transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <ModelPickerPanel
          catalogUnavailable={catalogUnavailable}
          closePicker={closePicker}
          handleListboxKeyDown={handleListboxKeyDown}
          listboxId={listboxId}
          listboxRef={listboxRef}
          manageLabel={t('chat.modelPicker.manage')}
          modelRowRef={modelRowRef}
          onManage={onManage}
          onOpenCatalog={() => setPanelView('catalog')}
          onRetry={onRetry}
          onSelect={handleSelectModel}
          panelId={panelId}
          panelView={panelView}
          readiness={readiness}
          selectedModel={selectedModel}
          selectedModelProviderId={selectedModelProviderId}
          showStateManagementAction={showStateManagementAction}
          stateMessageKey={stateMessageKey}
          stateTitleKey={stateTitleKey}
          t={t}
          triggerModelLabel={triggerModelLabel || t(triggerLabelKey || 'chat.modelPicker.selectRequired')}
          view={view}
        />
      )}
    </div>
  )
}
