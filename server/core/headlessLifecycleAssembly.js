import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { closeDb } from '../db.js'
import {
  initPlugins,
  initializeRuntimePluginConfig,
  shutdownRuntimePlugins,
} from '../plugins/pluginRegistry.js'
import { restoreEnabledRuntimePlugins } from '../services/runtimePluginControlService.js'
import { seedSystemSkills } from '../services/seedSystemSkills.js'
import { recoverPendingSessionDeletion } from '../services/sessionDeletionGovernanceRuntime.js'
import {
  closeSessionContentMaterializerRuntime,
  startSessionContentMaterializerRuntime,
} from '../services/sessionContentMaterializerRuntime.js'
import { closeTurnEngine } from '../services/turnEngineHost.js'
import { logger } from '../utils/logger.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_PLUGIN_ROOT = path.resolve(__dirname, '../../plugins')

export const HEADLESS_LIFECYCLE_CAPABILITY_IDS = Object.freeze({
  database: 'headless.resource.database',
  managedAttachments: 'headless.resource.managed-attachments',
  compactionArchive: 'headless.resource.compaction-archive',
  sessionDeletionRecovery: 'headless.startup.session-deletion-recovery',
  sessionContentMaterializer: 'headless.resource.session-content-materializer',
  systemSkills: 'headless.startup.system-skills',
  runtimePluginConfig: 'headless.startup.runtime-plugin-config',
  pluginDiscovery: 'headless.startup.plugin-discovery',
  runtimePlugins: 'headless.resource.runtime-plugins',
  turnEngine: 'headless.resource.turn-engine',
})

const DEFAULT_ADAPTERS = Object.freeze({
  closeDb,
  recoverPendingSessionDeletion,
  startSessionContentMaterializerRuntime,
  closeSessionContentMaterializerRuntime,
  seedSystemSkills,
  initializeRuntimePluginConfig,
  initPlugins,
  restoreEnabledRuntimePlugins,
  shutdownRuntimePlugins,
  closeTurnEngine,
  warn: (message) => logger.warn(message),
})

function definition(id, dependsOn, hooks = {}) {
  return Object.freeze({
    id,
    owner: 'headless',
    priority: 0,
    dependsOn: Object.freeze(dependsOn ? [dependsOn] : []),
    startTimeoutMs: hooks.startTimeoutMs || 10_000,
    stopTimeoutMs: hooks.stopTimeoutMs || 10_000,
    startFailure: hooks.startFailure || 'ignore',
    stopFailure: hooks.stopFailure || 'ignore',
    dependencyFailure: hooks.dependencyFailure || 'skip',
    errorLabel: hooks.errorLabel || id,
    ...(hooks.start ? { start: hooks.start } : {}),
    ...(hooks.stop ? { stop: hooks.stop } : {}),
  })
}

async function restoreRuntimePlugins(adapters, runtimeEnv) {
  const results = await adapters.restoreEnabledRuntimePlugins({ env: runtimeEnv })
  for (const result of results || []) {
    if (!result?.ok) {
      adapters.warn(
        `[plugins] runtime restore failed for ${result?.pluginId}: ${result?.error?.message || result?.error}`,
      )
    }
  }
  return results
}

/**
 * Minimal process profile for one CLI turn. It deliberately excludes network
 * listeners, cron, social bridges, browser pools, global Turn recovery, jobs,
 * and evolution sweepers while retaining the local durability/plugin path.
 */
export function createHeadlessLifecycleCapabilities({
  adapters: adapterOverrides = {},
  managedAttachmentRuntimeController,
  compactionArchiveController,
  cwd = process.cwd(),
  pluginRoot = DEFAULT_PLUGIN_ROOT,
  runtimeEnv = process.env,
  silent = true,
} = {}) {
  const adapters = Object.freeze({ ...DEFAULT_ADAPTERS, ...adapterOverrides })
  if (
    typeof managedAttachmentRuntimeController?.activate !== 'function'
    || typeof managedAttachmentRuntimeController?.release !== 'function'
  ) {
    throw new TypeError(
      'managedAttachmentRuntimeController must expose activate() and release()',
    )
  }
  if (
    typeof compactionArchiveController?.activate !== 'function'
    || typeof compactionArchiveController?.release !== 'function'
  ) {
    throw new TypeError('compactionArchiveController must expose activate() and release()')
  }
  const ids = HEADLESS_LIFECYCLE_CAPABILITY_IDS
  return Object.freeze([
    definition(ids.database, null, {
      stop: () => adapters.closeDb(),
      stopFailure: 'fail',
      errorLabel: 'headless database close',
    }),
    definition(ids.managedAttachments, ids.database, {
      start: () => managedAttachmentRuntimeController.activate(),
      startFailure: 'fail',
      stop: () => managedAttachmentRuntimeController.release(),
      stopFailure: 'fail',
      errorLabel: 'headless managed attachment runtime port lifecycle',
    }),
    definition(ids.compactionArchive, ids.managedAttachments, {
      start: () => compactionArchiveController.activate(),
      startFailure: 'fail',
      stop: () => compactionArchiveController.release(),
      stopFailure: 'fail',
      errorLabel: 'headless compaction archive port lifecycle',
    }),
    definition(ids.sessionDeletionRecovery, ids.compactionArchive, {
      start: () => adapters.recoverPendingSessionDeletion(),
      startFailure: 'fail',
      errorLabel: 'headless pending session deletion recovery',
    }),
    definition(ids.sessionContentMaterializer, ids.sessionDeletionRecovery, {
      start: () => adapters.startSessionContentMaterializerRuntime({ env: runtimeEnv, cwd }),
      startFailure: 'fail',
      stop: () => adapters.closeSessionContentMaterializerRuntime(),
      stopFailure: 'fail',
      errorLabel: 'headless session content materializer lifecycle',
    }),
    definition(ids.systemSkills, ids.sessionContentMaterializer, {
      start: () => adapters.seedSystemSkills({ silent }),
      startFailure: 'fail',
      errorLabel: 'headless system skill seeding',
    }),
    definition(ids.runtimePluginConfig, ids.systemSkills, {
      start: () => adapters.initializeRuntimePluginConfig({ cwd, env: runtimeEnv }),
      startFailure: 'fail',
      errorLabel: 'headless runtime plugin config initialization',
    }),
    definition(ids.pluginDiscovery, ids.runtimePluginConfig, {
      start: () => adapters.initPlugins({
        rootDir: pluginRoot,
        silent,
        includeManaged: true,
        cwd,
        env: runtimeEnv,
      }),
      startFailure: 'fail',
      errorLabel: 'headless plugin discovery',
    }),
    definition(ids.runtimePlugins, ids.pluginDiscovery, {
      start: () => restoreRuntimePlugins(adapters, runtimeEnv),
      startFailure: 'fail',
      stop: () => adapters.shutdownRuntimePlugins(),
      stopFailure: 'fail',
      errorLabel: 'headless runtime plugin lifecycle',
    }),
    definition(ids.turnEngine, ids.runtimePlugins, {
      stop: () => adapters.closeTurnEngine(),
      stopFailure: 'fail',
      errorLabel: 'headless turn engine shutdown',
    }),
  ])
}
