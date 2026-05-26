import { useEffect, useMemo, useState } from 'react'
import { Command, FileText, Wand2 } from 'lucide-react'
import { useT } from '../i18n/I18nProvider.jsx'
import {
  clampSlashIndex,
  getSlashAutocompleteItems,
  handleSlashAutocompleteKeyDown,
} from './slashAutocompleteLogic.js'

function labelForSource(entry, t) {
  if (entry.kind === 'skill') return t('slash.sourceSkill')
  return entry.source === 'plugin' ? t('slash.sourcePlugin') : t('slash.sourceCore')
}

function iconForEntry(entry) {
  if (entry.source === 'plugin') return FileText
  if (entry.kind === 'skill') return Wand2
  return Command
}

export default function SlashAutocomplete({
  value,
  registry,
  visible = true,
  selectedIndex,
  setSelectedIndex,
  onPick,
  onComplete,
  onDismiss,
}) {
  const { t } = useT()
  const items = useMemo(
    () => getSlashAutocompleteItems({ value, registry }),
    [value, registry],
  )
  const [localIndex, setLocalIndex] = useState(0)
  const activeIndex = selectedIndex ?? localIndex
  const updateIndex = setSelectedIndex || setLocalIndex

  useEffect(() => {
    updateIndex(0)
  }, [value, items.length]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!visible || items.length === 0) return null

  const safeIndex = clampSlashIndex(activeIndex, items.length)

  const pickItem = (item) => {
    if (!item) return
    onPick?.(item)
  }

  return (
    <div
      className="absolute left-6 right-6 bottom-[calc(100%-0.5rem)] z-50 flex justify-center pointer-events-none"
      data-testid="slash-autocomplete-overlay"
      tabIndex={-1}
      onKeyDown={(event) => handleSlashAutocompleteKeyDown(event, {
        items,
        selectedIndex: safeIndex,
        setSelectedIndex: updateIndex,
        onPick: pickItem,
        onDismiss,
        onComplete,
      })}
    >
      <div className="w-full max-w-xl max-h-[340px] overflow-y-auto rounded-md shadow-xl border border-ink-fade/50 bg-paper p-2 pointer-events-auto">
        <div className="px-2 py-1.5 font-mono text-[10px] tracking-wide text-ink-fade uppercase">
          {t('slash.menuLabel')}
        </div>
        {items.map((item, index) => {
          const selected = index === safeIndex
          const Icon = iconForEntry(item)
          return (
            <button
              key={`${item.source}:${item.name}:${item.kind || 'command'}`}
              type="button"
              onClick={() => pickItem(item)}
              onMouseEnter={() => updateIndex(index)}
              className={
                'w-full flex items-center gap-3 px-3 py-2.5 rounded-md text-left transition-colors ' +
                (selected ? 'bg-ember-soft' : 'hover:bg-paper-2')
              }
              aria-selected={selected}
              data-testid="slash-autocomplete-item"
              data-source={item.source}
              data-name={item.name}
            >
              <Icon className="w-4 h-4 text-ink-fade shrink-0" />
              <div className="min-w-0 flex-1">
                <div className={'text-sm font-medium ' + (selected ? 'text-ember' : 'text-ink')}>
                  /{item.name}
                  {item.hint ? <span className="ml-1 text-xs font-normal text-ink-fade">{item.hint}</span> : null}
                </div>
                <div className="text-xs text-ink-fade truncate">{item.description}</div>
              </div>
              <span className="font-mono text-[10px] text-ink-fade bg-paper-2 px-1.5 py-0.5 rounded border border-ink-fade/40 shrink-0">
                {labelForSource(item, t)}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
