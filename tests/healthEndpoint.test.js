import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createAppServer,
  enforceLocalAuthExposurePolicy,
  getLocalAuthExposurePolicy,
  isLoopbackBindAddress,
  RUNTIME_KERNEL_REVISION,
  resolveEffectiveExposureAddress,
} from '../server/appServer.js'

test('local auth recognizes only actual loopback bind addresses', () => {
  for (const address of ['localhost', 'localhost.', '127.0.0.1', '127.255.255.254', '::1', '[::1]', '0:0:0:0:0:0:0:1']) {
    assert.equal(isLoopbackBindAddress(address), true, address)
  }
  for (const address of ['0.0.0.0', '::', '192.168.1.10', '127.0.0.1.example.com', 'localhost.example.com', '']) {
    assert.equal(isLoopbackBindAddress(address), false, address)
  }
})

test('local auth refuses non-loopback startup by default, including legacy env without AUTH_MODE', () => {
  assert.doesNotThrow(() => enforceLocalAuthExposurePolicy({ SERVER_HOST: '127.0.0.1' }))
  assert.throws(
    () => enforceLocalAuthExposurePolicy({ SERVER_HOST: '0.0.0.0' }),
    (error) => error?.code === 'INSECURE_LOCAL_AUTH_BIND',
  )
  assert.throws(
    () => enforceLocalAuthExposurePolicy({ AUTH_MODE: 'local', SERVER_HOST: '::' }),
    (error) => error?.code === 'INSECURE_LOCAL_AUTH_BIND',
  )
  assert.doesNotThrow(() => enforceLocalAuthExposurePolicy({ AUTH_MODE: 'multi_user', SERVER_HOST: '0.0.0.0' }))
})

test('insecure local auth override is explicit and always emits a high-risk warning', () => {
  const warnings = []
  const policy = enforceLocalAuthExposurePolicy({
    AUTH_MODE: 'local',
    SERVER_HOST: '0.0.0.0',
    ALLOW_INSECURE_LOCAL_AUTH: '1',
  }, { warn: (message) => warnings.push(message) })
  assert.equal(policy.allowed, true)
  assert.equal(policy.override, true)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /HIGH RISK/)
  assert.match(warnings[0], /ALLOW_INSECURE_LOCAL_AUTH=1/)
})

test('Docker local auth policy uses the published host address instead of the container listener', () => {
  const safeEnv = {
    GUGO_DOCKER: '1',
    DOCKER_BIND_ADDRESS: '127.0.0.1',
    SERVER_HOST: '0.0.0.0',
  }
  assert.equal(resolveEffectiveExposureAddress(safeEnv, safeEnv.SERVER_HOST), '127.0.0.1')
  assert.equal(getLocalAuthExposurePolicy(safeEnv, { listenerHost: safeEnv.SERVER_HOST }).exposed, false)

  const exposedEnv = { ...safeEnv, DOCKER_BIND_ADDRESS: '0.0.0.0' }
  assert.equal(getLocalAuthExposurePolicy(exposedEnv, { listenerHost: exposedEnv.SERVER_HOST }).exposed, true)
})

test('GET /api/health stays healthy while the first model is being configured', async () => {
  // 新安装不预置模型密钥，健康检查仍应允许用户打开设置页。
  const prevEnv = { ...process.env }
  delete process.env.MODEL_BASE_URL
  delete process.env.MODEL_API_KEY
  delete process.env.MODEL_NAME

  const server = createAppServer({ getEnv: () => ({}) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`)
    const body = await res.json()

    // 响应体保持精简，不能暴露数据库或模型配置细节。
    assert.equal(res.headers.get('content-type')?.includes('application/json'), true)
    assert.equal(typeof body.version, 'string', 'version 必须是字符串')
    assert.ok(body.version.length > 0, 'version 不能为空')
    assert.equal(body.kernelRevision, RUNTIME_KERNEL_REVISION)
    assert.equal(body.capabilities.localHtmlPreviewSession, 1)
    assert.equal(typeof body.time, 'number')
    assert.deepEqual(Object.keys(body).sort(), ['capabilities', 'kernelRevision', 'ok', 'time', 'version'])
    assert.equal(body.db, undefined)
    assert.equal(body.model, undefined)
    assert.equal(body.uptimeSec, undefined)

    assert.equal(body.ok, true)
    assert.equal(res.status, 200)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    process.env = prevEnv
  }
})

test('GET /api/health/full requires authentication', async () => {
  const server = createAppServer({ getEnv: () => ({}) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health/full`)
    assert.equal(res.status, 401)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
