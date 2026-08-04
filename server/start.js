import { applyRuntimeConfig } from './utils/runtimeEnv.js'

applyRuntimeConfig()

const { startAppServer } = await import('./appServer.js')
startAppServer()
