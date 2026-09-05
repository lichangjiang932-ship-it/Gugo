import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { shutdownBrowsers } from '../adapters/browserAutomation.js'
import { initCodexPluginSkills } from '../adapters/codexPluginSkills.js'
import { setVisionAssistResolver } from '../adapters/visionAssist.js'
import { closeDb } from '../db.js'
import { shutdownAll as shutdownMcpAll } from '../mcp/mcpManager.js'
import {
  initPlugins,
  initializeRuntimePluginConfig,
  shutdownRuntimePlugins,
} from '../plugins/pluginRegistry.js'
import { registerBrowserTools } from '../services/browserTools.js'
import { closeCronScheduler, getCronScheduler } from '../services/cronScheduler.js'
import { registerConnectorTools } from '../services/connectorTools.js'
import {
  closeAgentEventDurableConsumerRuntime,
  startAgentEventDurableConsumerRuntime,
} from '../services/agentEventDurableConsumerRuntime.js'
import { createSqliteFileCompactionArchiveAdapter } from '../services/sqliteFileCompactionArchiveAdapter.js'
import { createSqliteFileManagedAttachmentRuntimeAdapter } from '../adapters/sqliteFileManagedAttachmentRuntimeAdapter.js'
import { getEnabledIntegrationCredentials, listEnabledIntegrationCredentials } from '../services/integrationsStore.js'
import { closeJobRuntime, getJobRuntime } from '../services/jobRuntime.js'
import {
  closeEvolutionOnlineGraderRuntime,
  startEvolutionOnlineGraderRuntime,
} from '../services/evolutionOnlineGraderRuntime.js'
import {
  closeEvolutionAutoLoopRuntime,
  startEvolutionAutoLoopRuntime,
} from '../services/evolutionAutoLoopRuntime.js'
import {
  closeEvolutionOperationSweeperRuntime,
  startEvolutionOperationSweeperRuntime,
} from '../services/evolutionOperationSweeperRuntime.js'
import { restoreEnabledRuntimePlugins } from '../services/runtimePluginControlService.js'
import { seedSystemSkills } from '../services/seedSystemSkills.js'
import { recoverPendingSessionDeletion } from '../services/sessionDeletionGovernanceRuntime.js'
import { closeAllShellSessions } from '../services/shellSessionStore.js'
import {
  closeSessionContentMaterializerRuntime,
  startSessionContentMaterializerRuntime,
} from '../services/sessionContentMaterializerRuntime.js'
import { socialBridgeManager } from '../services/socialBridgeManager.js'
import { recoverInterruptedSubagentRuns } from '../services/subagentRuntime.js'
import {
  closeCodexAppServerRuntime,
  startCodexAppServerRuntime,
} from '../services/codexAppServerRuntime.js'
import { closeLspRuntime, startLspRuntime } from '../services/lspRuntime.js'
import { resolveAgentModelRuntimeBinding } from '../services/modelReadinessService.js'
import { configureSubagentModelBindingResolver } from '../services/subagentModelBindingRuntime.js'
import { closeTurnEngine } from '../services/turnEngineHost.js'
import { closeTurnRecoveryRuntime, startTurnRecoveryRuntime } from '../services/turnRecoveryRuntime.js'
import { warnShellTrust } from '../utils/bashGuard.js'
import { logger } from '../utils/logger.js'
import { createToolLoopAdapterController } from './toolLoopAdapter.js'
import { createTurnPersistenceAdapterController } from './turnPersistenceAdapter.js'
import { createCompactionArchivePortController } from './compactionArchivePort.js'
import { createSubagentRunPersistencePortController } from './subagentRunPersistencePort.js'
import { createManagedAttachmentRuntimePortController } from './managedAttachmentRuntimePort.js'
import {
  createBackgroundLifecycleDefinitions,
  createIntegrationLifecycleDefinitions,
  createStorageLifecycleDefinitions,
} from './builtinLifecycleDefinitions.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_PLUGIN_ROOT = path.resolve(__dirname, '../../plugins')

export const BUILTIN_LIFECYCLE_CAPABILITY_IDS = Object.freeze({
  database: 'builtin.resource.database',
  managedAttachments: 'builtin.resource.managed-attachments',
  subagentPersistence: 'builtin.resource.subagent-persistence',
  turnPersistence: 'builtin.resource.turn-persistence',
  compactionArchive: 'builtin.resource.compaction-archive',
  sessionDeletionRecovery: 'builtin.startup.session-deletion-recovery',
  sessionContentMaterializer: 'builtin.resource.session-content-materializer',
  toolLoop: 'builtin.resource.tool-loop',
  mcp: 'builtin.resource.mcp',
  browser: 'builtin.resource.browser',
  shellTrust: 'builtin.startup.shell-trust',
  browserTools: 'builtin.startup.browser-tools',
  connectorTools: 'builtin.startup.connector-tools',
  systemSkills: 'builtin.startup.system-skills',
  pluginDiscovery: 'builtin.startup.plugin-discovery',
  runtimePluginRestore: 'builtin.startup.runtime-plugin-restore',
  codexAppServer: 'builtin.resource.codex-app-server',
  codexPluginSkills: 'builtin.startup.codex-plugin-skills',
  visionAssist: 'builtin.startup.vision-assist',
  socialBridges: 'builtin.resource.social-bridges',
  runtimePlugins: 'builtin.resource.runtime-plugins',
  agentEventConsumers: 'builtin.resource.agent-event-consumers',
  lsp: 'builtin.resource.lsp',
  shellSessions: 'builtin.resource.shell-sessions',
  jobs: 'builtin.resource.jobs',
  evolutionOperationSweeper: 'builtin.resource.evolution-operation-sweeper',
  evolutionOnlineGrader: 'builtin.resource.evolution-online-grader',
  evolutionAutoLoop: 'builtin.resource.evolution-auto-loop',
  turnEngine: 'builtin.resource.turn-engine',
  turnRecovery: 'builtin.resource.turn-recovery',
  cron: 'builtin.resource.cron',
  subagentRecovery: 'builtin.startup.subagent-recovery',
})

const DEFAULT_ADAPTERS = Object.freeze({
  closeDb,
  startSessionContentMaterializerRuntime,
  closeSessionContentMaterializerRuntime,
  shutdownMcpAll,
  shutdownBrowsers,
  warnShellTrust,
  registerBrowserTools,
  registerConnectorTools,
  createCompactionArchiveAdapter: (options) => createSqliteFileCompactionArchiveAdapter(options),
  createManagedAttachmentRuntimeAdapter: (options) => (
    createSqliteFileManagedAttachmentRuntimeAdapter(options)
  ),
  recoverPendingSessionDeletion,
  seedSystemSkills,
  initializeRuntimePluginConfig,
  initPlugins,
  restoreEnabledRuntimePlugins,
  startCodexAppServerRuntime,
  closeCodexAppServerRuntime,
  startLspRuntime,
  closeLspRuntime,
  initCodexPluginSkills,
  setVisionAssistResolver,
  getEnabledIntegrationCredentials,
  listEnabledIntegrationCredentials,
  startSocialIntegration: (integration) => socialBridgeManager.startIntegration(integration),
  stopSocialBridges: () => socialBridgeManager.stopAll(),
  shutdownRuntimePlugins,
  startAgentEventDurableConsumerRuntime,
  closeAgentEventDurableConsumerRuntime,
  closeShellSessions: closeAllShellSessions,
  closeJobRuntime,
  startEvolutionOperationSweeperRuntime,
  closeEvolutionOperationSweeperRuntime,
  startEvolutionOnlineGraderRuntime,
  closeEvolutionOnlineGraderRuntime,
  startEvolutionAutoLoopRuntime,
  closeEvolutionAutoLoopRuntime,
  closeTurnEngine,
  startTurnRecoveryRuntime,
  closeTurnRecoveryRuntime,
  closeCronScheduler,
  recoverInterruptedSubagentRuns,
  configureSubagentModelBindingResolver,
  resolveSubagentModelBinding: resolveAgentModelRuntimeBinding,
  warn: (message) => logger.warn(message),
})

export async function stopBuiltinBackgroundRuntimes({
  stopCronScheduler = closeCronScheduler,
  stopJobRuntime = closeJobRuntime,
} = {}) {
  if (typeof stopCronScheduler !== 'function' || typeof stopJobRuntime !== 'function') {
    throw new TypeError('Builtin background runtime stop adapters must be functions')
  }
  const errors = []
  try { await stopCronScheduler() } catch (error) { errors.push(error) }
  try { await stopJobRuntime() } catch (error) { errors.push(error) }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) {
    throw new AggregateError(errors, 'Builtin background runtime shutdown failed')
  }
  return true
}

/**
 * Explicit post-readiness activation for process-owned background schedulers.
 * HTTP capability registration must never call this function. The application
 * composition root invokes it only after startup has no fatal capability
 * failures and the runtime readiness gate has transitioned to ready.
 */
export async function startBuiltinBackgroundRuntimes({
  resolveJobRuntime = getJobRuntime,
  resolveCronScheduler = getCronScheduler,
  rollback = stopBuiltinBackgroundRuntimes,
} = {}) {
  if (typeof resolveJobRuntime !== 'function'
    || typeof resolveCronScheduler !== 'function'
    || typeof rollback !== 'function') {
    throw new TypeError('Builtin background runtime start adapters must be functions')
  }
  try {
    resolveJobRuntime()
    const cronScheduler = resolveCronScheduler()
    if (!cronScheduler || typeof cronScheduler.start !== 'function') {
      throw new TypeError('Cron scheduler must expose start()')
    }
    cronScheduler.start()
    return Object.freeze({ jobsStarted: true, cronStarted: true })
  } catch (startError) {
    try {
      await rollback()
    } catch (rollbackError) {
      throw new AggregateError(
        [startError, rollbackError],
        'Builtin background runtime startup and rollback failed',
        { cause: rollbackError },
      )
    }
    throw startError
  }
}

/**
 * Process-owned business assembly. The lifecycle kernel only sees normalized
 * capabilities; every concrete service dependency remains in this adapter.
 *
 * Some shutdown resources intentionally have no start hook. They are explicit
 * graph nodes so a standalone gracefulShutdown() still closes process globals,
 * and so reverse-order shutdown exactly matches the legacy server sequence.
 */
export function createBuiltinLifecycleCapabilities({
  silent = process.env.NODE_ENV === 'production',
  pluginRoot = DEFAULT_PLUGIN_ROOT,
  adapters: adapterOverrides = {},
  turnPersistenceAdapter,
  turnPersistenceController = null,
  managedAttachmentRuntimeAdapter,
  managedAttachmentRuntimeController = null,
  subagentRunPersistenceAdapter,
  subagentRunPersistenceController = null,
  compactionArchiveAdapter,
  compactionArchiveController = null,
  toolLoopAdapter,
  toolLoopController = null,
  runtimeEnv = process.env,
  cwd = process.cwd(),
} = {}) {
  const adapters = Object.freeze({ ...DEFAULT_ADAPTERS, ...adapterOverrides })
  const persistence = turnPersistenceController
    || createTurnPersistenceAdapterController(turnPersistenceAdapter)
  if (typeof persistence.activate !== 'function' || typeof persistence.release !== 'function') {
    throw new TypeError('turnPersistenceController must expose activate() and release()')
  }
  const managedAttachments = managedAttachmentRuntimeController
    || createManagedAttachmentRuntimePortController(
      managedAttachmentRuntimeAdapter
        || adapters.createManagedAttachmentRuntimeAdapter({ env: runtimeEnv }),
    )
  if (typeof managedAttachments.activate !== 'function'
    || typeof managedAttachments.release !== 'function') {
    throw new TypeError(
      'managedAttachmentRuntimeController must expose activate() and release()',
    )
  }
  const subagentPersistence = subagentRunPersistenceController
    || createSubagentRunPersistencePortController(subagentRunPersistenceAdapter)
  if (typeof subagentPersistence.activate !== 'function'
    || typeof subagentPersistence.release !== 'function') {
    throw new TypeError(
      'subagentRunPersistenceController must expose activate() and release()',
    )
  }
  const compactionArchive = compactionArchiveController
    || createCompactionArchivePortController(
      compactionArchiveAdapter || adapters.createCompactionArchiveAdapter({ env: runtimeEnv }),
    )
  if (typeof compactionArchive.activate !== 'function' || typeof compactionArchive.release !== 'function') {
    throw new TypeError('compactionArchiveController must expose activate() and release()')
  }
  const loop = toolLoopController || createToolLoopAdapterController(toolLoopAdapter)
  if (typeof loop.activate !== 'function' || typeof loop.release !== 'function') {
    throw new TypeError('toolLoopController must expose activate() and release()')
  }
  const context = {
    ids: BUILTIN_LIFECYCLE_CAPABILITY_IDS,
    adapters,
    persistence,
    managedAttachments,
    subagentPersistence,
    compactionArchive,
    loop,
    bindingState: { release: null },
    runtimeEnv,
    cwd,
    pluginRoot,
    silent,
  }
  return Object.freeze([
    ...createStorageLifecycleDefinitions(context),
    ...createIntegrationLifecycleDefinitions(context),
    ...createBackgroundLifecycleDefinitions(context),
  ])
}
