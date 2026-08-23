export function snapshotRuntimePlugin(record) {
  if (!record) return null
  return Object.freeze({
    ...record.manifest,
    requires: Object.freeze([...record.manifest.requires]),
    contributes: Object.freeze([...record.manifest.contributes]),
    state: record.state,
    installedAt: record.installedAt,
    configRevision: record.configRevision,
  })
}

export function listRuntimePluginInventory(records) {
  return Object.freeze([...records].map(snapshotRuntimePlugin))
}

export function listRuntimePluginEffectiveConfigs(records) {
  return Object.freeze([...records].map((record) => (
    Object.freeze({
      ...record.configResolver.publicSnapshot(
        record.configResolution,
        record.manifest.configSchema,
      ),
      revision: record.configRevision,
    })
  )))
}
