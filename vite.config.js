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
export default defineConfig({
  plugins: [react(), authBillingPlugin(), modelProxyPlugin(), toolProxyPlugin()],
  base: './',
})
