#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { assertFileDeliveryWorkerEnvironment, createFileDeliveryEnvironment, prepareFileDeliveryDirectories } from './file-delivery-verification/environment.mjs'

const scriptPath = fileURLToPath(import.meta.url)
const projectRoot = path.resolve(path.dirname(scriptPath), '..')

export function parseFileDeliveryArguments(args) {
  const live = args[0] === '--live'
  if (args[0] !== '--serve' && !live) throw new TypeError('Use --serve or --live [--port 5181]')
  const rest = args.slice(1)
  if (rest.length && (rest.length !== 2 || rest[0] !== '--port' || !/^\d+$/.test(rest[1]))) {
    throw new TypeError('Use --serve or --live [--port 5181]')
  }
  const port = rest.length ? Number(rest[1]) : 5181
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError('Invalid verification port')
  return { live, port }
}

async function receiveRequest() {
  if (!process.send || !process.connected || process.argv.length !== 3) {
    throw new TypeError('File delivery worker requires parent IPC')
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Verification handshake timed out')), 10000)
    const onDisconnect = () => finish(new Error('Verification parent disconnected'))
    const onMessage = value => finish(null, value)
    function finish(error, value) {
      clearTimeout(timer)
      process.removeListener('disconnect', onDisconnect)
      process.removeListener('message', onMessage)
      if (error) reject(error)
      else resolve(value)
    }
    process.once('message', onMessage)
    process.once('disconnect', onDisconnect)
  })
}

async function worker() {
  const request = await receiveRequest()
  const { runRoot, port, modelBinding = null } = request || {}
  assertFileDeliveryWorkerEnvironment({ runRoot, projectRoot, port })
  const { serveFileDeliveryVerification } = await import('./file-delivery-verification/server.mjs')
  await serveFileDeliveryVerification({ runRoot, projectRoot, port, modelBinding })
}

async function main(args) {
  if (args[0] === '--internal-worker') return worker()
  const { live, port } = parseFileDeliveryArguments(args)
  // Live access was blocked by the session permission policy. Do not expose an
  // incomplete runner: task admission and Turn stop/unknown wiring remain open.
  if (live) throw Object.assign(new Error('Live verification is not available'), { code: 'FILE_DELIVERY_LIVE_UNAVAILABLE' })
  const modelBinding = null
  const runRoot = mkdtempSync(path.join(tmpdir(), 'gugo-file-delivery-'))
  const env = createFileDeliveryEnvironment({ runRoot, projectRoot, port })
  prepareFileDeliveryDirectories(env)
  console.log(`[file-delivery] isolated roots: ${runRoot}`)
  console.log(`[file-delivery] mode: ${live ? 'live synthetic file tasks only' : 'offline UI; model calls denied'}`)
  const child = spawn(process.execPath, [scriptPath, '--internal-worker'], {
    cwd: projectRoot, env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'], windowsHide: true,
  })
  child.once('spawn', () => child.send({ runRoot, port, modelBinding }, error => { if (error) child.kill('SIGTERM') }))
  const stop = () => { if (child.exitCode === null) child.kill('SIGTERM') }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', value => resolve(value ?? 1))
  })
  process.removeListener('SIGINT', stop)
  process.removeListener('SIGTERM', stop)
  process.exitCode = code
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(error => {
    // Error messages from configuration/parsing libraries can contain secrets.
    console.error(`[file-delivery] stopped: ${/^[A-Z][A-Z0-9_]{0,95}$/.test(error?.code || '') ? error.code : 'VERIFICATION_START_FAILED'}`)
    process.exitCode = 1
  })
}
