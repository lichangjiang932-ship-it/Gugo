export function createRuntimePluginInstallController({
  activateManagedContributions,
  assertManifestCompatible,
  createContextForRecord,
  createPluginRecord,
  disposePluginEffects,
  emitAudit,
  getActivePluginConfigResolver,
  hasPlugin,
  invokePluginSetup,
  isShuttingDown,
  normalizeManifest,
  publishPlugin,
  removePlugin,
  revokeVisibleEffects,
  sealConfigLayerSources,
  snapshotPlugin,
}) {
  const registerPlugin = async (manifest, setup) => {
    if (isShuttingDown()) {
      const error = new Error('runtime plugin registry is shutting down')
      error.code = 'PLUGIN_REGISTRY_SHUTTING_DOWN'
      throw error
    }
    const normalized = normalizeManifest(manifest)
    if (typeof setup !== 'function') throw new TypeError('plugin setup must be a function')
    if (hasPlugin(normalized.id)) throw new Error(`plugin already registered: ${normalized.id}`)
    assertManifestCompatible(normalized)
    sealConfigLayerSources()
    const configResolver = getActivePluginConfigResolver()
    const configResolution = configResolver.resolve(normalized.id, normalized.configSchema)

    const record = createPluginRecord({
      manifest: normalized,
      setup,
      configResolver,
      configResolution,
      configRevision: 1,
      state: 'installing',
      deferVisibility: false,
    })
    record.installSettled = new Promise((resolve) => {
      record.resolveInstallSettled = resolve
    })
    publishPlugin(normalized.id, record)
    emitAudit('plugin.installing', { pluginId: normalized.id, version: normalized.version })

    const context = createContextForRecord(record)

    try {
      await invokePluginSetup(record, setup, context)
      if (record.cancelRequested) {
        const cancelled = new Error(`plugin install cancelled: ${normalized.id}`)
        cancelled.code = 'PLUGIN_INSTALL_CANCELLED'
        throw cancelled
      }
      assertManifestCompatible(normalized)
      record.state = 'active'
      await activateManagedContributions(record)
      record.installedAt = new Date().toISOString()
      emitAudit('plugin.installed', { pluginId: normalized.id, version: normalized.version })
      return snapshotPlugin(record)
    } catch (error) {
      record.state = 'failed'
      await revokeVisibleEffects(record)
      const rollbackErrors = [...record.revocationErrors]
      if (record.managedContributions.length === 0) {
        rollbackErrors.push(...await disposePluginEffects(record))
      }
      record.revocationErrors.length = 0
      if (rollbackErrors.length === 0 && record.managedContributions.length === 0) {
        removePlugin(normalized.id)
      } else {
        record.state = 'rollback_failed'
      }
      emitAudit('plugin.install_failed', {
        pluginId: normalized.id,
        error: error?.message || String(error),
        rollbackErrors: rollbackErrors.map((item) => item?.message || String(item)),
      })
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          `plugin setup failed: ${normalized.id}`,
          { cause: error },
        )
      }
      throw error
    } finally {
      record.resolveInstallSettled()
    }
  }

  return Object.freeze({ registerPlugin })
}
