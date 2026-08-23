import dgram from 'node:dgram'
import childProcess from 'node:child_process'
import dns from 'node:dns'
import dnsPromises from 'node:dns/promises'
import http from 'node:http'
import http2 from 'node:http2'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import workerThreads from 'node:worker_threads'

const require = createRequire(import.meta.url)
const undici = require('undici')

export const OFFLINE_EVAL_NETWORK_ERROR_CODE = 'OFFLINE_EVAL_NETWORK_FORBIDDEN'

const STATE_KEY = Symbol.for('gugo.offlineEvalNetworkGuard.state.v1')
const MAX_ATTEMPTS = 256
const GUARD_IMPORT_URL = import.meta.url

const DNS_METHODS = Object.freeze([
  'lookup',
  'lookupService',
  'resolve',
  'resolve4',
  'resolve6',
  'resolveAny',
  'resolveCaa',
  'resolveCname',
  'resolveMx',
  'resolveNaptr',
  'resolveNs',
  'resolvePtr',
  'resolveSoa',
  'resolveSrv',
  'resolveTxt',
  'reverse',
])

const CHILD_PROCESS_METHODS = Object.freeze([
  'exec',
  'execFile',
  'execFileSync',
  'execSync',
  'fork',
  'spawn',
  'spawnSync',
])

const UNSAFE_WORKER_EXEC_ARGV = /^(?:-r|--require(?:=|$)|--loader(?:=|$)|--experimental-loader(?:=|$))/u

function stateForGuard() {
  if (!globalThis[STATE_KEY]) {
    Object.defineProperty(globalThis, STATE_KEY, {
      value: {
        installed: false,
        attempts: [],
        sequence: 0,
        restorers: [],
      },
      configurable: true,
      enumerable: false,
      writable: false,
    })
  }
  return globalThis[STATE_KEY]
}

function urlTarget(value) {
  const candidate = value?.url || value?.href || value
  if (typeof candidate !== 'string') return null
  try {
    const parsed = new URL(candidate)
    const port = parsed.port ? `:${parsed.port}` : ''
    return `${parsed.protocol}//${parsed.hostname}${port}`
  } catch {
    return null
  }
}

function objectTarget(value) {
  if (!value || typeof value !== 'object') return null
  const origin = urlTarget(value.origin)
  if (origin) return origin
  const direct = urlTarget(value)
  if (direct) return direct
  const host = String(value.hostname || value.host || '').trim()
  const port = Number.isFinite(Number(value.port)) ? String(value.port) : ''
  if (host) return port ? `${host}:${port}` : host
  if (value.socketPath || value.path) return '[local-socket]'
  return null
}

function attemptTarget(transport, args) {
  try {
    if (transport === 'child_process') return '[external-process]'
    if (transport === 'dns') return '[dns-query]'
    if (transport === 'worker') return '[worker]'
    const first = args[0]
    const fromUrl = urlTarget(first)
    if (fromUrl) return fromUrl
    const fromObject = objectTarget(first)
    if (fromObject) return fromObject
    if ((transport === 'net' || transport === 'tls') && Number.isFinite(Number(first))) {
      const host = typeof args[1] === 'string' ? args[1] : '[unspecified-host]'
      return `${host}:${first}`
    }
    if (transport === 'dgram' && typeof first === 'string') return first
  } catch {
    return '[unknown-target]'
  }
  return '[unknown-target]'
}

function forbiddenError(transport, args) {
  const state = stateForGuard()
  const attempt = Object.freeze({
    sequence: state.sequence += 1,
    transport,
    target: attemptTarget(transport, args),
  })
  state.attempts.push(attempt)
  if (state.attempts.length > MAX_ATTEMPTS) state.attempts.shift()

  const error = new Error(
    `offline eval blocked ${transport} network access to ${attempt.target}`,
  )
  error.name = 'OfflineEvalNetworkForbiddenError'
  error.code = OFFLINE_EVAL_NETWORK_ERROR_CODE
  error.retryable = false
  error.attempt = attempt
  return error
}

function replaceValue(state, target, key, replacement) {
  if (!target) return
  const descriptor = Object.getOwnPropertyDescriptor(target, key)
  if (descriptor && !descriptor.configurable && descriptor.writable === false) return

  state.restorers.push(() => {
    if (descriptor) Object.defineProperty(target, key, descriptor)
    else delete target[key]
  })
  if (descriptor) {
    Object.defineProperty(target, key, { ...descriptor, value: replacement })
  } else {
    Object.defineProperty(target, key, {
      value: replacement,
      configurable: true,
      enumerable: false,
      writable: true,
    })
  }
}

function blockedSync(transport) {
  return function offlineEvalBlockedNetworkCall(...args) {
    throw forbiddenError(transport, args)
  }
}

function blockedAsync(transport) {
  return async function offlineEvalBlockedAsyncNetworkCall(...args) {
    throw forbiddenError(transport, args)
  }
}

function replaceMethods(state, target, keys, replacementFactory) {
  for (const key of keys) {
    if (typeof target?.[key] === 'function') {
      replaceValue(state, target, key, replacementFactory())
    }
  }
}

function installUndiciGuard(state) {
  const previousDispatcher = undici.getGlobalDispatcher()
  const restoreDispatcher = undici.setGlobalDispatcher
  const dispatcher = Object.freeze({
    dispatch(options, handler) {
      const error = forbiddenError('undici', [options])
      if (typeof handler?.onError === 'function') {
        handler.onError(error)
        return false
      }
      throw error
    },
    close: async () => {},
    destroy: async () => {},
  })
  undici.setGlobalDispatcher(dispatcher)
  state.restorers.push(() => restoreDispatcher(previousDispatcher))

  for (const key of [
    'fetch',
    'request',
    'stream',
    'pipeline',
    'connect',
    'upgrade',
    'ping',
  ]) {
    if (typeof undici[key] === 'function') {
      replaceValue(state, undici, key, blockedAsync('undici'))
    }
  }
  for (const key of [
    'WebSocket',
    'WebSocketStream',
    'EventSource',
    'buildConnector',
    'install',
    'setGlobalDispatcher',
  ]) {
    if (typeof undici[key] === 'function') {
      replaceValue(state, undici, key, blockedSync('undici'))
    }
  }
  for (const key of [
    'Agent',
    'BalancedPool',
    'Client',
    'EnvHttpProxyAgent',
    'H2CClient',
    'MockAgent',
    'Pool',
    'ProxyAgent',
    'RetryAgent',
    'RoundRobinPool',
    'Socks5ProxyAgent',
  ]) {
    if (typeof undici[key]?.prototype?.dispatch === 'function') {
      replaceValue(state, undici[key].prototype, 'dispatch', blockedSync('undici'))
    }
  }
}

function installDnsGuard(state) {
  replaceMethods(state, dns, DNS_METHODS, () => blockedSync('dns'))
  replaceMethods(state, dns.Resolver?.prototype, DNS_METHODS, () => blockedSync('dns'))
  replaceMethods(state, dnsPromises, DNS_METHODS, () => blockedAsync('dns'))
  replaceMethods(
    state,
    dnsPromises.Resolver?.prototype,
    DNS_METHODS,
    () => blockedAsync('dns'),
  )
}

function installHttp2Guard(state) {
  replaceValue(state, http2, 'connect', blockedSync('http2'))
}

function installChildProcessGuard(state) {
  replaceMethods(
    state,
    childProcess,
    CHILD_PROCESS_METHODS,
    () => blockedSync('child_process'),
  )
  replaceValue(
    state,
    childProcess.ChildProcess?.prototype,
    'spawn',
    blockedSync('child_process'),
  )
}

function workerExecArgv(options) {
  const requested = Object.hasOwn(options, 'execArgv')
    ? options.execArgv
    : process.execArgv
  if (!Array.isArray(requested)) return requested
  for (let index = 0; index < requested.length; index += 1) {
    const argument = String(requested[index] || '')
    if (UNSAFE_WORKER_EXEC_ARGV.test(argument)) {
      throw forbiddenError('worker', [])
    }
  }
  return ['--import', GUARD_IMPORT_URL, ...requested]
}

function guardedWorkerEvalSource(source) {
  if (typeof source !== 'string') return source
  return `import(${JSON.stringify(GUARD_IMPORT_URL)}).then(() => {\n`
    + `  eval(${JSON.stringify(source)})\n`
    + '}).catch((error) => { setImmediate(() => { throw error }) })\n'
}

function installWorkerGuard(state) {
  const NativeWorker = workerThreads.Worker
  if (typeof NativeWorker !== 'function') return
  class OfflineEvalGuardedWorker extends NativeWorker {
    constructor(filename, options = {}) {
      const normalizedOptions = options && typeof options === 'object'
        ? { ...options }
        : options
      let guardedFilename = filename
      if (normalizedOptions && typeof normalizedOptions === 'object') {
        normalizedOptions.execArgv = workerExecArgv(normalizedOptions)
        if (normalizedOptions.eval === true) {
          guardedFilename = guardedWorkerEvalSource(filename)
        }
      }
      super(guardedFilename, normalizedOptions)
    }
  }
  Object.defineProperty(OfflineEvalGuardedWorker, 'name', { value: 'Worker' })
  replaceValue(state, workerThreads, 'Worker', OfflineEvalGuardedWorker)
}

function installBuiltinGuards(state) {
  replaceValue(state, http, 'request', blockedSync('http'))
  replaceValue(state, http, 'get', blockedSync('http'))
  replaceValue(state, https, 'request', blockedSync('https'))
  replaceValue(state, https, 'get', blockedSync('https'))

  replaceValue(state, net, 'connect', blockedSync('net'))
  replaceValue(state, net, 'createConnection', blockedSync('net'))
  replaceValue(state, net.Socket?.prototype, 'connect', blockedSync('net'))

  replaceValue(state, tls, 'connect', blockedSync('tls'))
  replaceValue(state, tls.TLSSocket?.prototype, 'connect', blockedSync('tls'))

  replaceValue(state, dgram, 'createSocket', blockedSync('dgram'))
  replaceValue(state, dgram.Socket?.prototype, 'connect', blockedSync('dgram'))
  replaceValue(state, dgram.Socket?.prototype, 'send', blockedSync('dgram'))

  installDnsGuard(state)
  installHttp2Guard(state)
  installChildProcessGuard(state)
  installWorkerGuard(state)
  syncBuiltinESMExports()
}

export function installOfflineEvalNetworkGuard() {
  const state = stateForGuard()
  if (state.installed) return false
  state.installed = true
  try {
    replaceValue(state, globalThis, 'fetch', blockedAsync('fetch'))
    replaceValue(state, globalThis, 'WebSocket', blockedSync('websocket'))
    replaceValue(state, globalThis, 'EventSource', blockedSync('eventsource'))
    installUndiciGuard(state)
    installBuiltinGuards(state)
  } catch (error) {
    restoreOfflineEvalNetworkGuard()
    throw error
  }
  return true
}

export function restoreOfflineEvalNetworkGuard() {
  const state = stateForGuard()
  if (!state.installed) return false
  while (state.restorers.length) {
    state.restorers.pop()()
  }
  state.installed = false
  syncBuiltinESMExports()
  return true
}

export function getOfflineEvalNetworkAttempts() {
  const state = stateForGuard()
  return Object.freeze([...state.attempts])
}

export function resetOfflineEvalNetworkAttempts() {
  const state = stateForGuard()
  state.attempts.length = 0
  state.sequence = 0
}

installOfflineEvalNetworkGuard()
