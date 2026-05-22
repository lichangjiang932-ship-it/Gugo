import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { getRuntimeEnv, modelProxyPlugin, handleSystemDiagnosticsRequest } from './server/modelProxy.js'
import { handleAuthBillingRequest } from './server/billingAuth.js'
import { toolProxyPlugin } from './server/toolProxy.js'
import { healthCheck } from './server/appServer.js'
import { handleJobRequest } from './server/jobRoutes.js'
import { handleSkillRequest } from './server/skillRoutes.js'
import { handleArtifactDownload } from './server/artifactGen.js'
import { getJobRuntime } from './server/jobRuntime.js'
import { handleFsShellRequest } from './server/fsShellTools.js'
import { handleGitWorkbenchRequest } from './server/gitWorkbench.js'
import { handleToolSpecsRequest } from './server/toolRegistry.js'
import { handleMemoryRequest } from './server/memoryRoutes.js'
import { handleHooksRequest } from './server/hooksRoutes.js'
import { handleMcpRequest } from './server/mcpRoutes.js'
import { handleSubagentRequest } from './server/subagentRoutes.js'
import { handleCompactionRequest } from './server/compactionRoutes.js'
import { handleKnowledgeGraphRequest } from './server/knowledgeGraphRoutes.js'

function authBillingPlugin() {
  return {
    name: 'local-auth-billing',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (
          req.url?.startsWith('/api/auth/') ||
          req.url?.startsWith('/api/account/') ||
          req.url?.startsWith('/api/billing/')
        ) {
          handleAuthBillingRequest(req, res, getRuntimeEnv())
          return
        }
        next()
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
        if (req.url === '/api/health') {
          healthCheck(req, res)
          return
        }
        if (req.url?.startsWith('/api/system/diagnostics')) {
          handleSystemDiagnosticsRequest(req, res)
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

export default defineConfig({
  plugins: [react(), authBillingPlugin(), modelProxyPlugin(), toolProxyPlugin(), fallbackApiPlugin()],
  base: PUBLIC_BASE_PATH,
  build: {
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Group React + Router into one stable vendor chunk
          if (id.includes('node_modules/react') || id.includes('node_modules/react-dom') || id.includes('node_modules/react-router')) return 'vendor-react'
          // Group Framer Motion separately (large, stable)
          if (id.includes('node_modules/framer-motion')) return 'vendor-motion'
          // Group Three.js into one chunk
          if (id.includes('node_modules/three') || id.includes('node_modules/@react-three')) return 'vendor-three'
          // Group lucide icons (many small files)
          if (id.includes('node_modules/lucide-react')) return 'vendor-icons'
          // Group all remaining node_modules
          if (id.includes('node_modules/')) return 'vendor-common'
        },
      },
    },
  },
})
