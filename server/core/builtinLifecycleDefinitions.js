function definition(id, dependsOn, hooks = {}) {
  return Object.freeze({
    id,
    owner: 'builtin',
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

async function restoreRuntimePlugins(adapters) {
  const results = await adapters.restoreEnabledRuntimePlugins()
  for (const result of results || []) {
    if (!result?.ok) {
      adapters.warn(
        `[plugins] runtime restore failed for ${result?.pluginId}: ${result?.error?.message || result?.error}`,
      )
    }
  }
  return results
}

async function startSocialBridges(adapters) {
  const integrations = adapters.listEnabledIntegrationCredentials({ kind: 'social' })
  await Promise.all(integrations.map(async (integration) => {
    try {
      await adapters.startSocialIntegration(integration)
    } catch (error) {
      adapters.warn(`[bridge] start ${integration.provider} failed: ${error?.message || error}`)
      throw error
    }
  }))
}

export function createStorageLifecycleDefinitions({
  ids,
  adapters,
  managedAttachments,
  subagentPersistence,
  persistence,
  compactionArchive,
  runtimeEnv,
  cwd,
}) {
  return [
    definition(ids.database, null, {
      stop: () => adapters.closeDb(),
      errorLabel: 'database close',
    }),
    definition(ids.managedAttachments, ids.database, {
      start: () => managedAttachments.activate(),
      startFailure: 'fail',
      stop: () => managedAttachments.release(),
      stopFailure: 'fail',
      errorLabel: 'managed attachment runtime port lifecycle',
    }),
    definition(ids.subagentPersistence, ids.managedAttachments, {
      start: () => subagentPersistence.activate(),
      startFailure: 'fail',
      stop: () => subagentPersistence.release(),
      stopFailure: 'fail',
      errorLabel: 'subagent run persistence port lifecycle',
    }),
    definition(ids.turnPersistence, ids.subagentPersistence, {
      start: () => persistence.activate(),
      startFailure: 'fail',
      stop: () => persistence.release(),
      stopFailure: 'fail',
      errorLabel: 'turn persistence adapter lifecycle',
    }),
    definition(ids.compactionArchive, ids.turnPersistence, {
      start: () => compactionArchive.activate(),
      startFailure: 'fail',
      stop: () => compactionArchive.release(),
      stopFailure: 'fail',
      errorLabel: 'compaction archive port lifecycle',
    }),
    definition(ids.sessionDeletionRecovery, ids.compactionArchive, {
      start: () => adapters.recoverPendingSessionDeletion(),
      startFailure: 'fail',
      errorLabel: 'pending session deletion recovery',
    }),
    definition(ids.sessionContentMaterializer, ids.sessionDeletionRecovery, {
      start: () => adapters.startSessionContentMaterializerRuntime({ env: runtimeEnv, cwd }),
      startFailure: 'fail',
      stop: () => adapters.closeSessionContentMaterializerRuntime(),
      stopFailure: 'fail',
      errorLabel: 'session content materializer lifecycle',
    }),
  ]
}

export function createIntegrationLifecycleDefinitions({
  ids,
  adapters,
  loop,
  bindingState,
  runtimeEnv,
  cwd,
  pluginRoot,
  silent,
}) {
  return [
    definition(ids.lsp, ids.runtimePlugins, {
      start: () => adapters.startLspRuntime({ env: runtimeEnv }),
      stop: () => adapters.closeLspRuntime(),
      errorLabel: 'LSP runtime lifecycle',
    }),
    definition(ids.toolLoop, ids.agentEventConsumers, {
      start: () => {
        bindingState.release = adapters.configureSubagentModelBindingResolver(
          adapters.resolveSubagentModelBinding,
        )
        try {
          return loop.activate()
        } catch (error) {
          bindingState.release?.()
          bindingState.release = null
          throw error
        }
      },
      startFailure: 'fail',
      stop: () => {
        try {
          return loop.release()
        } finally {
          bindingState.release?.()
          bindingState.release = null
        }
      },
      stopFailure: 'fail',
      errorLabel: 'tool loop adapter lifecycle',
    }),
    definition(ids.mcp, ids.sessionContentMaterializer, {
      stop: () => adapters.shutdownMcpAll(),
      stopTimeoutMs: 20_000,
      errorLabel: 'MCP shutdown',
    }),
    definition(ids.browser, ids.mcp, {
      stop: () => adapters.shutdownBrowsers(),
      errorLabel: 'browser shutdown',
    }),
    definition(ids.shellTrust, ids.browser, {
      start: () => adapters.warnShellTrust(),
      errorLabel: 'shell trust warning',
    }),
    definition(ids.browserTools, ids.shellTrust, {
      start: () => adapters.registerBrowserTools(),
      errorLabel: 'browser tool registration',
    }),
    definition(ids.connectorTools, ids.browserTools, {
      start: () => adapters.registerConnectorTools(),
      errorLabel: 'connector tool registration',
    }),
    definition(ids.systemSkills, ids.connectorTools, {
      start: () => adapters.seedSystemSkills(),
      errorLabel: 'system skill seed',
    }),
    definition(ids.pluginDiscovery, ids.systemSkills, {
      start: () => {
        adapters.initializeRuntimePluginConfig({ cwd, env: runtimeEnv })
        return adapters.initPlugins({
          rootDir: pluginRoot,
          silent,
          includeManaged: true,
          cwd,
          env: runtimeEnv,
        })
      },
      startFailure: 'fail',
      errorLabel: 'plugin discovery',
    }),
    definition(ids.runtimePluginRestore, ids.pluginDiscovery, {
      start: () => restoreRuntimePlugins(adapters),
      startFailure: 'fail',
      errorLabel: 'runtime plugin restore',
    }),
    definition(ids.codexAppServer, ids.runtimePluginRestore, {
      start: ({ signal }) => adapters.startCodexAppServerRuntime({ env: runtimeEnv, cwd, signal }),
      stop: ({ signal }) => adapters.closeCodexAppServerRuntime({ signal }),
      startTimeoutMs: 65_000,
      stopTimeoutMs: 30_000,
      startFailure: 'ignore',
      stopFailure: 'ignore',
      errorLabel: 'Codex app-server lifecycle',
    }),
    definition(ids.codexPluginSkills, ids.runtimePluginRestore, {
      start: () => adapters.initCodexPluginSkills(),
      errorLabel: 'Codex plugin skill initialization',
    }),
    definition(ids.visionAssist, ids.codexPluginSkills, {
      start: () => adapters.setVisionAssistResolver((userId) => {
        if (!userId) return null
        return adapters.getEnabledIntegrationCredentials({ userId, provider: 'vision_assist' })
      }),
      errorLabel: 'vision assist resolver',
    }),
    definition(ids.socialBridges, ids.visionAssist, {
      start: () => startSocialBridges(adapters),
      stop: () => adapters.stopSocialBridges(),
      errorLabel: 'social bridge lifecycle',
    }),
    definition(ids.runtimePlugins, ids.socialBridges, {
      stop: () => adapters.shutdownRuntimePlugins(),
      stopFailure: 'fail',
      errorLabel: 'runtime plugin shutdown',
    }),
    definition(ids.agentEventConsumers, ids.runtimePlugins, {
      start: () => adapters.startAgentEventDurableConsumerRuntime(),
      startFailure: 'fail',
      stop: () => adapters.closeAgentEventDurableConsumerRuntime(),
      stopFailure: 'fail',
      errorLabel: 'durable Agent Event consumer lifecycle',
    }),
  ]
}

export function createBackgroundLifecycleDefinitions({ ids, adapters, runtimeEnv }) {
  return [
    definition(ids.evolutionOperationSweeper, ids.toolLoop, {
      start: () => adapters.startEvolutionOperationSweeperRuntime(),
      stop: () => adapters.closeEvolutionOperationSweeperRuntime(),
      errorLabel: 'evolution operation sweeper lifecycle',
    }),
    definition(ids.shellSessions, ids.evolutionOperationSweeper, {
      stop: () => adapters.closeShellSessions(),
      errorLabel: 'persistent shell session shutdown',
    }),
    definition(ids.jobs, ids.shellSessions, {
      stop: () => adapters.closeJobRuntime(),
      errorLabel: 'job runtime shutdown',
    }),
    definition(ids.evolutionOnlineGrader, ids.jobs, {
      start: () => adapters.startEvolutionOnlineGraderRuntime(),
      stop: ({ signal }) => adapters.closeEvolutionOnlineGraderRuntime({ signal }),
      stopTimeoutMs: 120_000,
      stopFailure: 'fail',
      errorLabel: 'evolution online grader lifecycle',
    }),
    definition(ids.evolutionAutoLoop, ids.evolutionOnlineGrader, {
      start: () => adapters.startEvolutionAutoLoopRuntime({ env: runtimeEnv }),
      stop: () => adapters.closeEvolutionAutoLoopRuntime(),
      stopTimeoutMs: 120_000,
      stopFailure: 'fail',
      errorLabel: 'automatic evolution loop lifecycle',
    }),
    definition(ids.turnEngine, ids.evolutionAutoLoop, {
      stop: () => adapters.closeTurnEngine(),
      stopFailure: 'fail',
      errorLabel: 'turn engine shutdown',
    }),
    definition(ids.turnRecovery, ids.turnEngine, {
      start: () => adapters.startTurnRecoveryRuntime(),
      stop: () => adapters.closeTurnRecoveryRuntime(),
      errorLabel: 'turn recovery lifecycle',
    }),
    definition(ids.cron, ids.turnRecovery, {
      stop: () => adapters.closeCronScheduler(),
      errorLabel: 'cron scheduler shutdown',
    }),
    definition(ids.subagentRecovery, ids.cron, {
      start: () => adapters.recoverInterruptedSubagentRuns(),
      startFailure: 'fail',
      errorLabel: 'subagent recovery',
    }),
  ]
}
