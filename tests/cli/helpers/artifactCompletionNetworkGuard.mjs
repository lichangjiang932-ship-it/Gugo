import dns from 'node:dns'
import dgram from 'node:dgram'
import net from 'node:net'
import { syncBuiltinESMExports } from 'node:module'

const allowedPort = Number(process.env.GUGO_CLI_TEST_PROVIDER_PORT)
function forbidden() {
  process.stderr.write('[CLI-E2E-NETWORK-GUARD] blocked a non-provider transport\n')
  const error = new Error('CLI artifact e2e permits only its loopback provider socket')
  error.code = 'CLI_E2E_EXTERNAL_NETWORK_FORBIDDEN'
  throw error
}

// Keep real HTTP/undici transport while refusing every destination except the
// per-test provider. No global credentials, proxy settings, or DNS are needed.
const nativeConnect = net.Socket.prototype.connect
net.Socket.prototype.connect = function connectOnlyFixtureProvider(...args) {
  const normalized = Array.isArray(args[0]) ? args[0] : args
  const options = normalized[0]
  const host = options && typeof options === 'object' ? options.host : normalized[1]
  const port = options && typeof options === 'object' ? options.port : options
  if (host !== '127.0.0.1' || Number(port) !== allowedPort || !(allowedPort > 0)) forbidden()
  return nativeConnect.apply(this, args)
}
const nativeLookup = dns.lookup
dns.lookup = function lookupOnlyLoopback(host, ...args) {
  if (host !== '127.0.0.1') forbidden()
  return nativeLookup.call(this, host, ...args)
}
for (const name of ['connect', 'send']) dgram.Socket.prototype[name] = forbidden
syncBuiltinESMExports()
