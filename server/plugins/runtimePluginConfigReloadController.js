import { snapshotRuntimePlugin } from './runtimePluginInventory.js'
import {
  configReloadError,
  normalizeConfigReloadFailure,
  stableConfigReloadErrorCode,
} from './runtimePluginConfigReloadErrors.js'

function trimmedString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

export function createRuntimePluginConfigReloadController({
  activeCallbackInvocation,
  activateManagedContributions,
  assertManifestCompatible,
  assertRecordCanDeactivate,
  beginManagedContributionDeactivation,
  collectManagedDeactivationErrors,
  configReloads,
  createContextForRecord,
  createPluginRecord,
  disposePluginEffects,
  emitConfigReloadAudit,
  getActivePluginConfigResolver,
  invokePluginCallback,
  invokePluginSetup,
  isShuttingDown,
  plugins,
  retireManagedContributions,
  revokeVisibleEffects,
  setActivePluginConfigResolver,
  stagingRecords,
  waitForCallbacksToDrain,
}) {
  const runConfigHealthChecks = async (record) => {
    for (const check of [...record.configHealthChecks]) {
      let result
      try {
        result = await invokePluginCallback(record, 'config-health-check', check, [])
      } catch {
        throw configReloadError(
          'PLUGIN_CONFIG_HEALTH_CHECK_FAILED',
          'runtime plugin configuration health check failed',
          422,
        )
      }
      if (result === false) {
        throw configReloadError(
          'PLUGIN_CONFIG_HEALTH_CHECK_FAILED',
          'runtime plugin configuration health check failed',
          422,
        )
      }
    }
  }

  const discardStagedRecord = async (record) => {
    record.state = 'failed'
    await revokeVisibleEffects(record)
    const errors = [...record.revocationErrors]
    record.revocationErrors.length = 0

    // A candidate that may still be visible must retain both its lifecycle
    // receipts and effect tracker so shutdown can retry the exact generation.
    if (errors.length > 0 || record.managedContributions.length > 0) {
      record.state = 'candidate_cleanup_failed'
      return { errors, removed: false }
    }

    const effectErrors = await disposePluginEffects(record)
    if (effectErrors.length > 0) {
      record.state = 'candidate_cleanup_failed'
      return { errors: effectErrors, removed: false }
    }
    stagingRecords.delete(record)
    return { errors: [], removed: true }
  }

  const reloadPluginConfig = (id, {
    expectedRevision,
    configLayerSources,
    verifyBeforeCommit = null,
  } = {}) => {
    const pluginId = trimmedString(id)
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
      return Promise.reject(configReloadError(
        'PLUGIN_CONFIG_REVISION_INVALID',
        'expectedRevision must be a positive safe integer',
        400,
      ))
    }
    if (verifyBeforeCommit !== null && typeof verifyBeforeCommit !== 'function') {
      return Promise.reject(configReloadError(
        'PLUGIN_CONFIG_SOURCE_VERIFIER_INVALID',
        'runtime plugin configuration source verifier must be a function',
        400,
      ))
    }
    const invocation = activeCallbackInvocation()
    if (invocation?.record?.manifest?.id === pluginId) {
      return Promise.reject(configReloadError(
        'PLUGIN_CONFIG_RELOAD_CALLBACK_DEADLOCK',
        'plugin callback cannot reload its own configuration before returning',
        409,
      ))
    }

    const operation = async () => {
      const oldRecord = plugins.get(pluginId)
      if (!oldRecord) {
        throw configReloadError('PLUGIN_NOT_FOUND', 'runtime plugin was not found', 404)
      }
      if (oldRecord.state !== 'active') {
        throw configReloadError(
          'PLUGIN_CONFIG_RELOAD_NOT_ACTIVE',
          'runtime plugin is not active',
          409,
          true,
        )
      }
      if (oldRecord.configRevision !== expectedRevision) {
        throw configReloadError(
          'PLUGIN_CONFIG_REVISION_CONFLICT',
          'runtime plugin configuration revision changed',
          409,
          true,
        )
      }
      assertRecordCanDeactivate(oldRecord)

      const nextRevision = expectedRevision + 1
      emitConfigReloadAudit('plugin.config_reload_started', {
        pluginId,
        fromRevision: expectedRevision,
        toRevision: nextRevision,
      })
      let candidate = null
      try {
        const nextResolver = getActivePluginConfigResolver().withLayerSources(configLayerSources)
        const configResolution = nextResolver.resolve(pluginId, oldRecord.manifest.configSchema)
        candidate = createPluginRecord({
          manifest: oldRecord.manifest,
          setup: oldRecord.setup,
          configResolver: nextResolver,
          configResolution,
          configRevision: nextRevision,
          state: 'staging',
          deferVisibility: true,
          durableIdentity: oldRecord.durableIdentity,
          durableOwnerUserId: oldRecord.durableOwnerUserId,
          installedAt: oldRecord.installedAt,
        })
        stagingRecords.add(candidate)
        try {
          await invokePluginSetup(candidate, candidate.setup, createContextForRecord(candidate))
        } catch {
          throw configReloadError(
            'PLUGIN_CONFIG_SETUP_FAILED',
            'runtime plugin setup rejected the new configuration',
            422,
          )
        }
        assertManifestCompatible(candidate.manifest)
        await runConfigHealthChecks(candidate)

        if (isShuttingDown()) {
          throw configReloadError(
            'PLUGIN_REGISTRY_SHUTTING_DOWN',
            'runtime plugin registry is shutting down',
            409,
            true,
          )
        }
        if (verifyBeforeCommit) await verifyBeforeCommit()
        if (isShuttingDown()
          || plugins.get(pluginId) !== oldRecord
          || oldRecord.state !== 'active'
          || oldRecord.configRevision !== expectedRevision) {
          throw configReloadError(
            'PLUGIN_CONFIG_REVISION_CONFLICT',
            'runtime plugin configuration revision changed',
            409,
            true,
          )
        }
        // Setup, health checks, and source verification may all yield. Re-check
        // the live deactivation guard in the final synchronous commit window so
        // a loop/capability that became busy cannot be revoked by stale evidence.
        assertRecordCanDeactivate(oldRecord)

        oldRecord.state = 'draining'
        const oldDeactivation = beginManagedContributionDeactivation(oldRecord)
        // A disposer promise is part of the visibility cutover contract. Do not
        // publish the candidate until every old contribution confirms removal;
        // rejection leaves its contribution active and fails closed.
        const cutoverCleanupErrors = await collectManagedDeactivationErrors(oldDeactivation)
        let activationFailure = cutoverCleanupErrors[0] || null
        let restoreFailure = null
        if (!activationFailure) {
          candidate.state = 'active'
          try {
            await activateManagedContributions(candidate)
          } catch (error) {
            activationFailure = error
          }
        } else {
          activationFailure = oldDeactivation.errors[0]
        }

        if (activationFailure) {
          candidate.state = 'failed'
          oldRecord.state = 'restoring'
          try {
            await activateManagedContributions(oldRecord)
            oldRecord.state = 'active'
          } catch (error) {
            restoreFailure = error
            oldRecord.state = 'visibility_indeterminate'
          }
        } else {
          const retirementErrors = retireManagedContributions(oldDeactivation)
          if (retirementErrors.length > 0) {
            activationFailure = retirementErrors[0]
          }
        }

        if (!activationFailure) {
          candidate.deferVisibility = false
          plugins.set(pluginId, candidate)
          stagingRecords.delete(candidate)
          setActivePluginConfigResolver(candidate.configResolver)
        }

        if (activationFailure) {
          const activationRollbackErrors = activationFailure?.managedRollbackErrors || []
          const restoreRollbackErrors = restoreFailure?.managedRollbackErrors || []
          const candidateCleanup = await discardStagedRecord(candidate)
          if (!candidateCleanup.removed) {
            emitConfigReloadAudit('plugin.config_reload_candidate_cleanup_failed', {
              pluginId,
              fromRevision: expectedRevision,
              toRevision: nextRevision,
              code: 'PLUGIN_CONFIG_CANDIDATE_CLEANUP_FAILED',
            })
          }
          const rollbackErrors = [
            ...cutoverCleanupErrors,
            ...activationRollbackErrors,
            ...restoreRollbackErrors,
            ...(restoreFailure ? [restoreFailure] : []),
            ...candidateCleanup.errors,
          ]
          candidate = null
          if (rollbackErrors.length > 0) {
            throw configReloadError(
              'PLUGIN_CONFIG_ROLLBACK_FAILED',
              'runtime plugin configuration activation rollback failed',
              500,
            )
          }
          throw configReloadError(
            'PLUGIN_CONFIG_ACTIVATION_FAILED',
            'runtime plugin configuration activation failed',
            500,
          )
        }
        emitConfigReloadAudit('plugin.config_reload_committed', {
          pluginId,
          fromRevision: expectedRevision,
          toRevision: nextRevision,
        })

        await waitForCallbacksToDrain(oldRecord)
        oldRecord.state = 'uninstalling'
        const cleanupErrors = [
          ...oldRecord.revocationErrors,
          ...await disposePluginEffects(oldRecord),
        ]
        oldRecord.revocationErrors.length = 0
        if (cleanupErrors.length > 0) {
          emitConfigReloadAudit('plugin.config_reload_old_instance_cleanup_failed', {
            pluginId,
            fromRevision: expectedRevision,
            toRevision: nextRevision,
            code: 'PLUGIN_CONFIG_OLD_INSTANCE_CLEANUP_FAILED',
          })
        }
        return snapshotRuntimePlugin(candidate)
      } catch (caught) {
        if (candidate && stagingRecords.has(candidate)) {
          const candidateCleanup = await discardStagedRecord(candidate)
          if (!candidateCleanup.removed) {
            emitConfigReloadAudit('plugin.config_reload_candidate_cleanup_failed', {
              pluginId,
              fromRevision: expectedRevision,
              toRevision: nextRevision,
              code: 'PLUGIN_CONFIG_CANDIDATE_CLEANUP_FAILED',
            })
          }
        }
        // Candidate cleanup must not depend on reading properties from an
        // untrusted plugin/host error (which may be a hostile Proxy/getter).
        const error = normalizeConfigReloadFailure(caught)
        emitConfigReloadAudit('plugin.config_reload_failed', {
          pluginId,
          fromRevision: expectedRevision,
          toRevision: nextRevision,
          code: stableConfigReloadErrorCode(error),
        })
        throw error
      }
    }

    const entry = { pluginId, promise: null }
    entry.promise = Promise.resolve().then(operation).finally(() => configReloads.delete(entry))
    configReloads.add(entry)
    return entry.promise
  }

  return Object.freeze({ discardStagedRecord, reloadPluginConfig })
}
