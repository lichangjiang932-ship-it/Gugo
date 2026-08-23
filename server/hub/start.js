#!/usr/bin/env node
import { startHubProcess } from './index.js'

try {
  await startHubProcess({
    cwd: process.cwd(),
    env: { ...process.env, HUB_ENABLED: '1' },
  })
} catch (error) {
  process.stderr.write(`[hub] startup failed: ${error?.stack || error}\n`)
  process.exitCode = 1
}
