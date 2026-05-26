export function getSlashAutocompleteQuery(value) {
  const text = String(value || '')
  if (!text.startsWith('/')) return null
  const body = text.slice(1)
  if (/\s/.test(body)) return null
  return body
}

export function getSlashAutocompleteItems({ value, registry } = {}) {
  const query = getSlashAutocompleteQuery(value)
  if (query === null || !registry?.listCommands) return []
  return registry.listCommands({ query })
}

export function clampSlashIndex(index, length) {
  if (length <= 0) return 0
  return ((index % length) + length) % length
}

export function handleSlashAutocompleteKeyDown(event, {
  items = [],
  selectedIndex = 0,
  setSelectedIndex,
  onPick,
  onDismiss,
  onComplete,
} = {}) {
  if (!items.length) return false
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    setSelectedIndex?.(clampSlashIndex(selectedIndex + 1, items.length))
    return true
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault()
    setSelectedIndex?.(clampSlashIndex(selectedIndex - 1, items.length))
    return true
  }
  if (event.key === 'Enter') {
    event.preventDefault()
    onPick?.(items[clampSlashIndex(selectedIndex, items.length)])
    return true
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    onDismiss?.()
    return true
  }
  if (event.key === 'Tab') {
    event.preventDefault()
    const item = items[clampSlashIndex(selectedIndex, items.length)]
    onComplete?.(item)
    return true
  }
  return false
}

