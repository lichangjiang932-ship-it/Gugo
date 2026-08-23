import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  isProtectedExecutionEnvKey,
  isRuntimeInjectionEnvKey,
  isSensitiveEnvKey,
  sanitizeChildEnv,
} from '../server/utils/sensitiveEnv.js'

test('isSensitiveEnvKey: explicit deny list', () => {
  assert.equal(isSensitiveEnvKey('MODEL_API_KEY'), true)
  assert.equal(isSensitiveEnvKey('openai_api_key'), true, 'key matching must be case-insensitive')
  assert.equal(isSensitiveEnvKey('NODE_OPTIONS'), true)
  assert.equal(isSensitiveEnvKey('LD_PRELOAD'), true)
  assert.equal(isSensitiveEnvKey('LD_AUDIT'), true)
  assert.equal(isSensitiveEnvKey('DYLD_INSERT_LIBRARIES'), true)
  assert.equal(isSensitiveEnvKey('DYLD_PRINT_TO_FILE'), true)
  assert.equal(isSensitiveEnvKey('PYTHONPATH'), true)
  assert.equal(isSensitiveEnvKey('OPENAI_API_KEY'), true)
  assert.equal(isSensitiveEnvKey('ANTHROPIC_API_KEY'), true)
  assert.equal(isSensitiveEnvKey('GITHUB_TOKEN'), true)
  assert.equal(isSensitiveEnvKey('MAIL_PASSWORD'), true)
  assert.equal(isSensitiveEnvKey('AWS_ACCESS_KEY_ID'), true)
})

test('isSensitiveEnvKey: suffix-based catch-all', () => {
  // 新 provider 不用改代码就能挡住
  assert.equal(isSensitiveEnvKey('XAI_API_KEY'), true)
  assert.equal(isSensitiveEnvKey('FUTURE_PROVIDER_API_KEY'), true)
  assert.equal(isSensitiveEnvKey('REDIS_PASSWORD'), true)
  assert.equal(isSensitiveEnvKey('STRIPE_SECRET'), true)
  assert.equal(isSensitiveEnvKey('SLACK_TOKEN'), true)
  assert.equal(isSensitiveEnvKey('VAULT_CREDENTIALS'), true)
  assert.equal(isSensitiveEnvKey('SSH_PRIVATE_KEY'), true)
  assert.equal(isSensitiveEnvKey('CUSTOM_SIGNING_KEY'), true)
})

test('isSensitiveEnvKey: harmless keys pass', () => {
  assert.equal(isSensitiveEnvKey('PATH'), false)
  assert.equal(isSensitiveEnvKey('HOME'), false)
  assert.equal(isSensitiveEnvKey('LANG'), false)
  assert.equal(isSensitiveEnvKey('NODE_ENV'), false)
  assert.equal(isSensitiveEnvKey('USER'), false)
  // suffix 必须真的在末尾
  assert.equal(isSensitiveEnvKey('MY_TOKEN_ISSUER'), false)
  assert.equal(isSensitiveEnvKey('PASSWORD_RULES'), false)
})

test('isSensitiveEnvKey: edge cases', () => {
  assert.equal(isSensitiveEnvKey(''), false)
  assert.equal(isSensitiveEnvKey(null), false)
  assert.equal(isSensitiveEnvKey(undefined), false)
  assert.equal(isSensitiveEnvKey(123), false)
  assert.equal(isSensitiveEnvKey('_API_KEY'), true)
  assert.equal(isSensitiveEnvKey('_TOKEN'), true)
})

test('sanitizeChildEnv: strips sensitive process.env', () => {
  const originals = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    XAI_API_KEY: process.env.XAI_API_KEY,
    HOME: process.env.HOME,
  }
  process.env.OPENAI_API_KEY = 'sk-real-key'
  process.env.XAI_API_KEY = 'xai-real'
  try {
    const env = sanitizeChildEnv()
    assert.equal(env.OPENAI_API_KEY, undefined)
    assert.equal(env.XAI_API_KEY, undefined)
    assert.ok(env.HOME != null || env.PATH != null || env.Path != null, 'should keep harmless env')
  } finally {
    if (originals.OPENAI_API_KEY == null) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = originals.OPENAI_API_KEY
    if (originals.XAI_API_KEY == null) delete process.env.XAI_API_KEY
    else process.env.XAI_API_KEY = originals.XAI_API_KEY
  }
})

test('sanitizeChildEnv: extra may add safe keys but cannot inject secrets', () => {
  const env = sanitizeChildEnv({ MY_FLAG: '1', OPENAI_API_KEY: 'sneaky' })
  assert.equal(env.MY_FLAG, '1')
  assert.equal(env.OPENAI_API_KEY, undefined, 'extra must also be filtered')
})

test('sanitizeChildEnv: skips null/undefined values', () => {
  const env = sanitizeChildEnv({ A: null, B: undefined, C: 'ok' })
  assert.equal(env.A, undefined)
  assert.equal(env.B, undefined)
  assert.equal(env.C, 'ok')
})

test('sanitizeChildEnv: scrubs credentials and runtime injection from an explicit source env', () => {
  const env = sanitizeChildEnv({}, {
    sourceEnv: {
      PATH: '/safe/bin',
      SAFE_FLAG: '1',
      OPENAI_API_KEY: 'model-secret',
      node_options: '--require attacker.js',
      LD_PRELOAD: '/tmp/attacker.so',
      PYTHONPATH: '/tmp/attacker-python',
    },
  })
  assert.equal(env.PATH, '/safe/bin')
  assert.equal(env.SAFE_FLAG, '1')
  assert.equal(env.OPENAI_API_KEY, undefined)
  assert.equal(env.node_options, undefined)
  assert.equal(env.LD_PRELOAD, undefined)
  assert.equal(env.PYTHONPATH, undefined)
})

test('sanitizeChildEnv: explicitly inherits operational credentials but never service or runtime injection values', () => {
  const previousGhToken = process.env.GH_TOKEN
  const previousOpenAiKey = process.env.OPENAI_API_KEY
  const previousNodeOptions = process.env.NODE_OPTIONS
  const previousLdAudit = process.env.LD_AUDIT
  process.env.GH_TOKEN = 'github-operational-secret'
  process.env.OPENAI_API_KEY = 'service-model-secret'
  process.env.NODE_OPTIONS = '--require attacker.js'
  process.env.LD_AUDIT = '/tmp/attacker.so'
  try {
    const env = sanitizeChildEnv({}, {
      inheritKeys: ['GH_TOKEN', 'OPENAI_API_KEY', 'NODE_OPTIONS', 'LD_AUDIT'],
    })
    assert.equal(env.GH_TOKEN, 'github-operational-secret')
    assert.equal(env.OPENAI_API_KEY, undefined)
    assert.equal(env.NODE_OPTIONS, undefined)
    assert.equal(env.LD_AUDIT, undefined)
    assert.equal(isProtectedExecutionEnvKey('OPENAI_API_KEY'), true)
    assert.equal(isProtectedExecutionEnvKey('GH_TOKEN'), false)
    assert.equal(isProtectedExecutionEnvKey('NODE_OPTIONS'), true)
    assert.equal(isProtectedExecutionEnvKey('LD_AUDIT'), true)
  } finally {
    if (previousGhToken == null) delete process.env.GH_TOKEN
    else process.env.GH_TOKEN = previousGhToken
    if (previousOpenAiKey == null) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousOpenAiKey
    if (previousNodeOptions == null) delete process.env.NODE_OPTIONS
    else process.env.NODE_OPTIONS = previousNodeOptions
    if (previousLdAudit == null) delete process.env.LD_AUDIT
    else process.env.LD_AUDIT = previousLdAudit
  }
})

test('sanitizeChildEnv: an explicit extra allowlist restores isolated credentials but never startup injection', () => {
  const env = sanitizeChildEnv({
    SAFE_FLAG: 'configured',
    GITHUB_TOKEN: 'mcp-specific-token',
    OPENAI_API_KEY: 'mcp-specific-model-key',
    NODE_OPTIONS: '--require attacker.js',
    LD_PRELOAD: '/tmp/attacker.so',
    GIT_ASKPASS: '/tmp/attacker-askpass',
  }, {
    allowExtraKeys: [
      'GITHUB_TOKEN',
      'OPENAI_API_KEY',
      'NODE_OPTIONS',
      'LD_PRELOAD',
      'GIT_ASKPASS',
    ],
    sourceEnv: {
      PATH: '/safe/bin',
      GITHUB_TOKEN: 'host-token-must-not-win',
    },
  })

  assert.equal(env.PATH, '/safe/bin')
  assert.equal(env.SAFE_FLAG, 'configured')
  assert.equal(env.GITHUB_TOKEN, 'mcp-specific-token')
  assert.equal(env.OPENAI_API_KEY, 'mcp-specific-model-key')
  assert.equal(env.NODE_OPTIONS, undefined)
  assert.equal(env.LD_PRELOAD, undefined)
  assert.equal(env.GIT_ASKPASS, undefined)
  assert.equal(isRuntimeInjectionEnvKey('node_options'), true)
  assert.equal(isRuntimeInjectionEnvKey('dyld_insert_libraries'), true)
  assert.equal(isRuntimeInjectionEnvKey('git_askpass'), true)
  assert.equal(isRuntimeInjectionEnvKey('PATH'), false)
})

test('sanitizeChildEnv: Windows keys are case-insensitive while POSIX keys remain distinct', () => {
  const sourceEnv = { Path: 'C:\\Windows', PATH: 'C:\\tools', GH_TOKEN: 'host-token' }
  const extra = { path: 'C:\\configured', gh_token: 'configured-token' }

  const windowsEnv = sanitizeChildEnv(extra, {
    allowExtraKeys: ['GH_TOKEN'],
    platform: 'win32',
    sourceEnv,
  })
  assert.deepEqual(
    Object.keys(windowsEnv).filter((key) => key.toLowerCase() === 'path'),
    ['path'],
  )
  assert.equal(windowsEnv.path, 'C:\\configured')
  assert.equal(windowsEnv.gh_token, 'configured-token')

  const posixEnv = sanitizeChildEnv(extra, {
    allowExtraKeys: ['gh_token'],
    platform: 'linux',
    sourceEnv,
  })
  assert.equal(posixEnv.Path, 'C:\\Windows')
  assert.equal(posixEnv.PATH, 'C:\\tools')
  assert.equal(posixEnv.path, 'C:\\configured')
  assert.equal(posixEnv.gh_token, 'configured-token')
})

test('sanitizeChildEnv: the returned object is safe for a real Node child process', () => {
  const hostSecretKey = 'GUGO_SANITIZE_HOST_TOKEN'
  const configuredSecretKey = 'GUGO_SANITIZE_CONFIGURED_TOKEN'
  const env = sanitizeChildEnv({
    [configuredSecretKey]: 'configured-secret',
    NODE_OPTIONS: '--definitely-invalid-gugo-option',
  }, {
    allowExtraKeys: [configuredSecretKey, 'NODE_OPTIONS'],
    sourceEnv: {
      ...process.env,
      [hostSecretKey]: 'host-secret',
    },
  })
  const result = spawnSync(process.execPath, ['-e', [
    `const result = {`,
    `  host: process.env.${hostSecretKey} || null,`,
    `  configured: process.env.${configuredSecretKey} || null,`,
    `  nodeOptions: process.env.NODE_OPTIONS || null,`,
    `}`,
    `process.stdout.write(JSON.stringify(result))`,
  ].join('\n')], {
    encoding: 'utf8',
    env,
    windowsHide: true,
  })

  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), {
    host: null,
    configured: 'configured-secret',
    nodeOptions: null,
  })
})
