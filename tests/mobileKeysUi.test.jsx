import { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import reactPlugin from '@vitejs/plugin-react'
import { resolveViteTestCacheDir } from './helpers/viteTestCache.js'

const APP_LAYOUT_STUB = '\0mobile-keys-app-layout'
const MOBILE_CLIENT_STUB = '\0mobile-keys-client'

const dependencyStubs = {
  name: 'mobile-keys-ui-dependency-stubs',
  enforce: 'pre',
  resolveId(source, importer) {
    if (!importer?.includes('/src/pages/MobileKeysView.jsx')) return null
    if (/components\/AppLayout\.jsx$/.test(source)) return APP_LAYOUT_STUB
    if (/lib\/mobileClient\.js$/.test(source)) return MOBILE_CLIENT_STUB
    return null
  },
  load(id) {
    if (id === APP_LAYOUT_STUB) {
      return `
        import { createElement } from 'react'
        export default function AppLayout({ children, ...props }) {
          return createElement('div', { ...props, 'data-testid': 'app-layout' }, children)
        }
      `
    }
    if (id === MOBILE_CLIENT_STUB) {
      return `
        export function listMobileKeysApi() {
          return globalThis.__YMA_LIST_MOBILE_KEYS__()
        }
        export function createMobileKeyApi(input) {
          return globalThis.__YMA_CREATE_MOBILE_KEY__(input)
        }
        export function revokeMobileKeyApi(id) {
          return globalThis.__YMA_REVOKE_MOBILE_KEY__(id)
        }
      `
    }
    return null
  },
}

const viteServer = await createServer({
  configFile: false,
  root: fileURLToPath(new URL('..', import.meta.url)),
  cacheDir: resolveViteTestCacheDir(),
  appType: 'custom',
  plugins: [dependencyStubs, reactPlugin()],
  server: { middlewareMode: true, hmr: false, ws: false },
})

await viteServer.ssrLoadModule('/tests/mobileKeysUi.spec.jsx')

after(async () => {
  delete globalThis.__YMA_LIST_MOBILE_KEYS__
  delete globalThis.__YMA_CREATE_MOBILE_KEY__
  delete globalThis.__YMA_REVOKE_MOBILE_KEY__
  await viteServer.close()
})
