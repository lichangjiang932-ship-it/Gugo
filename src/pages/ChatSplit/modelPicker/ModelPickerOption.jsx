import { resolveModelOptionReadiness } from '../chatModelReadiness.js'
import { modelIdentity } from './modelPickerState.js'

export default function ModelPickerOption({
  model,
  onSelect,
  selected,
  tabStopIdentity,
}) {
  const optionReadiness = resolveModelOptionReadiness(model)
  const optionDisabled = optionReadiness.canSelect === false

  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      aria-disabled={optionDisabled}
      disabled={optionDisabled}
      tabIndex={!optionDisabled && modelIdentity(model) === tabStopIdentity ? 0 : -1}
      title={model.name}
      onClick={() => onSelect(model)}
      className={`mx-1 flex h-9 w-[calc(100%-0.5rem)] items-center rounded-[10px] px-2.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus/25 ${optionDisabled ? 'cursor-not-allowed text-ink-fade opacity-55' : selected ? 'bg-ink/[0.06] text-ink' : 'text-ink hover:bg-ink/[0.04]'}`}
      data-testid="model-picker-option"
      data-readiness-kind={optionReadiness.kind}
      data-model-name={model.name}
      data-model-provider={model.provider || ''}
    >
      <span className="min-w-0 flex-1 truncate">{model.name}</span>
    </button>
  )
}
