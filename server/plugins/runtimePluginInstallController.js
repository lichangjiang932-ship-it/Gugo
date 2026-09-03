export function createRuntimePluginInstallController({
  activateManagedContributions,
  assertManifestCompatible,
  createContextForRecord,
  createPluginRecord,
  disposePluginEffects,
  emitAudit,
  getActivePluginConfigResolver,
  getPlugin,
  hasPlugin,
  invokePluginSetup,
  isShuttingDown,
  normalizeManifest,
  publishPlugin,
  removePlugin,
  revokeVisibleEffects,
  sealConfigLayerSources,
  snapshotPlugin,
  snapshotDurableIdentity,
}) {
  const registerPlugin = async (
    manifest,
    setup,
    durableIdentity = null,
    { ownerUserId = null, resetDurableAgentEventSubscriptions = false } = {},
  ) => {
    if (isShuttingDown()) {
      const error = new Error('runtime plugin registry is shutting down')
      error.code = 'PLUGIN_REGISTRY_SHUTTING_DOWN'
      throw error
    }
    const normalized = normalizeManifest(manifest)
    const trustedDurableIdentity = snapshotDurableIdentity(durableIdentity)
    if (trustedDurableIdentity
      && (trustedDurableIdentity.pluginId !== normalized.id
        || trustedDurableIdentity.pluginVersion !== normalized.version)) {
      const error = new TypeError('runtime plugin durable identity does not match the manifest')
      error.code = 'PLUGIN_RELEASE_IDENTITY_MISMATCH'
      error.retryable = false
      throw error
    }
    if (typeof setup !== 'function') throw new TypeError('plugin setup must be a function')
    const durableOwnerUserId = typeof ownerUserId === 'string' ? ownerUserId.trim() : ''
    if (ownerUserId !== null && !durableOwnerUserId) {
      throw new TypeError('ownerUserId must be a non-empty string or null')
    }
    if (typeof resetDurableAgentEventSubscriptions !== 'boolean') {
      throw new TypeError('resetDurableAgentEventSubscriptions must be a boolean')
    }
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
      durableIdentity: trustedDurableIdentity,
      durableOwnerUserId: durableOwnerUserId || null,
      resetDurableAgentEventSubscriptions,
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
        if (getPlugin(normalized.id) === record) removePlugin(normalized.id)
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
