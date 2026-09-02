import {
  getRuntimeEnv,
  handleModelProxyRequest,
  handleModelStatusRequest,
  handleSystemDiagnosticsRequest,
} from '../adapters/modelProxy.js'
import { handleAuthAccountRequest } from '../adapters/authAccount.js'
import { handleToolProxyRequest } from '../adapters/toolProxy.js'
import { handleFsShellRequest } from '../adapters/fsShellTools.js'
import { handleGitWorkbenchRequest } from '../adapters/gitWorkbench.js'
import { handleCodeSearchRequest } from '../utils/codeSearchRoutes.js'
import { handleAgenticToolRequest } from '../utils/agenticToolsRoutes.js'
import { handleArtifactRequest } from '../routes/artifacts.js'
import { getJobRuntime } from '../services/jobRuntime.js'
import { handleJobRequest } from '../routes/jobRoutes.js'
import { handleCronRequest } from '../routes/cronRoutes.js'
import { handleSkillRequest } from '../routes/skillRoutes.js'
import { handlePluginRequest } from '../routes/pluginRoutes.js'
import { handleAgentRequest } from '../routes/agentRoutes.js'
import { handleAgentTemplateRequest } from '../routes/agentTemplateRoutes.js'
import { handleToolSpecsRequest } from '../services/toolRegistry.js'
import { handleMemoryRequest } from '../routes/memoryRoutes.js'
import { handleHooksRequest } from '../routes/hooksRoutes.js'
import { handleMcpRequest } from '../routes/mcpRoutes.js'
import { handleSubagentRequest } from '../routes/subagentRoutes.js'
import { handleCompactionRequest } from '../routes/compactionRoutes.js'
import { handleKnowledgeGraphRequest } from '../routes/knowledgeGraphRoutes.js'
import { handleReasonixRequest } from '../routes/reasonixRoutes.js'
import { handleNotificationRequest } from '../routes/notificationRoutes.js'
import { handleApprovalRequest } from '../routes/approvalRoutes.js'
import { handleSessionRequest } from '../routes/sessionRoutes.js'
import { handleChannelRequest } from '../routes/channelRoutes.js'
import { handleIntegrationsRequest } from '../routes/integrationsRoutes.js'
import { handleBridgeRequest } from '../routes/bridgeRoutes.js'
import { handleDeskRequest } from '../routes/deskRoutes.js'
import { handleMobileRequest } from '../routes/mobileRoutes.js'
import { handleToolPermissionsRequest } from '../routes/toolPermissionRoutes.js'
import { handleModelProviderRequest } from '../routes/modelProviderRoutes.js'
import { handleBrowserRequest } from '../routes/browserRoutes.js'
import { handleConnectorRequest } from '../routes/connectorRoutes.js'
import { handleLocalFileAccessRequest } from '../routes/localFileAccessRoutes.js'
import { handleFileSnapshotRequest } from '../routes/fileSnapshotRoutes.js'
import { handleTurnEventRequest } from '../routes/turnEventRoutes.js'
import { handleAuditRequest } from '../routes/auditRoutes.js'
import { handleEvolutionRequest } from '../routes/evolutionRoutes.js'
import { handleMediaRequest } from '../routes/mediaRoutes.js'
import { handleAttachmentRequest } from '../routes/attachmentRoutes.js'
import { handleWebSearchRequest } from '../routes/webSearchRoutes.js'
import { handleRuntimeConfigRequest } from '../routes/runtimeConfigRoutes.js'
import { handleSideEffectRequest } from '../routes/sideEffectRoutes.js'
import { handleCapabilityInventoryRequest } from '../routes/capabilityInventoryRoutes.js'
import { createSqliteFileManagedAttachmentStorageAdapter } from '../adapters/sqliteFileManagedAttachmentStorageAdapter.js'
import { handleMcpServerRequest } from '../mcp/mcpServer.js'
import { getRuntimeHostDiagnostics } from '../services/runtimeHostDiagnostics.js'
import { acquireCompactionArchivePort } from './compactionArchivePort.js'
import {
  assertManagedAttachmentStoragePort,
  createManagedAttachmentStoragePort,
} from './managedAttachmentStoragePort.js'
import { getActiveTurnPersistenceAdapter } from './turnPersistenceAdapter.js'

function descriptor(id, priority, apiPrefixes = []) {
  return Object.freeze({
    id,
    priority,
    apiPrefixes: Object.freeze(apiPrefixes),
  })
}

/**
 * Public, data-only route catalog. Dev/prod parity tests consume this instead
 * of scraping route strings from the HTTP lifecycle host.
 */
export const BUILTIN_HTTP_CAPABILITY_CATALOG = Object.freeze([
  descriptor('builtin.mcp.server', 10_000),
  descriptor('builtin.auth.account', 9_900, ['/api/auth', '/api/account']),
  descriptor('builtin.model.providers', 9_800, ['/api/model/providers']),
  descriptor('builtin.model.status', 9_700, ['/api/model/status']),
  descriptor('builtin.system.runtime-config', 9_600, [
    '/api/system/runtime-config',
    '/api/system/network-policy',
    '/api/system/user-data',
  ]),
  descriptor('builtin.system.diagnostics', 9_500, ['/api/system/diagnostics']),
  descriptor('builtin.model.proxy', 9_400, ['/api/model/test', '/api/model/chat']),
  descriptor('builtin.browser', 9_300, ['/api/browser']),
  descriptor('builtin.connectors', 9_200, ['/api/connectors']),
  descriptor('builtin.local-files', 9_100, ['/api/local-files']),
  descriptor('builtin.snapshots', 9_000, ['/api/snapshots']),
  descriptor('builtin.media', 8_900, ['/api/media']),
  descriptor('builtin.attachments', 8_800, ['/api/attachments']),
  descriptor('builtin.web-search', 8_700, ['/api/web-search']),
  descriptor('builtin.tools.specs', 8_600, ['/api/tools/specs']),
  descriptor('builtin.tools.fs-shell', 8_500, ['/api/tools/fs', '/api/tools/shell']),
  descriptor('builtin.tools.code', 8_400, ['/api/tools/code']),
  descriptor('builtin.tools.agent', 8_300, ['/api/tools/agent']),
  descriptor('builtin.tools.git-workbench', 8_200, ['/api/tools/git', '/api/tools/check', '/api/workbench']),
  // Must beat builtin.tools.proxy or /api/tools/mcp/call is unreachable.
  descriptor('builtin.mcp.api', 8_150, ['/api/mcp', '/api/tools/mcp']),
  descriptor('builtin.tools.proxy', 8_100, ['/api/tools']),
  descriptor('builtin.artifacts', 8_000, ['/api/artifacts']),
  descriptor('builtin.jobs', 7_900, ['/api/jobs']),
  descriptor('builtin.cron-jobs', 7_800, ['/api/cron-jobs']),
  descriptor('builtin.notifications', 7_700, ['/api/notifications']),
  descriptor('builtin.approvals', 7_600, ['/api/approvals']),
  descriptor('builtin.channels', 7_500, ['/api/channels']),
  descriptor('builtin.bridge', 7_400, ['/api/bridge']),
  descriptor('builtin.integrations', 7_300, ['/api/integrations']),
  descriptor('builtin.desk', 7_200, ['/api/desk']),
  descriptor('builtin.mobile', 7_100, ['/api/mobile']),
  descriptor('builtin.sessions', 7_000, ['/api/sessions']),
  descriptor('builtin.knowledge', 6_900, ['/api/knowledge']),
  descriptor('builtin.capabilities', 6_850, ['/api/capabilities']),
  descriptor('builtin.skills', 6_800, ['/api/skills']),
  descriptor('builtin.plugins', 6_700, ['/api/plugins']),
  descriptor('builtin.agent-templates', 6_600, ['/api/agent-templates']),
  descriptor('builtin.agents', 6_500, ['/api/agents']),
  descriptor('builtin.memory', 6_400, ['/api/memory']),
  descriptor('builtin.hooks', 6_300, ['/api/hooks']),
  descriptor('builtin.subagent', 6_100, ['/api/subagent']),
  descriptor('builtin.compaction', 6_000, ['/api/compaction']),
  descriptor('builtin.tool-permissions', 5_900, ['/api/tool-permissions']),
  descriptor('builtin.reasonix', 5_800, ['/api/reasonix']),
  descriptor('builtin.turns', 5_700, ['/api/turns']),
  descriptor('builtin.side-effects', 5_650, ['/api/side-effects']),
  descriptor('builtin.audit', 5_600, ['/api/audit']),
  descriptor('builtin.evolution', 5_500, ['/api/evolution']),
])

export const BUILTIN_HTTP_API_PREFIXES = Object.freeze([
  ...new Set(BUILTIN_HTTP_CAPABILITY_CATALOG.flatMap((entry) => entry.apiPrefixes)),
])

const CATALOG_BY_ID = new Map(BUILTIN_HTTP_CAPABILITY_CATALOG.map((entry) => [entry.id, entry]))

function capability(id, match, handle) {
  const metadata = CATALOG_BY_ID.get(id)
  if (!metadata) throw new Error(`Unknown builtin HTTP capability: ${id}`)
  return {
    ...metadata,
    owner: 'builtin',
    match,
    handle,
  }
}

function startsWithAny(req, prefixes) {
  return prefixes.some((prefix) => req.url?.startsWith(prefix))
}

function readActiveTurnSession(scope) {
  const reader = getActiveTurnPersistenceAdapter()?.session?.getSession
  if (typeof reader !== 'function') {
    throw Object.assign(
      new Error('the active Turn persistence Session Store is unavailable'),
      {
        code: 'EVOLUTION_CANARY_SESSION_STORE_UNAVAILABLE',
        statusCode: 503,
      },
    )
  }
  return reader(scope)
}

export function createBuiltinHttpCapabilities({
  getEnv = getRuntimeEnv,
  cwd = process.cwd(),
  jobRuntime = null,
  resolveJobRuntime = getJobRuntime,
  readCanarySession = readActiveTurnSession,
  readRuntimeDiagnostics = getRuntimeHostDiagnostics,
  acquireArchivePort = acquireCompactionArchivePort,
  managedAttachmentStoragePort = null,
  modelProxyRequestHandler = handleModelProxyRequest,
  compactionRequestHandler = handleCompactionRequest,
} = {}) {
  if (jobRuntime === null && typeof resolveJobRuntime !== 'function') {
    throw new TypeError('resolveJobRuntime must be a function when jobRuntime is not provided')
  }
  const jobRuntimeForRequest = jobRuntime === null
    ? () => resolveJobRuntime()
    : () => jobRuntime
  const attachmentStorage = managedAttachmentStoragePort === null
    ? createManagedAttachmentStoragePort(
        createSqliteFileManagedAttachmentStorageAdapter({ getEnv }),
      )
    : assertManagedAttachmentStoragePort(managedAttachmentStoragePort)

  const definitions = [
    capability(
      'builtin.mcp.server',
      (req) => req.url === '/mcp' || req.url?.startsWith('/mcp?'),
      (req, res) => handleMcpServerRequest(req, res),
    ),
    capability(
      'builtin.auth.account',
      (req) => startsWithAny(req, ['/api/auth/', '/api/account/']),
      (req, res) => handleAuthAccountRequest(req, res, getEnv()),
    ),
    capability(
      'builtin.model.providers',
      (req) => req.url?.startsWith('/api/model/providers'),
      (req, res) => handleModelProviderRequest(req, res),
    ),
    capability(
      'builtin.model.status',
      (req) => req.url?.startsWith('/api/model/status'),
      (req, res) => handleModelStatusRequest(req, res),
    ),
    capability(
      'builtin.system.runtime-config',
      (req) => startsWithAny(req, [
        '/api/system/runtime-config',
        '/api/system/network-policy',
        '/api/system/user-data',
      ]),
      (req, res) => handleRuntimeConfigRequest(req, res, { cwd, env: getEnv() }),
    ),
    capability(
      'builtin.system.diagnostics',
      (req) => req.url?.startsWith('/api/system/diagnostics'),
      (req, res) => handleSystemDiagnosticsRequest(req, res, { readRuntimeDiagnostics }),
    ),
    capability(
      'builtin.model.proxy',
      (req) => startsWithAny(req, ['/api/model/test', '/api/model/chat']),
      (req, res) => modelProxyRequestHandler(req, res, {
        acquireCompactionArchivePort: acquireArchivePort,
      }),
    ),
    capability(
      'builtin.browser',
      (req) => req.url?.startsWith('/api/browser/'),
      (req, res) => handleBrowserRequest(req, res),
    ),
    capability(
      'builtin.connectors',
      (req) => req.url?.startsWith('/api/connectors/'),
      (req, res) => handleConnectorRequest(req, res, { env: getEnv() }),
    ),
    capability(
      'builtin.local-files',
      (req) => req.url?.startsWith('/api/local-files'),
      (req, res) => handleLocalFileAccessRequest(req, res, { cwd, env: getEnv() }),
    ),
    capability(
      'builtin.snapshots',
      (req) => req.url?.startsWith('/api/snapshots'),
      (req, res) => handleFileSnapshotRequest(req, res),
    ),
    capability(
      'builtin.media',
      (req) => req.url?.startsWith('/api/media/'),
      (req, res) => handleMediaRequest(req, res),
    ),
    capability(
      'builtin.attachments',
      (req) => req.url?.startsWith('/api/attachments'),
      (req, res) => handleAttachmentRequest(req, res, { storagePort: attachmentStorage }),
    ),
    capability(
      'builtin.web-search',
      (req) => req.url?.startsWith('/api/web-search'),
      (req, res) => handleWebSearchRequest(req, res),
    ),
    capability(
      'builtin.tools.specs',
      (req) => req.url?.startsWith('/api/tools/specs'),
      (req, res) => handleToolSpecsRequest(req, res),
    ),
    capability(
      'builtin.tools.fs-shell',
      (req) => startsWithAny(req, ['/api/tools/fs/', '/api/tools/shell/']),
      (req, res) => handleFsShellRequest(req, res),
    ),
    capability(
      'builtin.tools.code',
      (req) => req.url?.startsWith('/api/tools/code/'),
      (req, res) => handleCodeSearchRequest(req, res),
    ),
    capability(
      'builtin.tools.agent',
      (req) => req.url?.startsWith('/api/tools/agent/'),
      (req, res) => handleAgenticToolRequest(req, res),
    ),
    capability(
      'builtin.tools.git-workbench',
      (req) => startsWithAny(req, ['/api/tools/git/', '/api/tools/check/', '/api/workbench/']),
      (req, res) => handleGitWorkbenchRequest(req, res),
    ),
    capability(
      'builtin.mcp.api',
      (req) => startsWithAny(req, ['/api/mcp/', '/api/tools/mcp/']),
      (req, res) => handleMcpRequest(req, res),
    ),
    capability(
      'builtin.tools.proxy',
      (req) => req.url?.startsWith('/api/tools/'),
      (req, res) => handleToolProxyRequest(req, res),
    ),
    capability(
      'builtin.artifacts',
      (req) => req.url?.startsWith('/api/artifacts/'),
      (req, res) => handleArtifactRequest(req, res),
    ),
    capability(
      'builtin.jobs',
      (req) => req.url?.startsWith('/api/jobs'),
      (req, res) => handleJobRequest(req, res, jobRuntimeForRequest(), { env: getEnv() }),
    ),
    capability(
      'builtin.cron-jobs',
      (req) => req.url?.startsWith('/api/cron-jobs'),
      (req, res) => handleCronRequest(req, res),
    ),
    capability(
      'builtin.notifications',
      (req) => req.url?.startsWith('/api/notifications'),
      (req, res) => handleNotificationRequest(req, res),
    ),
    capability(
      'builtin.approvals',
      (req) => req.url?.startsWith('/api/approvals'),
      (req, res) => handleApprovalRequest(req, res),
    ),
    capability(
      'builtin.channels',
      (req) => req.url?.startsWith('/api/channels'),
      (req, res) => handleChannelRequest(req, res),
    ),
    capability(
      'builtin.bridge',
      (req) => req.url?.startsWith('/api/bridge'),
      (req, res) => handleBridgeRequest(req, res),
    ),
    capability(
      'builtin.integrations',
      (req) => req.url?.startsWith('/api/integrations'),
      (req, res) => handleIntegrationsRequest(req, res, { env: getEnv() }),
    ),
    capability(
      'builtin.desk',
      (req) => req.url?.startsWith('/api/desk/'),
      (req, res) => handleDeskRequest(req, res),
    ),
    capability(
      'builtin.mobile',
      (req) => req.url?.startsWith('/api/mobile/'),
      (req, res) => handleMobileRequest(req, res),
    ),
    capability(
      'builtin.sessions',
      (req) => req.url?.startsWith('/api/sessions'),
      (req, res) => handleSessionRequest(req, res, null, null, getEnv(), cwd),
    ),
    capability(
      'builtin.knowledge',
      (req) => req.url?.startsWith('/api/knowledge/'),
      (req, res) => handleKnowledgeGraphRequest(req, res),
    ),
    capability(
      'builtin.capabilities',
      (req) => req.url?.startsWith('/api/capabilities'),
      (req, res) => handleCapabilityInventoryRequest(req, res),
    ),
    capability(
      'builtin.skills',
      (req) => req.url?.startsWith('/api/skills'),
      (req, res) => handleSkillRequest(req, res),
    ),
    capability(
      'builtin.plugins',
      (req) => req.url?.startsWith('/api/plugins'),
      (req, res) => handlePluginRequest(req, res, { cwd, env: getEnv() }),
    ),
    capability(
      'builtin.agent-templates',
      (req) => req.url?.startsWith('/api/agent-templates'),
      (req, res) => handleAgentTemplateRequest(req, res),
    ),
    capability(
      'builtin.agents',
      (req) => req.url?.startsWith('/api/agents'),
      (req, res) => handleAgentRequest(req, res),
    ),
    capability(
      'builtin.memory',
      (req) => req.url?.startsWith('/api/memory/'),
      (req, res) => handleMemoryRequest(req, res),
    ),
    capability(
      'builtin.hooks',
      (req) => req.url?.startsWith('/api/hooks'),
      (req, res) => handleHooksRequest(req, res),
    ),
    capability(
      'builtin.subagent',
      (req) => req.url?.startsWith('/api/subagent/'),
      (req, res) => handleSubagentRequest(req, res),
    ),
    capability(
      'builtin.compaction',
      (req) => req.url?.startsWith('/api/compaction/'),
      (req, res) => compactionRequestHandler(req, res, {
        acquireCompactionArchivePort: acquireArchivePort,
      }),
    ),
    capability(
      'builtin.tool-permissions',
      (req) => req.url?.startsWith('/api/tool-permissions'),
      (req, res) => handleToolPermissionsRequest(req, res),
    ),
    capability(
      'builtin.reasonix',
      (req) => req.url?.startsWith('/api/reasonix/'),
      (req, res) => handleReasonixRequest(req, res),
    ),
    capability(
      'builtin.turns',
      (req) => req.url?.startsWith('/api/turns'),
      (req, res) => handleTurnEventRequest(req, res, undefined, { env: getEnv() }),
    ),
    capability(
      'builtin.side-effects',
      (req) => req.url?.startsWith('/api/side-effects'),
      (req, res) => handleSideEffectRequest(req, res),
    ),
    capability(
      'builtin.audit',
      (req) => req.url?.startsWith('/api/audit'),
      (req, res) => handleAuditRequest(req, res),
    ),
    capability(
      'builtin.evolution',
      (req) => req.url?.startsWith('/api/evolution/'),
      (req, res) => {
        const env = getEnv()
        return handleEvolutionRequest(req, res, {
          cwd,
          env,
          hostEnv: env,
          readCanarySession,
        })
      },
    ),
  ]

  if (definitions.length !== BUILTIN_HTTP_CAPABILITY_CATALOG.length) {
    throw new Error('Builtin HTTP capability catalog and implementation are out of sync')
  }
  return Object.freeze(definitions)
}

export function registerBuiltinHttpCapabilities(registry, options = {}) {
  if (!registry || typeof registry.registerAll !== 'function') {
    throw new TypeError('HTTP capability registry must expose registerAll(definitions)')
  }
  return registry.registerAll(createBuiltinHttpCapabilities(options))
}
