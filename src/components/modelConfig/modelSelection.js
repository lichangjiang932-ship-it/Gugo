export function mergeModelCandidates(current, discovered, profiles = {}) {
  const known = new Set(current.map(model => model.id))
  const kept = current.map(model => ({ ...(profiles[model.id] || {}), ...model }))
  return [...kept, ...[...new Set(discovered)].filter(id => !known.has(id)).map(id => ({ id, ...(profiles[id] || {}) }))]
}
