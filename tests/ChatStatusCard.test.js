import { after } from 'node:test'
import { createServer } from 'vite'
import reactPlugin from '@vitejs/plugin-react'

const viteServer = await createServer({
  configFile: false,
  root: process.cwd(),
  appType: 'custom',
  plugins: [reactPlugin()],
  server: { middlewareMode: true, hmr: false },
})

await viteServer.ssrLoadModule('/tests/unit/ChatStatusCard.test.jsx')

after(async () => viteServer.close())
