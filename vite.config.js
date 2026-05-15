import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { getRuntimeEnv, modelProxyPlugin } from './server/modelProxy.js'
import { handleAuthBillingRequest } from './server/billingAuth.js'
import { toolProxyPlugin } from './server/toolProxy.js'

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

// https://vite.dev/config/
// base: 默认 '/'(根路径部署).要部署到子目录走 PUBLIC_BASE_PATH=/atelier/ 显式声明.
// 历史值 './' 在子目录部署 + SPA fallback 场景会让 chunk 走相对路径,刷新非根路径直接 404.
const PUBLIC_BASE_PATH = process.env.PUBLIC_BASE_PATH || '/'

export default defineConfig({
  plugins: [react(), authBillingPlugin(), modelProxyPlugin(), toolProxyPlugin()],
  base: PUBLIC_BASE_PATH,
})
