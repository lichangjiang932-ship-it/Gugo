export function resolveSlashMenuKey(key, selectedIndex, itemCount) {
  const count = Math.max(0, Number(itemCount) || 0)
  const safeIndex = count > 0
    ? Math.min(Math.max(0, Number(selectedIndex) || 0), count - 1)
    : 0

  if (key === 'ArrowDown') {
    return { handled: true, selectedIndex: count ? (safeIndex + 1) % count : 0 }
  }
  if (key === 'ArrowUp') {
    return { handled: true, selectedIndex: count ? (safeIndex - 1 + count) % count : 0 }
  }
  if ((key === 'Enter' || key === 'Tab') && count > 0) {
    return { handled: true, selectIndex: safeIndex, dismiss: true }
  }
  if (key === 'Escape') {
    return { handled: true, dismiss: true }
  }
  return { handled: false }
}
