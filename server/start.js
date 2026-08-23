import { startRuntimeServer } from './services/runtimeServerStartup.js'

await startRuntimeServer({ cwd: process.cwd(), env: process.env })
