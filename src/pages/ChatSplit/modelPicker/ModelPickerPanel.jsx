import { ChevronRight, RefreshCw } from 'lucide-react'
import ModelPickerOption from './ModelPickerOption.jsx'

export default function ModelPickerPanel({
  catalogUnavailable,
  closePicker,
  handleListboxKeyDown,
  listboxId,
  listboxRef,
  manageLabel,
  modelRowRef,
  onManage,
  onOpenCatalog,
  onRetry,
  onSelect,
  panelId,
  panelView,
  readiness,
  selectedModel,
  selectedModelProviderId,
  showStateManagementAction,
  stateMessageKey,
  stateTitleKey,
  t,
  triggerModelLabel,
  view,
}) {
  const { displayGroups, tabStopIdentity } = view

  const manageModels = () => {
    closePicker()
    onManage?.()
  }
  return (
    <div
      id={panelId}
      role="dialog"
      aria-label={t('chat.modelPicker.title')}
      className="fixed bottom-24 right-3 z-40 flex max-h-[min(52dvh,21rem)] w-[min(19rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-[14px] border border-ink-fade/20 bg-paper shadow-xl lg:absolute lg:bottom-[calc(100%+0.5rem)] lg:left-auto lg:right-0 lg:max-h-[min(48dvh,21rem)] lg:w-[min(19rem,calc(100vw-8rem))]"
      data-testid="model-picker-panel"
      data-model-picker-view={panelView}
    >
      {catalogUnavailable ? (
        <div className="p-1.5">
          <div
            className="flex min-h-10 items-center gap-2 rounded-[10px] bg-ink/[0.04] px-2.5 py-1.5 text-xs text-ink"
            data-testid={`model-picker-state-${readiness.kind}`}
            data-model-readiness-kind={readiness.kind}
            {...(readiness.kind === 'loading' ? { role: 'status' } : { role: 'alert' })}
          >
            {readiness.kind === 'loading' && <RefreshCw className="h-3.5 w-3.5 shrink-0 animate-spin text-ink-fade" aria-hidden="true" />}
            <strong className="min-w-0 flex-1 truncate font-medium">{t(stateTitleKey || 'chat.modelPicker.empty')}</strong>
            <span className="sr-only">{t(stateMessageKey || 'chat.modelPicker.empty')}</span>
            {showStateManagementAction && (
              <button
                type="button"
                data-testid="model-picker-manage"
                onClick={manageModels}
                className="inline-flex h-7 shrink-0 items-center rounded-control px-2 font-medium text-ink-soft transition-colors hover:bg-paper hover:text-ink"
              >
                {manageLabel}
              </button>
            )}
            {(readiness.kind === 'error' || readiness.kind === 'empty') && (
              <button
                type="button"
                onClick={onRetry}
                aria-label={t('chat.modelPicker.retry')}
                title={t('chat.modelPicker.retry')}
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-control text-ink-fade transition-colors hover:bg-paper hover:text-ink"
              >
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      ) : panelView === 'settings' ? (
        <button
          ref={modelRowRef}
          type="button"
          onClick={onOpenCatalog}
          data-testid="model-picker-model-row"
          className="flex min-h-11 w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-ink/[0.035] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus/25"
        >
          <span className="shrink-0 text-sm font-medium text-ink">{t('chat.modelPicker.settingLabel')}</span>
          <span className="ml-auto min-w-0 truncate text-xs text-ink-soft">{triggerModelLabel}</span>
          <ChevronRight className="h-4 w-4 shrink-0 text-ink-fade" aria-hidden="true" />
        </button>
      ) : (
        <div
          ref={listboxRef}
          id={listboxId}
          role="listbox"
          aria-label={t('chat.modelPicker.title')}
          onKeyDown={handleListboxKeyDown}
          className="min-h-0 flex-1 overflow-y-auto py-1"
          data-testid="model-picker-catalog"
        >
          {displayGroups.map((group, groupIndex) => {
          const groupLabel = group.label || t('chat.modelPicker.defaultGroup')
          const groupLabelId = `${listboxId}-group-${groupIndex}`
          return (
            <div key={group.key} role="group" aria-labelledby={groupLabelId} data-testid="model-picker-group">
              <div
                id={groupLabelId}
                data-model-provider={group.provider || ''}
                className="sticky top-0 z-10 bg-paper/95 px-3 pb-1 pt-2 text-xs font-medium text-ink-fade backdrop-blur"
              >
                {groupLabel}
              </div>
              <div data-testid="model-picker-group-options">
                {group.models.map((model) => (
                  <ModelPickerOption
                    key={`${group.key}:${model.provider || ''}:${model.name}`}
                    model={model}
                    onSelect={onSelect}
                    selected={model.name === selectedModel
                      && (!selectedModelProviderId || model.provider === selectedModelProviderId)}
                    tabStopIdentity={tabStopIdentity}
                  />
                ))}
              </div>
            </div>
          )
        })}
        </div>
      )}
    </div>
  )
}
