import { startRuntimeServer } from './services/runtimeServerStartup.js'
import { bindDesktopParentGuard } from './services/desktopParentGuard.js'
import { SERVER_APPLICATION_ROOT } from './utils/serverApplicationRoot.js'

let server = null
const desktopParentGuard = bindDesktopParentGuard({
  mode: process.env.GUGO_DESKTOP_PARENT_GUARD,
  requestShutdown: async () => {
    const { gracefulShutdown } = await import('./core/lifecycle.js')
    return gracefulShutdown(server, { exit: false })
  },
})

try {
  server = await startRuntimeServer({ cwd: SERVER_APPLICATION_ROOT, env: process.env })
  if (!server) desktopParentGuard.dispose()
} catch (error) {
  desktopParentGuard.dispose()
  throw error
}
