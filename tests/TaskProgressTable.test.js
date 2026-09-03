import { after } from 'node:test'
import { createServer } from 'vite'
import reactPlugin from '@vitejs/plugin-react'
import { resolveViteTestCacheDir } from './helpers/viteTestCache.js'

const viteServer = await createServer({
  configFile: false,
  root: process.cwd(),
  cacheDir: resolveViteTestCacheDir(),
  appType: 'custom',
  plugins: [reactPlugin()],
  server: { middlewareMode: true, hmr: false, ws: false },
})

await viteServer.ssrLoadModule('/tests/unit/TaskProgressTable.test.jsx')

after(async () => viteServer.close())
