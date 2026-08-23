export function assertNoRuntimePluginDependents(plugins, record, pluginId) {
  const dependents = [...plugins.values()]
    .filter((candidate) => (
      candidate !== record
      && candidate.manifest.requires.includes(pluginId)
    ))
    .map((candidate) => candidate.manifest.id)
  if (dependents.length === 0) return

  const error = new Error(`plugin is required by active plugins: ${dependents.join(', ')}`)
  error.code = 'PLUGIN_DEPENDENTS_ACTIVE'
  error.statusCode = 409
  error.retryable = false
  error.dependents = Object.freeze([...dependents])
  throw error
}
