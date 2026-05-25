import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { getRuntimeEnv, modelProxyPlugin, handleSystemDiagnosticsRequest } from './server/adapters/modelProxy.js'
import { handleAuthBillingRequest } from './server/adapters/billingAuth.js'
import { toolProxyPlugin } from './server/adapters/toolProxy.js'
import { healthCheck } from './server/appServer.js'
import { handleJobRequest } from './server/routes/jobRoutes.js'
import { handleSkillRequest } from './server/routes/skillRoutes.js'
import { handleArtifactDownload } from './server/services/artifactGen.js'
import { getJobRuntime } from './server/services/jobRuntime.js'
import { handleFsShellRequest } from './server/adapters/fsShellTools.js'
import { handleGitWorkbenchRequest } from './server/adapters/gitWorkbench.js'
import { handleToolSpecsRequest } from './server/services/toolRegistry.js'
import { handleMemoryRequest } from './server/routes/memoryRoutes.js'
import { handleHooksRequest } from './server/routes/hooksRoutes.js'
import { handleMcpRequest } from './server/routes/mcpRoutes.js'
import { handleSubagentRequest } from './server/routes/subagentRoutes.js'
import { handleCompactionRequest } from './server/routes/compactionRoutes.js'
import { handleKnowledgeGraphRequest } from './server/routes/knowledgeGraphRoutes.js'

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
