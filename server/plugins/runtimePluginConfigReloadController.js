import { snapshotRuntimePlugin } from './runtimePluginInventory.js'
import {
  configReloadError,
  normalizeConfigReloadFailure,
  stableConfigReloadErrorCode,
} from './runtimePluginConfigReloadErrors.js'

function trimmedString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

async function runConfigHealthChecks(runtime, record) {
  for (const check of [...record.configHealthChecks]) {
    let result
    try {
      result = await runtime.invokePluginCallback(record, 'config-health-check', check, [])
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

async function discardStagedRecord(runtime, record) {
  record.state = 'failed'
  await runtime.revokeVisibleEffects(record)
  const errors = [...record.revocationErrors]
  record.revocationErrors.length = 0
  if (errors.length > 0 || record.managedContributions.length > 0) {
    record.state = 'candidate_cleanup_failed'
    return { errors, removed: false }
  }
  const effectErrors = await runtime.disposePluginEffects(record)
  if (effectErrors.length > 0) {
    record.state = 'candidate_cleanup_failed'
    return { errors: effectErrors, removed: false }
  }
  runtime.stagingRecords.delete(record)
  return { errors: [], removed: true }
}

function createReloadCandidate(runtime, {
  oldRecord,
  pluginId,
  nextRevision,
  configLayerSources,
}) {
  const nextResolver = runtime.getActivePluginConfigResolver().withLayerSources(configLayerSources)
  const configResolution = nextResolver.resolve(pluginId, oldRecord.manifest.configSchema)
  const candidate = runtime.createPluginRecord({
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
  runtime.stagingRecords.add(candidate)
  return candidate
}

async function validateReloadCandidate(runtime, candidate) {
  try {
    await runtime.invokePluginSetup(
      candidate,
      candidate.setup,
      runtime.createContextForRecord(candidate),
    )
  } catch {
    throw configReloadError(
      'PLUGIN_CONFIG_SETUP_FAILED',
      'runtime plugin setup rejected the new configuration',
      422,
    )
  }
  runtime.assertManifestCompatible(candidate.manifest)
  await runConfigHealthChecks(runtime, candidate)
}

async function enterReloadCommitWindow(runtime, {
  pluginId,
  oldRecord,
  expectedRevision,
  verifyBeforeCommit,
}) {
  if (runtime.isShuttingDown()) {
    throw configReloadError(
      'PLUGIN_REGISTRY_SHUTTING_DOWN',
      'runtime plugin registry is shutting down',
      409,
      true,
    )
  }
  if (verifyBeforeCommit) await verifyBeforeCommit()
  if (runtime.isShuttingDown()
    || runtime.plugins.get(pluginId) !== oldRecord
    || oldRecord.state !== 'active'
    || oldRecord.configRevision !== expectedRevision) {
    throw configReloadError(
      'PLUGIN_CONFIG_REVISION_CONFLICT',
      'runtime plugin configuration revision changed',
      409,
      true,
    )
  }
  runtime.assertRecordCanDeactivate(oldRecord)
  // Claim the old generation before this async helper returns. Keeping the
  // final CAS check and state transition in one synchronous window prevents
  // concurrent reload candidates from both committing the same revision.
  oldRecord.state = 'draining'
  return runtime.beginManagedContributionDeactivation(oldRecord)
}

async function cutoverReloadCandidate(runtime, { oldRecord, candidate, oldDeactivation }) {
  const cutoverCleanupErrors = await runtime.collectManagedDeactivationErrors(oldDeactivation)
  let activationFailure = cutoverCleanupErrors[0] || null
  let restoreFailure = null
  if (!activationFailure) {
    candidate.state = 'active'
    try {
      await runtime.activateManagedContributions(candidate)
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
      await runtime.activateManagedContributions(oldRecord)
      oldRecord.state = 'active'
    } catch (error) {
      restoreFailure = error
      oldRecord.state = 'visibility_indeterminate'
    }
  } else {
    const retirementErrors = runtime.retireManagedContributions(oldDeactivation)
    if (retirementErrors.length > 0) activationFailure = retirementErrors[0]
  }
  return { activationFailure, restoreFailure, cutoverCleanupErrors }
}

function emitCandidateCleanupFailure(runtime, { pluginId, expectedRevision, nextRevision }) {
  runtime.emitConfigReloadAudit('plugin.config_reload_candidate_cleanup_failed', {
    pluginId,
    fromRevision: expectedRevision,
    toRevision: nextRevision,
    code: 'PLUGIN_CONFIG_CANDIDATE_CLEANUP_FAILED',
  })
}

async function rejectFailedCutover(runtime, details) {
  const {
    pluginId, expectedRevision, nextRevision, candidate,
    activationFailure, restoreFailure, cutoverCleanupErrors,
  } = details
  const activationRollbackErrors = activationFailure?.managedRollbackErrors || []
  const restoreRollbackErrors = restoreFailure?.managedRollbackErrors || []
  const candidateCleanup = await discardStagedRecord(runtime, candidate)
  if (!candidateCleanup.removed) {
    emitCandidateCleanupFailure(runtime, { pluginId, expectedRevision, nextRevision })
  }
  const rollbackErrors = [
    ...cutoverCleanupErrors,
    ...activationRollbackErrors,
    ...restoreRollbackErrors,
    ...(restoreFailure ? [restoreFailure] : []),
    ...candidateCleanup.errors,
  ]
  if (rollbackErrors.length > 0) {
    return configReloadError(
      'PLUGIN_CONFIG_ROLLBACK_FAILED',
      'runtime plugin configuration activation rollback failed',
      500,
    )
  }
  return configReloadError(
    'PLUGIN_CONFIG_ACTIVATION_FAILED',
    'runtime plugin configuration activation failed',
    500,
  )
}

async function executeConfigReload(runtime, {
  pluginId,
  expectedRevision,
  configLayerSources,
  verifyBeforeCommit,
}) {
  const oldRecord = runtime.plugins.get(pluginId)
  if (!oldRecord) throw configReloadError('PLUGIN_NOT_FOUND', 'runtime plugin was not found', 404)
  if (oldRecord.state !== 'active') {
    throw configReloadError('PLUGIN_CONFIG_RELOAD_NOT_ACTIVE', 'runtime plugin is not active', 409, true)
  }
  if (oldRecord.configRevision !== expectedRevision) {
    throw configReloadError(
      'PLUGIN_CONFIG_REVISION_CONFLICT',
      'runtime plugin configuration revision changed',
      409,
      true,
    )
  }
  runtime.assertRecordCanDeactivate(oldRecord)
  const nextRevision = expectedRevision + 1
  const auditContext = { pluginId, fromRevision: expectedRevision, toRevision: nextRevision }
  runtime.emitConfigReloadAudit('plugin.config_reload_started', auditContext)
  let candidate = null
  let candidateHandled = false
  try {
    candidate = createReloadCandidate(runtime, {
      oldRecord, pluginId, nextRevision, configLayerSources,
    })
    await validateReloadCandidate(runtime, candidate)
    const oldDeactivation = await enterReloadCommitWindow(runtime, {
      pluginId, oldRecord, expectedRevision, verifyBeforeCommit,
    })
    const cutover = await cutoverReloadCandidate(runtime, {
      oldRecord,
      candidate,
      oldDeactivation,
    })
    if (cutover.activationFailure) {
      const rejection = await rejectFailedCutover(runtime, {
        ...auditContext,
        expectedRevision,
        nextRevision,
        candidate,
        ...cutover,
      })
      candidateHandled = true
      throw rejection
    }
    candidate.deferVisibility = false
    runtime.plugins.set(pluginId, candidate)
    runtime.stagingRecords.delete(candidate)
    runtime.setActivePluginConfigResolver(candidate.configResolver)
    runtime.emitConfigReloadAudit('plugin.config_reload_committed', auditContext)
    await runtime.waitForCallbacksToDrain(oldRecord)
    oldRecord.state = 'uninstalling'
    const cleanupErrors = [
      ...oldRecord.revocationErrors,
      ...await runtime.disposePluginEffects(oldRecord),
    ]
    oldRecord.revocationErrors.length = 0
    if (cleanupErrors.length > 0) {
      runtime.emitConfigReloadAudit('plugin.config_reload_old_instance_cleanup_failed', {
        ...auditContext,
        code: 'PLUGIN_CONFIG_OLD_INSTANCE_CLEANUP_FAILED',
      })
    }
    return snapshotRuntimePlugin(candidate)
  } catch (caught) {
    if (candidate && !candidateHandled && runtime.stagingRecords.has(candidate)) {
      const candidateCleanup = await discardStagedRecord(runtime, candidate)
      if (!candidateCleanup.removed) emitCandidateCleanupFailure(runtime, auditContext)
    }
    const error = normalizeConfigReloadFailure(caught)
    runtime.emitConfigReloadAudit('plugin.config_reload_failed', {
      ...auditContext,
      code: stableConfigReloadErrorCode(error),
    })
    throw error
  }
}

export function createRuntimePluginConfigReloadController(dependencies) {
  const runtime = { ...dependencies }
  const { activeCallbackInvocation, configReloads } = runtime
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
    const operation = () => executeConfigReload(runtime, {
      pluginId, expectedRevision, configLayerSources, verifyBeforeCommit,
    })
    const entry = { pluginId, promise: null }
    entry.promise = Promise.resolve().then(operation).finally(() => configReloads.delete(entry))
    configReloads.add(entry)
    return entry.promise
  }

  return Object.freeze({
    discardStagedRecord: (record) => discardStagedRecord(runtime, record),
    reloadPluginConfig,
  })
}
