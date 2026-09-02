function workspaceName(value) {
  const normalized = String(value || '').replace(/[\\/]+$/, '')
  return normalized.split(/[\\/]/).filter(Boolean).at(-1) || normalized || 'workspace'
}

export function presentSessionCatalogSource(source, mismatch = null, t = (key) => key) {
  if (!source?.backendInstanceId || !source?.workspaceScope?.path) return null
  const fingerprint = String(source.backendInstanceId).split(':').at(-1).slice(0, 8)
  const path = String(source.workspaceScope.path)
  const changed = Boolean(mismatch)
  return {
    changed,
    fingerprint,
    label: `${workspaceName(path)} · #${fingerprint}`,
    title: t(
      changed ? 'nav.historySourceChangedTitle' : 'nav.historySourceTitle',
      { source: source.backendInstanceId, workspace: path },
    ),
  }
}
