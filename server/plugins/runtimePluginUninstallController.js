export function createRuntimePluginUninstallController({
  assertNoDependents,
  assertRecordCanDeactivate,
  disposePluginEffects,
  emitAudit,
  getPlugin,
  hasPlugin,
  listPendingReloads,
  removePlugin,
  revokeVisibleEffects,
  waitForCallbacksToDrain,
}) {
  const unregisterPluginUnchecked = async (normalizedId) => {
    let record = getPlugin(normalizedId)
    if (!record) return false
    const pendingReloads = listPendingReloads(normalizedId)
    if (pendingReloads.length > 0) {
      await Promise.allSettled(pendingReloads)
      const current = getPlugin(normalizedId)
      if (!current) return true
      if (current !== record) return unregisterPluginUnchecked(normalizedId)
      record = current
    }
    if (record.state === 'cancelling') {
      await record.cancelPromise
      return !hasPlugin(normalizedId)
    }
    if (record.state === 'installing') {
      record.cancelRequested = true
      record.state = 'cancelling'
      record.cancelPromise = (async () => {
        await revokeVisibleEffects(record)
        await record.installSettled
      })()
      await record.cancelPromise
      return !hasPlugin(normalizedId)
    }
    if (record.state === 'failed') {
      await record.installSettled
      return !hasPlugin(normalizedId)
    }
    if (record.state === 'uninstalling' && record.uninstallPromise) return record.uninstallPromise
    assertNoDependents(record, normalizedId)
    assertRecordCanDeactivate(record)
    record.state = 'uninstalling'
    emitAudit('plugin.uninstalling', { pluginId: normalizedId })
    record.uninstallPromise = (async () => {
      await revokeVisibleEffects(record)
      if (record.revocationErrors.length > 0 || record.managedContributions.length > 0) {
        const errors = [...record.revocationErrors]
        record.revocationErrors.length = 0
        const states = record.managedContributions.map((contribution) => contribution.snapshot().state)
        record.state = states.every((state) => state === 'revoked')
          ? 'inactive_cleanup_failed'
          : 'visibility_indeterminate'
        const failure = errors.length > 0
          ? new AggregateError(errors, `plugin uninstall failed: ${normalizedId}`)
          : new Error(`plugin uninstall visibility was not fully revoked: ${normalizedId}`)
        failure.code = 'PLUGIN_UNINSTALL_INCOMPLETE'
        failure.retryable = true
        emitAudit('plugin.uninstall_failed', {
          pluginId: normalizedId,
          state: record.state,
          errors: errors.map((item) => item?.message || String(item)),
        })
        throw failure
      }
      await waitForCallbacksToDrain(record)
      const errors = await disposePluginEffects(record)
      record.revocationErrors.length = 0
      if (errors.length > 0) {
        record.state = 'inactive_cleanup_failed'
        emitAudit('plugin.uninstall_failed', {
          pluginId: normalizedId,
          state: record.state,
          errors: errors.map((item) => item?.message || String(item)),
        })
        throw new AggregateError(errors, `plugin uninstall failed: ${normalizedId}`)
      }
      if (getPlugin(normalizedId) === record) removePlugin(normalizedId)
      emitAudit('plugin.uninstalled', { pluginId: normalizedId, errors: [] })
      return true
    })().finally(() => {
      if (getPlugin(normalizedId) === record) record.uninstallPromise = null
    })
    return record.uninstallPromise
  }

  return Object.freeze({ unregisterPluginUnchecked })
}
