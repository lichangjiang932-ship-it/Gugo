import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { getRuntimeEnv, modelProxyPlugin, handleSystemDiagnosticsRequest } from './server/adapters/modelProxy.js'
import { handleAuthAccountRequest } from './server/adapters/authAccount.js'
import { toolProxyPlugin } from './server/adapters/toolProxy.js'
import { enforceLocalAuthExposurePolicy, healthCheck } from './server/appServer.js'
import { handleJobRequest } from './server/routes/jobRoutes.js'
import { handleSkillRequest } from './server/routes/skillRoutes.js'
import { handleArtifactDownload } from './server/services/artifactGen.js'
import { getJobRuntime } from './server/services/jobRuntime.js'
import { handleFsShellRequest } from './server/adapters/fsShellTools.js'
import { handleGitWorkbenchRequest } from './server/adapters/gitWorkbench.js'
import { handleCodeSearchRequest } from './server/utils/codeSearchRoutes.js'
import { handleAgenticToolRequest } from './server/utils/agenticToolsRoutes.js'
import { handleApprovalRequest } from './server/routes/approvalRoutes.js'
import { handleDeskRequest } from './server/routes/deskRoutes.js'
import { handleToolPermissionsRequest } from './server/routes/toolPermissionRoutes.js'
import { handleToolSpecsRequest } from './server/services/toolRegistry.js'
import { handleMemoryRequest } from './server/routes/memoryRoutes.js'
import { handleHooksRequest } from './server/routes/hooksRoutes.js'
import { handleMcpRequest } from './server/routes/mcpRoutes.js'
import { handleSubagentRequest } from './server/routes/subagentRoutes.js'
import { handleCompactionRequest } from './server/routes/compactionRoutes.js'
import { handleKnowledgeGraphRequest } from './server/routes/knowledgeGraphRoutes.js'
import { handleCronRequest } from './server/routes/cronRoutes.js'
import { handleAgentRequest } from './server/routes/agentRoutes.js'
import { handleAgentTemplateRequest } from './server/routes/agentTemplateRoutes.js'
import { handlePluginRequest } from './server/routes/pluginRoutes.js'
import { handleChannelRequest } from './server/routes/channelRoutes.js'
import { handleIntegrationsRequest } from './server/routes/integrationsRoutes.js'
import { handleBridgeRequest } from './server/routes/bridgeRoutes.js'
import { handleReasonixRequest } from './server/routes/reasonixRoutes.js'
import { handleNotificationRequest } from './server/routes/notificationRoutes.js'
import { handleSessionRequest } from './server/routes/sessionRoutes.js'
import { handleBrowserRequest } from './server/routes/browserRoutes.js'
import { handleConnectorRequest } from './server/routes/connectorRoutes.js'
import { handleModelProviderRequest } from './server/routes/modelProviderRoutes.js'
import { handleMobileRequest } from './server/routes/mobileRoutes.js'
import { handleMcpServerRequest } from './server/mcp/mcpServer.js'
import { handleLocalFileAccessRequest } from './server/routes/localFileAccessRoutes.js'
import { handleTurnEventRequest } from './server/routes/turnEventRoutes.js'

function authAccountPlugin() {
  return {
    name: 'local-auth-account',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (
          req.url?.startsWith('/api/auth/') ||
          req.url?.startsWith('/api/account/')
        ) {
          handleAuthAccountRequest(req, res, getRuntimeEnv())
          return
        }
        next()
      })
    },
  }
}

function localAuthExposureGuardPlugin() {
  return {
    name: 'local-auth-exposure-guard',
    enforce: 'pre',
    configureServer(server) {
      const configuredHost = server.config.server.host
      const listenerHost = configuredHost === true
        ? '0.0.0.0'
        : (configuredHost || DEV_HOST)
      enforceLocalAuthExposurePolicy(RUNTIME_ENV, {
        listenerHost,
        surface: 'Vite development server',
        warn: (message) => server.config.logger.warn(message),
      })
    },
  }
}

function fallbackApiPlugin() {
  const jobRuntime = getJobRuntime()
  return {
    name: 'local-fallback-api',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url === '/mcp' || req.url?.startsWith('/mcp?')) {
          handleMcpServerRequest(req, res)
          return
        }
        if (req.url === '/api/health') {
          healthCheck(req, res)
          return
        }
        if (req.url?.startsWith('/api/system/diagnostics')) {
          handleSystemDiagnosticsRequest(req, res)
          return
        }
        if (req.url?.startsWith('/api/browser/')) {
          handleBrowserRequest(req, res)
          return
        }
        if (req.url?.startsWith('/api/connectors/')) {
          handleConnectorRequest(req, res)
          return
        }
        if (req.url?.startsWith('/api/local-files')) {
          handleLocalFileAccessRequest(req, res)
          return
        }
        if (req.url?.startsWith('/api/model/providers')) {
          handleModelProviderRequest(req, res)
          return
        }
        if (req.url?.startsWith('/api/mobile/')) {
          handleMobileRequest(req, res)
          return
        }
        if (req.url?.startsWith('/api/jobs')) {
          handleJobRequest(req, res, jobRuntime)
          return
        }
        if (req.url?.startsWith('/api/skills')) {
          handleSkillRequest(req, res)
          return
        }
        if (req.url?.startsWith('/api/artifacts')) {
          handleArtifactDownload(req, res)
          return
        }
        if (req.url?.startsWith('/api/tools/specs')) {
          handleToolSpecsRequest(req, res)
          return
        }
        if (req.url?.startsWith('/api/knowledge/')) {
          handleKnowledgeGraphRequest(req, res)
          return
        }
        if (req.url?.startsWith('/api/memory/')) {
          handleMemoryRequest(req, res)
          return
        }
        if (req.url?.startsWith('/api/hooks')) {
          handleHooksRequest(req, res)
          return
        }
        if (req.url?.startsWith('/api/mcp/') || req.url?.startsWith('/api/tools/mcp/')) {
          handleMcpRequest(req, res)
          return
        }
        if (req.url?.startsWith('/api/subagent/')) {
          handleSubagentRequest(req, res)
          return
        }
        if (req.url?.startsWith('/api/compaction/')) {
          handleCompactionRequest(req, res)
          return
        }
        if (req.url?.startsWith('/api/tools/fs/') || req.url?.startsWith('/api/tools/shell/')) {
          handleFsShellRequest(req, res)
          return
        }
        if (req.url === '/api/cron-jobs' || req.url?.startsWith('/api/cron-jobs/') || req.url?.startsWith('/api/cron-jobs?')) {
          handleCronRequest(req, res)
          return
        }
        if (req.url === '/api/agent-templates' || req.url?.startsWith('/api/agent-templates/') || req.url?.startsWith('/api/agent-templates?')) {
          handleAgentTemplateRequest(req, res)
          return
        }
        if (req.url === '/api/agents' || req.url?.startsWith('/api/agents/') || req.url?.startsWith('/api/agents?')) {
          handleAgentRequest(req, res)
          return
        }
        if (req.url === '/api/plugins' || req.url?.startsWith('/api/plugins/') || req.url?.startsWith('/api/plugins?')) {
          handlePluginRequest(req, res)
          return
        }
        if (req.url === '/api/channels' || req.url?.startsWith('/api/channels/') || req.url?.startsWith('/api/channels?')) {
          handleChannelRequest(req, res)
          return
        }
        if (req.url === '/api/integrations' || req.url?.startsWith('/api/integrations/') || req.url?.startsWith('/api/integrations?')) {
          handleIntegrationsRequest(req, res)
          return
        }
        if (req.url === '/api/bridge' || req.url?.startsWith('/api/bridge/') || req.url?.startsWith('/api/bridge?')) {
          handleBridgeRequest(req, res)
          return
        }
        if (req.url?.startsWith('/api/reasonix/')) {
          handleReasonixRequest(req, res)
          return
        }
        if (req.url?.startsWith('/api/turns')) {
          handleTurnEventRequest(req, res)
          return
        }
        if (req.url === '/api/notifications' || req.url?.startsWith('/api/notifications/') || req.url?.startsWith('/api/notifications?')) {
          handleNotificationRequest(req, res)
          return
        }
        if (req.url === '/api/sessions' || req.url?.startsWith('/api/sessions/') || req.url?.startsWith('/api/sessions?')) {
          handleSessionRequest(req, res)
          return
        }
        // ★ 代码搜索 + 补丁 (grep_code / find_symbol / list_imports / apply_patch)
        //
        // 这条**曾经漏掉过**,后果极其隐蔽:dev 模式下模型每次调 grep_code
        // 都拿到 HTTP 404,既搜不到代码也改不了文件,只能退而求其次去
        // 生成 PPT/文档来"交差" —— 用户看到的是「工具执行 33 步 1 步失败,
        // 然后产出了一个莫名其妙的 PPT」,根本看不出根因在构建配置里。
        //
        // 任何加进 appServer.js 的 /api 前缀都必须同步加到这里,
        // 否则 dev 和 prod 行为不一致。tests/devServerRoutes.test.js 会守住。
        if (req.url?.startsWith('/api/tools/code/')) {
          handleCodeSearchRequest(req, res)
          return
        }
        // ★ 思维型工具 (reflect / request_clarification)
        if (req.url?.startsWith('/api/tools/agent/')) {
          handleAgenticToolRequest(req, res)
          return
        }
        // ★ 审批闸口。漏了它 dev 模式下所有需要审批的工具(写文件/执行命令)
        // 都会 404 —— 表现为「工具明明开了却总是失败」。
        if (req.url?.startsWith('/api/approvals')) {
          handleApprovalRequest(req, res)
          return
        }
        // ★ per-user 工具权限 gate(PermissionsDashboard 的真 gate)
        if (req.url?.startsWith('/api/tool-permissions')) {
          handleToolPermissionsRequest(req, res)
          return
        }
        // Desk Notes(书桌便笺)
        if (req.url?.startsWith('/api/desk/')) {
          handleDeskRequest(req, res)
          return
        }
        if (req.url?.startsWith('/api/tools/git/') || req.url?.startsWith('/api/tools/check/') || req.url?.startsWith('/api/workbench/')) {
          handleGitWorkbenchRequest(req, res)
          return
        }
        next()
      })
    },
  }
}

// https://vite.dev/config/
// base: 默认 '/'(根路径部署).要部署到子目录走 PUBLIC_BASE_PATH=/atelier/ 显式声明.
// 历史值 './' 在子目录部署 + SPA fallback 场景会让 chunk 走相对路径,刷新非根路径直接 404.
const PUBLIC_BASE_PATH = process.env.PUBLIC_BASE_PATH || '/'

/**
 * ★ dev server 的 host/port 必须**固定**,而且要和 `npm run serve`(生产)一致。
 *
 * 背景:登录 token 和轻量偏好存在 localStorage,会话与历史存在 IndexedDB,
 * 两者都按 **origin**(协议+主机+端口)隔离。
 *
 * 以前 vite 没配 server,`npm run dev` 落在默认的 localhost:5173,
 * 手动加 `--host 127.0.0.1 --port 5175` 又落在另一个 origin ——
 * 两边是两套完全独立的存储:一边登录了、有历史对话,另一边是全新状态。
 * 用户以为"数据丢了",其实只是换了个门进屋。
 *
 * 注意 localhost 和 127.0.0.1 **也是不同 origin**,所以 host 也必须钉死,
 * 不能只钉端口。这里读的是和 server/appServer.js 完全同一份配置
 * (getRuntimeEnv 会加载 .env),保证 dev 和 prod 落在同一个 origin,
 * 切换运行方式不丢登录态。
 *
 * ⚠ 必须用 getRuntimeEnv() 而不是裸的 process.env —— vite.config.js 加载时
 * 没人把 .env 灌进 process.env,直接读 process.env.SERVER_PORT 恒为 undefined,
 * 会静默退回默认值,配了也不生效。
 */
const RUNTIME_ENV = getRuntimeEnv()
const DEV_HOST = RUNTIME_ENV.SERVER_HOST || '127.0.0.1'
const DEV_PORT = Number(RUNTIME_ENV.VITE_DEV_PORT || RUNTIME_ENV.SERVER_PORT || 5175)

// Server-side middleware imports are loaded with the Vite config; changing
// them requires this config-restart path rather than client-only HMR.

export default defineConfig({
  plugins: [localAuthExposureGuardPlugin(), react(), authAccountPlugin(), modelProxyPlugin(), toolProxyPlugin(), fallbackApiPlugin()],
  base: PUBLIC_BASE_PATH,
  server: {
    host: DEV_HOST,
    port: DEV_PORT,
    // 端口被占就直接报错,**不要**自动换一个 —— 静默换端口正是
    // "同一个命令这次能看到历史、下次看不到"的元凶。
    strictPort: true,
  },
  build: {
    chunkSizeWarningLimit: 1100,
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Group React + Router into one stable vendor chunk
          if (id.includes('node_modules/react-router')) return 'vendor-react'
          if (id.includes('node_modules/react-dom')) return 'vendor-react'
          if (id.includes('node_modules/react/')) return 'vendor-react'
          if (id.includes('node_modules/scheduler')) return 'vendor-react'
          // Group Framer Motion separately (large, stable)
          if (id.includes('node_modules/framer-motion')) return 'vendor-motion'
          // Three.js 不再合名 — 让它跟随 CoverPage 的 lazy chunk
          // (manualChunks 会把 node_modules 提到同步 vendor，重点的 3D 装饰不该堆到首屏)
          // Group lucide icons (many small files)
          if (id.includes('node_modules/lucide-react')) return 'vendor-icons'
          // 大货独立分块 — 原 vendor-common 2.4MB 原凶
          // 注意：pptxgenjs / xlsx / jszip / html-to-image 都有代码里 await import，
          // 指定 manualChunks 会把它们从异步 chunk 提到 entry vendor，反而变大。
          // 全部交给 vite 默认的动态拆分，仅拆真同步依赖。
          if (id.includes('node_modules/highlight.js')) return 'vendor-hljs'
          if (id.includes('node_modules/react-markdown') ||
              id.includes('node_modules/remark-') ||
              id.includes('node_modules/rehype-') ||
              id.includes('node_modules/micromark') ||
              id.includes('node_modules/mdast-') ||
              id.includes('node_modules/hast-') ||
              id.includes('node_modules/unist-') ||
              id.includes('node_modules/unified') ||
              id.includes('node_modules/vfile') ||
              id.includes('node_modules/property-information') ||
              id.includes('node_modules/space-separated-tokens') ||
              id.includes('node_modules/comma-separated-tokens')) return 'vendor-markdown'
          if (id.includes('node_modules/dompurify')) return 'vendor-purify'
          if (id.includes('node_modules/zod')) return 'vendor-zod'
          // Group all remaining node_modules
          // 不再 fallback 到 vendor-common：未命中上面规则的 node_modules 交给 vite
          // 默认动态拆分，避免 pptxgenjs / xlsx / jszip / html-to-image 被捞进同一个
          // 巨块。这些库代码里都是 await import，会被拆到各自的 async chunk。
        },
      },
    },
  },
})
