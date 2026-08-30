import { spawn } from 'node:child_process'
import { WINDOWS_PROCESS_GATE_PROTOCOL } from './windowsProcessGateRuntime.js'

let accepted = false
let finished = false
let target = null

function disconnectParent() {
  if (!process.connected) return
  try { process.disconnect?.() } catch { /* channel already closed */ }
}

function finish(code) {
  if (finished) return
  finished = true
  process.exitCode = Number.isInteger(code) ? code : 1
  disconnectParent()
}

function fail(message, code = 1) {
  try { process.stderr.write(`${String(message || 'Windows process gate failed')}\n`) } catch { /* pipe closed */ }
  finish(code)
}

function sendStatus(operation, details, callback) {
  const done = typeof callback === 'function' ? callback : () => {}
  if (!process.connected || typeof process.send !== 'function') {
    done(new Error('Windows process gate IPC channel is unavailable'))
    return
  }
  try {
    process.send({
      protocol: WINDOWS_PROCESS_GATE_PROTOCOL,
      operation,
      ...(details && typeof details === 'object' ? details : {}),
    }, (error) => done(error || null))
  } catch (error) {
    done(error)
  }
}

function reportStartFailure(error) {
  const message = error?.message || String(error || 'Windows target process failed to start')
  try { process.stderr.write(`${message}\n`) } catch { /* pipe closed */ }
  sendStatus('START_FAILED', {
    error: message,
    errorCode: typeof error?.code === 'string' ? error.code : null,
  }, () => finish(127))
}

function validStringRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.entries(value).every(([key, item]) => key && typeof item === 'string')
}

function validStartMessage(message) {
  return message?.protocol === WINDOWS_PROCESS_GATE_PROTOCOL
    && message?.operation === 'START'
    && typeof message.shellPath === 'string'
    && message.shellPath.length > 0
    && Array.isArray(message.shellArgs)
    && message.shellArgs.every((value) => typeof value === 'string')
    && (message.cwd == null || typeof message.cwd === 'string')
    && validStringRecord(message.env)
    && typeof message.hasStdinInput === 'boolean'
    && typeof message.hasControlPipe === 'boolean'
    && typeof message.windowsHide === 'boolean'
    && typeof message.windowsVerbatimArguments === 'boolean'
}

process.once('message', (message) => {
  if (accepted || !validStartMessage(message)) {
    fail('Windows process gate received an invalid start request')
    return
  }
  accepted = true
  try {
    target = spawn(message.shellPath, message.shellArgs, {
      cwd: message.cwd || undefined,
      env: message.env,
      windowsHide: message.windowsHide,
      windowsVerbatimArguments: message.windowsVerbatimArguments,
      detached: false,
      stdio: [
        message.hasStdinInput ? 'pipe' : 'ignore',
        1,
        2,
        message.hasControlPipe ? 3 : 'ignore',
      ],
    })
  } catch (error) {
    fail(error?.message || String(error), 127)
    return
  }

  target.once('spawn', () => {
    if (message.hasStdinInput) {
      process.stdin.pipe(target.stdin)
      target.stdin?.once('error', () => { /* target may exit before consuming input */ })
    }
    sendStatus('STARTED', { pid: target.pid }, (error) => {
      if (!error) {
        disconnectParent()
        return
      }
      try { target?.kill?.('SIGKILL') } catch { /* parent will also close the bound job */ }
      fail(`Windows process gate could not confirm target startup: ${error.message}`)
    })
  })
  target.once('error', reportStartFailure)
  target.once('exit', (code) => finish(code))
})

process.once('disconnect', () => {
  if (!accepted) fail('Windows process gate was closed before start')
})

sendStatus('READY', null, (error) => {
  if (error) fail(error?.message || String(error))
})
