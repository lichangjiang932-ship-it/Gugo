import { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import reactPlugin from '@vitejs/plugin-react'

const APP_CONTEXT_STUB = '\0storage-persistence-app-context'
const I18N_STUB = '\0storage-persistence-i18n'

const dependencyStubs = {
  name: 'storage-persistence-ui-dependency-stubs',
  enforce: 'pre',
  resolveId(source, importer) {
    if (!importer?.includes('/src/components/')) return null
    if (/store\/AppContext\.jsx$/.test(source)) return APP_CONTEXT_STUB
    if (/i18n\/I18nProvider\.jsx$/.test(source)) return I18N_STUB
    return null
  },
  load(id) {
    if (id === APP_CONTEXT_STUB) {
      return `
        export function useAppContext() {
          return globalThis.__YMA_STORAGE_NOTICE_CONTEXT__
        }
        export function clearPersistedState() {
          return globalThis.__YMA_CLEAR_PERSISTED_STATE__()
        }
      `
    }
    if (id === I18N_STUB) {
      return `
        export function useT() {
          return { t: globalThis.__YMA_STORAGE_NOTICE_TRANSLATE__ }
        }
      `
    }
    return null
  },
}

const viteServer = await createServer({
  configFile: false,
  root: fileURLToPath(new URL('..', import.meta.url)),
  appType: 'custom',
  plugins: [dependencyStubs, reactPlugin()],
  server: { middlewareMode: true, hmr: false },
})

await viteServer.ssrLoadModule('/tests/storagePersistenceUi.spec.jsx')

after(async () => {
  delete globalThis.__YMA_STORAGE_NOTICE_CONTEXT__
  delete globalThis.__YMA_STORAGE_NOTICE_TRANSLATE__
  delete globalThis.__YMA_CLEAR_PERSISTED_STATE__
  await viteServer.close()
})
