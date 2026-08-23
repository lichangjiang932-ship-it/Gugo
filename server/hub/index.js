#!/usr/bin/env node
import path from 'node:path'
import { pathToFileURL } from 'node:url'

let runtimeModulePromise = null

function loadHubRuntime() {
  runtimeModulePromise ||= import('./runtime.js')
  return runtimeModulePromise
}

export function isHubMainEntry(argv = process.argv) {
  const entry = argv[1]
  if (!entry) return false
  return pathToFileURL(path.resolve(entry)).href === import.meta.url
}

export async function runOnce() {
  return (await loadHubRuntime()).runOnce()
}

export async function startHub(options = {}) {
  return (await loadHubRuntime()).startHub(options)
}

export async function shutdownHub() {
  return (await loadHubRuntime()).shutdownHub()
}

/**
 * Safe Hub process bootstrap. The disabled path imports no database/runtime
 * modules. The enabled path publishes one startup identity before loading the
 * queue implementation.
 */
export async function startHubProcess({
  cwd = process.cwd(),
  env = process.env,
  installSignalHandlers = true,
} = {}, dependencies = {}) {
  if (env.HUB_ENABLED !== '1') return Object.freeze({ started: false, reason: 'disabled' })

  const preflight = dependencies.runRuntimeConfigStartupPreflight || (
    await import('../services/runtimeConfigStartupService.js')
  ).runRuntimeConfigStartupPreflight
  const { runtimeEnv } = preflight({ cwd, env })
  const runtime = dependencies.runtime || await loadHubRuntime()

  let shutdownPromise = null
  const requestShutdown = () => {
    if (shutdownPromise) return shutdownPromise
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
    shutdownPromise = Promise.resolve()
      .then(() => runtime.shutdownHub())
      .then((exitCode) => {
        if (exitCode !== 0) process.exitCode = exitCode
        return exitCode
      })
    return shutdownPromise
  }
  const onSigint = () => { void requestShutdown() }
  const onSigterm = () => { void requestShutdown() }
  if (installSignalHandlers) {
    process.once('SIGINT', onSigint)
    process.once('SIGTERM', onSigterm)
  }

  try {
    runtime.startHub({ env: runtimeEnv })
  } catch (error) {
    if (installSignalHandlers) {
      process.off('SIGINT', onSigint)
      process.off('SIGTERM', onSigterm)
    }
    throw error
  }
  return Object.freeze({ started: true, runtimeEnv, shutdown: requestShutdown })
}

if (isHubMainEntry()) {
  try {
    const result = await startHubProcess()
    if (!result.started) {
      process.stdout.write('[hub] HUB_ENABLED!=1, exiting (set HUB_ENABLED=1 to start)\n')
    }
  } catch (error) {
    process.stderr.write(`[hub] startup failed: ${error?.stack || error}\n`)
    process.exitCode = 1
  }
}
