import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  PURE_LOCAL_MODE_ENV_KEY,
  getOutboundNetworkPolicyConfiguration,
  updateOutboundNetworkPolicyConfiguration,
} from '../server/utils/runtimeEnv.js'
import {
  assertSafeOutboundUrl,
  fetchSafeOutbound,
  isPureLocalModeEnabled,
} from '../server/utils/outboundNetworkGuard.js'

const previousPureLocalMode = process.env[PURE_LOCAL_MODE_ENV_KEY]

test.after(() => {
  if (previousPureLocalMode === undefined) delete process.env[PURE_LOCAL_MODE_ENV_KEY]
  else process.env[PURE_LOCAL_MODE_ENV_KEY] = previousPureLocalMode
})

test('pure-local runtime policy defaults off and persists both toggle states atomically', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-pure-local-policy-'))
  const dataDir = path.join(cwd, 'data')
  const env = { APP_DATA_DIR: dataDir, GUGO_LOAD_DOTENV: '0' }
  delete process.env[PURE_LOCAL_MODE_ENV_KEY]
  try {
    const initial = getOutboundNetworkPolicyConfiguration({ cwd, env })
    assert.deepEqual(initial.pureLocal, { enabled: false, locked: false, source: 'default' })

    const enabled = updateOutboundNetworkPolicyConfiguration({ pureLocal: true, cwd, env })
    assert.deepEqual(enabled.pureLocal, { enabled: true, locked: false, source: 'user_config' })
    assert.equal(process.env[PURE_LOCAL_MODE_ENV_KEY], '1')
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'runtime.json'), 'utf8'))
      .env[PURE_LOCAL_MODE_ENV_KEY], '1')

    const disabled = updateOutboundNetworkPolicyConfiguration({ pureLocal: false, cwd, env })
    assert.deepEqual(disabled.pureLocal, { enabled: false, locked: false, source: 'user_config' })
    assert.equal(process.env[PURE_LOCAL_MODE_ENV_KEY], '0')
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'runtime.json'), 'utf8'))
      .env[PURE_LOCAL_MODE_ENV_KEY], '0')
    assert.equal(fs.readdirSync(dataDir).some((name) => name.endsWith('.tmp')), false)
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})

test('deployment-owned pure-local policy is readable but cannot be overridden', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-pure-local-lock-'))
  const env = { APP_DATA_DIR: path.join(cwd, 'data'), GUGO_LOAD_DOTENV: '0' }
  try {
    fs.mkdirSync(path.join(cwd, '.gugo'), { recursive: true })
    fs.writeFileSync(path.join(cwd, '.gugo', 'runtime.json'), JSON.stringify({
      env: { [PURE_LOCAL_MODE_ENV_KEY]: '1' },
    }))
    const status = getOutboundNetworkPolicyConfiguration({ cwd, env })
    assert.deepEqual(status.pureLocal, { enabled: true, locked: true, source: 'project_config' })
    assert.throws(
      () => updateOutboundNetworkPolicyConfiguration({ pureLocal: false, cwd, env }),
      (error) => error?.code === 'RUNTIME_CONFIG_LOCKED'
        && error.statusCode === 409
        && error.locks?.[0]?.key === PURE_LOCAL_MODE_ENV_KEY,
    )
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})

test('central guard keeps existing outbound behavior while pure-local mode is disabled', async () => {
  process.env[PURE_LOCAL_MODE_ENV_KEY] = '0'
  assert.equal(isPureLocalModeEnabled(), false)
  const target = await assertSafeOutboundUrl('https://93.184.216.34/resource')
  assert.equal(target.hostname, '93.184.216.34')
})

test('central guard blocks public targets in pure-local mode despite allowLocal and DNS bypass attempts', async () => {
  process.env[PURE_LOCAL_MODE_ENV_KEY] = '1'
  assert.equal(isPureLocalModeEnabled(), true)

  for (const options of [{}, { allowLocal: true }, { allowLocal: 'loopback' }]) {
    await assert.rejects(
      assertSafeOutboundUrl('https://93.184.216.34/resource', options),
      (error) => error?.code === 'OUTBOUND_PURE_LOCAL_DENIED' && error.retryable === false,
    )
  }
  await assert.rejects(
    assertSafeOutboundUrl('https://public.example.test/resource', { resolveDns: false, allowLocal: true }),
    (error) => error?.code === 'OUTBOUND_PURE_LOCAL_DENIED',
  )
  await assert.rejects(
    assertSafeOutboundUrl('https://public.example.test/resource', {
      allowLocal: true,
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    }),
    (error) => error?.code === 'OUTBOUND_PURE_LOCAL_DENIED',
  )
})

test('pure-local mode permits only explicitly allowed local targets', async () => {
  process.env[PURE_LOCAL_MODE_ENV_KEY] = '1'
  const loopback = await assertSafeOutboundUrl('http://127.0.0.1:11434/v1', { allowLocal: true })
  const lan = await assertSafeOutboundUrl('http://192.168.1.25:8080/v1', { allowLocal: true })
  assert.equal(loopback.lockedIp, '127.0.0.1')
  assert.equal(lan.lockedIp, '192.168.1.25')
  await assert.rejects(
    assertSafeOutboundUrl('http://127.0.0.1:11434/v1'),
    (error) => error?.code === 'OUTBOUND_ADDRESS_DENIED',
  )
})

test('pure-local mode revalidates redirects before a second physical request', async () => {
  process.env[PURE_LOCAL_MODE_ENV_KEY] = '1'
  const requests = []
  await assert.rejects(
    fetchSafeOutbound('http://127.0.0.1:11434/start', {}, {
      allowLocal: true,
      allowCrossOriginRedirects: true,
      fetchImpl: async (url) => {
        requests.push(url)
        return new Response(null, {
          status: 302,
          headers: { Location: 'https://93.184.216.34/escaped' },
        })
      },
      dispatcherFactory: () => null,
    }),
    (error) => error?.code === 'OUTBOUND_PURE_LOCAL_DENIED',
  )
  assert.equal(requests.length, 1)
})
