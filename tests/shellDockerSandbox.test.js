import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import '../scripts/testEnvironment.mjs'
import { closeDb, createUser } from '../server/db.js'
import { bashExecTool } from '../server/adapters/fsShellExecution.js'
import {
  cleanupDockerShellSandbox,
  resolveDockerShellSandbox,
} from '../server/adapters/shellDockerSandbox.js'
import { grantLocalPath } from '../server/services/localFileAccessService.js'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-shell-docker-'))
const cwd = path.join(root, 'project')
const dockerBin = path.join(root, process.platform === 'win32' ? 'docker.exe' : 'docker')
const userId = 'shell-docker-owner'
const dockerImage = `node@sha256:${'a'.repeat(64)}`
fs.mkdirSync(cwd)
fs.writeFileSync(dockerBin, 'fixture')
if (process.platform !== 'win32') fs.chmodSync(dockerBin, 0o755)
createUser({ id: userId, email: 'shell-docker@example.test' })
grantLocalPath({ userId, rootPath: root, accessMode: 'read_write' })

const ENV_KEYS = [
  'LOCAL_CODE_EXECUTION_ENABLED',
  'SHELL_REQUIRE_OS_ISOLATION',
  'SHELL_SANDBOX_DOCKER_BIN',
  'SHELL_SANDBOX_DOCKER_IMAGE',
  'SHELL_SANDBOX_DOCKER_HOST',
  'SHELL_SANDBOX_MODE',
  'CI_CUSTOM_VALUE',
]
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))

function configureDockerSandbox() {
  process.env.LOCAL_CODE_EXECUTION_ENABLED = '1'
  process.env.SHELL_SANDBOX_MODE = 'docker'
  process.env.SHELL_REQUIRE_OS_ISOLATION = '1'
  process.env.SHELL_SANDBOX_DOCKER_BIN = dockerBin
  process.env.SHELL_SANDBOX_DOCKER_IMAGE = dockerImage
  process.env.SHELL_SANDBOX_DOCKER_HOST = process.platform === 'win32'
    ? 'npipe:////./pipe/docker_engine'
    : 'unix:///var/run/docker.sock'
  process.env.CI_CUSTOM_VALUE = 'private-value-not-for-argv'
}

test.afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key]
    else process.env[key] = originalEnv[key]
  }
})

test.after(() => {
  closeDb()
  fs.rmSync(root, { recursive: true, force: true })
})

test('Docker shell sandbox builds a fixed no-network least-privilege invocation without secret argv values', () => {
  configureDockerSandbox()
  const result = resolveDockerShellSandbox({
    command: 'node ./scripts/check.mjs',
    cwd,
    rootPath: root,
    inheritedEnvKeys: ['CI_CUSTOM_VALUE'],
  })
  assert.equal(result.shellPath, fs.realpathSync(dockerBin))
  assert.equal(result.isolation, 'docker')
  assert.equal(result.image, dockerImage)
  assert.equal(result.dockerHost, process.env.SHELL_SANDBOX_DOCKER_HOST)
  assert.match(result.containerName, /^gugo-shell-[a-z0-9-]+$/u)
  assert.deepEqual(result.shellArgs.slice(0, 3), [
    '--host', process.env.SHELL_SANDBOX_DOCKER_HOST, 'run',
  ])
  for (const required of [
    '--pull=never', '--network=none', '--read-only', '--cap-drop=ALL',
    'no-new-privileges', '--pids-limit', '--memory', '--cpus', '--tmpfs', '--workdir', '--entrypoint',
  ]) assert.ok(result.shellArgs.includes(required), required)
  assert.ok(result.shellArgs.includes(`${fs.realpathSync(root)}:/workspace:rw`))
  assert.equal(result.shellArgs[result.shellArgs.indexOf('--name') + 1], result.containerName)
  assert.ok(result.shellArgs.includes('/workspace/project'))
  assert.equal(result.shellArgs.at(-5), '--entrypoint')
  assert.equal(result.shellArgs.at(-4), '/bin/sh')
  assert.equal(result.shellArgs.at(-3), dockerImage)
  assert.equal(result.shellArgs.at(-2), '-lc')
  assert.equal(result.shellArgs.at(-1), 'node ./scripts/check.mjs')
  const envIndex = result.shellArgs.indexOf('CI_CUSTOM_VALUE')
  assert.equal(result.shellArgs[envIndex - 1], '--env')
  assert.equal(result.shellArgs.some((arg) => arg.includes('private-value-not-for-argv')), false)
})

test('Docker cleanup targets only the generated container through the same local daemon', async () => {
  configureDockerSandbox()
  const sandbox = resolveDockerShellSandbox({
    command: 'printf ok',
    cwd,
    rootPath: root,
  })
  const calls = []
  const result = await cleanupDockerShellSandbox(sandbox, {
    spawnProcessFn(executable, args, options) {
      calls.push({ executable, args, options })
      const child = new EventEmitter()
      child.stderr = new PassThrough()
      child.kill = () => true
      queueMicrotask(() => {
        child.stderr.end()
        child.emit('exit', 0)
      })
      return child
    },
  })
  assert.deepEqual(result, { ok: true, removed: true })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].executable, fs.realpathSync(dockerBin))
  assert.deepEqual(calls[0].args, [
    '--host', process.env.SHELL_SANDBOX_DOCKER_HOST,
    'rm', '--force', sandbox.containerName,
  ])
  assert.equal(calls[0].options.shell, undefined)
  assert.equal(JSON.stringify(calls[0]).includes('private-value-not-for-argv'), false)

  assert.deepEqual(await cleanupDockerShellSandbox({
    ...sandbox,
    containerName: 'foreign-container',
  }), { ok: false, error: 'Docker sandbox cleanup identity is invalid.' })
})

test('Docker isolation fails closed for host mode, floating images, invalid binaries, and host paths', () => {
  assert.throws(() => resolveDockerShellSandbox({
    command: 'node -v', cwd, rootPath: root,
    env: { SHELL_SANDBOX_MODE: 'host', SHELL_REQUIRE_OS_ISOLATION: '1' },
  }), { code: 'SHELL_OS_ISOLATION_REQUIRED' })

  const base = {
    SHELL_SANDBOX_MODE: 'docker',
    SHELL_REQUIRE_OS_ISOLATION: '1',
    SHELL_SANDBOX_DOCKER_BIN: dockerBin,
    SHELL_SANDBOX_DOCKER_IMAGE: 'node:latest',
  }
  assert.throws(() => resolveDockerShellSandbox({
    command: 'node -v', cwd, rootPath: root, env: base,
  }), { code: 'SHELL_SANDBOX_DOCKER_IMAGE_INVALID' })
  assert.throws(() => resolveDockerShellSandbox({
    command: 'node -v', cwd, rootPath: root,
    env: { ...base, SHELL_SANDBOX_DOCKER_IMAGE: 'node:22-alpine' },
  }), { code: 'SHELL_SANDBOX_DOCKER_IMAGE_INVALID' })
  assert.throws(() => resolveDockerShellSandbox({
    command: 'node -v', cwd, rootPath: root,
    env: { ...base, SHELL_SANDBOX_DOCKER_IMAGE: dockerImage, SHELL_SANDBOX_DOCKER_BIN: 'docker' },
  }), { code: 'SHELL_SANDBOX_DOCKER_BIN_INVALID' })
  assert.throws(() => resolveDockerShellSandbox({
    command: 'node -v', cwd, rootPath: root,
    env: {
      ...base, SHELL_SANDBOX_DOCKER_IMAGE: dockerImage,
      SHELL_SANDBOX_DOCKER_HOST: 'tcp://127.0.0.1:2375',
    },
  }), { code: 'SHELL_SANDBOX_DOCKER_HOST_INVALID' })
  assert.throws(() => resolveDockerShellSandbox({
    command: `node "${path.join(root, 'host-script.mjs')}"`, cwd, rootPath: root,
    env: { ...base, SHELL_SANDBOX_DOCKER_IMAGE: dockerImage },
  }), { code: 'SHELL_SANDBOX_HOST_PATH_FORBIDDEN' })
})

test('bash_exec uses the Docker sandbox invocation and reports isolation without running a host shell', async () => {
  configureDockerSandbox()
  let invocation = null
  const result = await bashExecTool({
    command: 'node -e "process.stdout.write(\'ok\')"',
    cwd,
    env_keys: ['CI_CUSTOM_VALUE'],
    userId,
  }, {
    runProcessWithGroupFn: async (options) => {
      invocation = options
      return { code: 0, signal: null, stdout: 'ok', stderr: '', truncated: false }
    },
    cleanupDockerShellSandboxFn: async () => assert.fail('successful --rm execution needs no cleanup call'),
  })
  assert.equal(result.ok, true)
  assert.equal(result.isolation, 'docker')
  assert.equal(invocation.shellPath, fs.realpathSync(dockerBin))
  assert.equal(invocation.windowsVerbatimArguments, false)
  assert.equal(invocation.shellArgs.at(-1), 'node -e "process.stdout.write(\'ok\')"')
  assert.equal(invocation.shellArgs.some((arg) => arg.includes('private-value-not-for-argv')), false)
  assert.equal(invocation.env.CI_CUSTOM_VALUE, 'private-value-not-for-argv')
})

test('bash_exec explicitly cleans interrupted Docker containers and fails closed when cleanup fails', async () => {
  configureDockerSandbox()
  let cleanedSandbox = null
  const cancelled = await bashExecTool({
    command: 'sleep 30',
    cwd,
    userId,
  }, {
    runProcessWithGroupFn: async () => ({
      code: null, signal: 'SIGKILL', stdout: '', stderr: '', truncated: false,
      aborted: true, killed: true, timedOut: false,
    }),
    cleanupDockerShellSandboxFn: async (sandbox) => {
      cleanedSandbox = sandbox
      return { ok: true, removed: true }
    },
  })
  assert.equal(cancelled.ok, false)
  assert.equal(cancelled.cancelled, true)
  assert.equal(cancelled.isolation, 'docker')
  assert.match(cleanedSandbox.containerName, /^gugo-shell-[a-z0-9-]+$/u)

  const cleanupFailure = await bashExecTool({
    command: 'sleep 30',
    cwd,
    userId,
  }, {
    runProcessWithGroupFn: async () => ({
      code: null, signal: 'SIGKILL', stdout: '', stderr: '', truncated: false,
      aborted: true, killed: true, timedOut: false,
    }),
    cleanupDockerShellSandboxFn: async () => ({ ok: false, error: 'daemon cleanup unavailable' }),
  })
  assert.equal(cleanupFailure.ok, false)
  assert.equal(cleanupFailure.code, 'PROCESS_TREE_CLEANUP_FAILED')
  assert.equal(cleanupFailure.processTreeCleanupFailed, true)
  assert.equal(cleanupFailure.systemFailure, true)
})
