import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-coding-tools-p1-'))
const savedEnv = {
  APP_DB_PATH: process.env.APP_DB_PATH,
  WORKSPACE_ROOT: process.env.WORKSPACE_ROOT,
  WORKSPACE_FS_ENABLED: process.env.WORKSPACE_FS_ENABLED,
  WORKSPACE_SHELL_ENABLED: process.env.WORKSPACE_SHELL_ENABLED,
  WORKSPACE_SHARED_TRUSTED: process.env.WORKSPACE_SHARED_TRUSTED,
}
process.env.APP_DB_PATH = path.join(root, 'coding-tools-p1.db')
process.env.WORKSPACE_ROOT = root
process.env.WORKSPACE_FS_ENABLED = '1'
process.env.WORKSPACE_SHELL_ENABLED = '1'
process.env.WORKSPACE_SHARED_TRUSTED = '1'

const {
  CODING_AGENT_TOOL_SPECS,
  _internals,
  dockerExecTool,
  runCommandTool,
  runTestTool,
} = await import('../server/adapters/codingAgentTools.js')

test.after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(root, { recursive: true, force: true })
})

test('download commit never overwrites an existing destination without opt-in', async () => {
  const destination = path.join(root, 'existing.bin')
  const tempPath = path.join(root, 'existing.part')
  fs.writeFileSync(destination, 'original')
  fs.writeFileSync(tempPath, 'replacement')

  await assert.rejects(
    () => _internals.commitDownloadedFile(tempPath, destination, false),
    (error) => error?.code === 'DOWNLOAD_TARGET_EXISTS' && error?.statusCode === 409,
  )

  assert.equal(fs.readFileSync(destination, 'utf8'), 'original')
  assert.equal(fs.readFileSync(tempPath, 'utf8'), 'replacement')
})

test('concurrent non-overwrite download commits have exactly one winner', async () => {
  const destination = path.join(root, 'race.bin')
  const firstTemp = path.join(root, 'race-first.part')
  const secondTemp = path.join(root, 'race-second.part')
  fs.writeFileSync(firstTemp, 'first-complete-payload')
  fs.writeFileSync(secondTemp, 'second-complete-payload')

  const settled = await Promise.allSettled([
    _internals.commitDownloadedFile(firstTemp, destination, false),
    _internals.commitDownloadedFile(secondTemp, destination, false),
  ])
  const fulfilled = settled.filter((result) => result.status === 'fulfilled')
  const rejected = settled.filter((result) => result.status === 'rejected')

  assert.equal(fulfilled.length, 1)
  assert.equal(rejected.length, 1)
  assert.equal(rejected[0].reason?.code, 'DOWNLOAD_TARGET_EXISTS')
  assert.ok([
    'first-complete-payload',
    'second-complete-payload',
  ].includes(fs.readFileSync(destination, 'utf8')))
})

test('overwrite download commit atomically replaces the destination without backups', async () => {
  const destination = path.join(root, 'replace.bin')
  const tempPath = path.join(root, 'replace.part')
  fs.writeFileSync(destination, 'old-payload')
  fs.writeFileSync(tempPath, 'new-complete-payload')

  await _internals.commitDownloadedFile(tempPath, destination, true)

  assert.equal(fs.readFileSync(destination, 'utf8'), 'new-complete-payload')
  assert.equal(fs.existsSync(tempPath), false)
  assert.deepEqual(
    fs.readdirSync(root).filter((name) => name.includes('.gugo-backup-')),
    [],
  )
})

test('Docker CLI discovery checks PATH and standard Docker Desktop locations', () => {
  const windowsPathCandidate = 'C:\\Tools\\docker.exe'
  assert.equal(_internals.findDockerCli({
    env: { PATH: 'C:\\Tools;C:\\Windows' },
    platform: 'win32',
    isExecutable: (candidate) => candidate === windowsPathCandidate,
  }), 'docker')

  const desktopCandidate = 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe'
  assert.equal(_internals.findDockerCli({
    env: { PATH: '', ProgramFiles: 'C:\\Program Files' },
    platform: 'win32',
    isExecutable: (candidate) => candidate === desktopCandidate,
  }), desktopCandidate)
})

test('docker_exec reports DOCKER_NOT_AVAILABLE before attempting execution', async () => {
  const result = await dockerExecTool({
    container: 'missing-docker-test',
    command: ['echo', 'hello'],
    cwd: root,
  }, {
    findDockerCliImpl: () => null,
  })

  assert.equal(result.ok, false)
  assert.equal(result.exitCode, null)
  assert.equal(result.code, 'DOCKER_NOT_AVAILABLE')
  assert.match(result.hint, /Docker/)
})

test('docker_exec turns a standard install outside PATH into an actionable availability result', async () => {
  const detectedPath = 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe'
  const result = await dockerExecTool({
    container: 'docker-not-on-path-test',
    command: ['echo', 'hello'],
    cwd: root,
  }, {
    findDockerCliImpl: () => detectedPath,
    platform: 'win32',
  })

  assert.equal(result.ok, false)
  assert.equal(result.code, 'DOCKER_NOT_AVAILABLE')
  assert.equal(result.detectedPath, detectedPath)
  assert.match(result.hint, /PATH/)
})

test('Windows Docker command leaves fixed tokens unquoted and defaults strings to Linux shell', () => {
  const command = _internals.dockerCommand({
    dockerCli: 'docker',
    container: 'dev-container_1',
    command: 'python -V && npm -v',
    workdir: '/workspace with space',
    env: { MODE: 'test&verify' },
    platform: 'win32',
  })

  assert.equal(command[0], '"')
  assert.equal(command.at(-1), '"')
  const commandLine = command.slice(1, -1)
  assert.match(commandLine, /^docker exec /)
  assert.doesNotMatch(commandLine, /^"docker" "exec"/)
  assert.match(commandLine, /\/bin\/sh -lc "python -V && npm -v"$/)
  assert.match(commandLine, /-w "\/workspace with space"/)
  assert.match(commandLine, /-e "MODE=test&verify"/)
})

test('Docker command arrays remain exact argv and container_os selects Windows shell only for strings', () => {
  const exactArgv = _internals.dockerCommand({
    container: 'dev',
    command: ['python', '-c', 'print(42)'],
    containerOs: 'windows',
    platform: 'win32',
  })
  assert.equal(exactArgv[0], '"')
  assert.equal(exactArgv.at(-1), '"')
  const exactArgvLine = exactArgv.slice(1, -1)
  assert.doesNotMatch(exactArgvLine, /(?:\/bin\/sh|cmd\.exe)/)
  assert.match(exactArgvLine, /dev "python" "-c" "print\(42\)"$/)

  const windowsShell = _internals.dockerCommand({
    container: 'dev',
    command: 'dir && echo ok',
    containerOs: 'windows',
    platform: 'win32',
  })
  assert.equal(windowsShell[0], '"')
  assert.equal(windowsShell.at(-1), '"')
  assert.match(windowsShell.slice(1, -1), /cmd\.exe \/d \/s \/c "dir && echo ok"$/)
})

test('coding command schemas expose env_keys as names-only high-risk credential forwarding', () => {
  const byName = new Map(CODING_AGENT_TOOL_SPECS.map((spec) => [spec.function.name, spec.function]))
  for (const name of ['run_command', 'run_test', 'docker_exec']) {
    const tool = byName.get(name)
    assert.ok(tool, `missing ${name} spec`)
    assert.deepEqual(tool.parameters.properties.env_keys.type, 'array')
    assert.equal(tool.parameters.properties.env_keys.uniqueItems, true)
    assert.equal(tool.parameters.properties.env_keys.items.type, 'string')
    assert.equal(tool.parameters.properties.env_keys.items.pattern, '^[A-Za-z_][A-Za-z0-9_]*$')
    assert.equal(tool.parameters.properties.env_keys.maxItems, 32)
    assert.match(tool.parameters.properties.env_keys.description, /high-risk approval/i)
    assert.match(tool.parameters.properties.env_keys.description, /names only|pass names only/i)
    assert.match(tool.function?.description || tool.description, /high-risk approval/i)
  }
  assert.ok(byName.get('docker_exec').parameters.properties.env)
  assert.match(byName.get('docker_exec').description, /separate/i)
})

test('run_command and run_test forward requested sensitive host variables without returning values', async () => {
  const commandKey = 'GUGO_P1_COMMAND_TOKEN'
  const testKey = 'GUGO_P1_TEST_SECRET'
  const commandValue = 'command-value-must-not-leak'
  const testValue = 'test-value-must-not-leak'
  const commandProbe = path.join(root, 'command-env-probe.cjs')
  const testProbe = path.join(root, 'test-env-probe.cjs')
  fs.writeFileSync(
    commandProbe,
    `process.stdout.write(process.env.${commandKey} ? 'COMMAND_HOST_ENV_PRESENT:' + process.env.${commandKey} : 'COMMAND_HOST_ENV_MISSING')\n`,
    'utf8',
  )
  fs.writeFileSync(
    testProbe,
    `process.stdout.write(process.env.${testKey} ? 'TEST_HOST_ENV_PRESENT:' + process.env.${testKey} : 'TEST_HOST_ENV_MISSING')\n`,
    'utf8',
  )
  process.env[commandKey] = commandValue
  process.env[testKey] = testValue
  try {
    const commandResult = await runCommandTool({
      command: `node ${path.basename(commandProbe)}`,
      cwd: root,
      env_keys: [commandKey],
    })
    const testResult = await runTestTool({
      command: `node ${path.basename(testProbe)}`,
      framework: 'custom',
      cwd: root,
      env_keys: [testKey],
    })

    assert.equal(commandResult.ok, true, JSON.stringify(commandResult))
    assert.match(commandResult.stdout, /COMMAND_HOST_ENV_PRESENT/)
    assert.equal(testResult.passed, true, JSON.stringify(testResult))
    assert.match(testResult.stdout, /TEST_HOST_ENV_PRESENT/)
    assert.doesNotMatch(JSON.stringify(commandResult), new RegExp(commandValue))
    assert.doesNotMatch(JSON.stringify(testResult), new RegExp(testValue))
  } finally {
    delete process.env[commandKey]
    delete process.env[testKey]
  }
})

test('docker_exec forwards env_keys to the host CLI while keeping container env separate', async () => {
  const key = 'GUGO_P1_DOCKER_TOKEN'
  const value = 'docker-value-must-not-leak'
  const fakeDocker = path.join(root, process.platform === 'win32' ? 'p1 fake docker.cmd' : 'p1 fake docker')
  if (process.platform === 'win32') {
    fs.writeFileSync(
      fakeDocker,
      `@echo off\r\nif defined ${key} (echo DOCKER_HOST_ENV_PRESENT:%${key}%& exit /b 0)\r\necho DOCKER_HOST_ENV_MISSING\r\nexit /b 9\r\n`,
      'utf8',
    )
  } else {
    fs.writeFileSync(
      fakeDocker,
      `#!/bin/sh\nif [ -n "$${key}" ]; then echo "DOCKER_HOST_ENV_PRESENT:$${key}"; exit 0; fi\necho DOCKER_HOST_ENV_MISSING\nexit 9\n`,
      'utf8',
    )
    fs.chmodSync(fakeDocker, 0o755)
  }
  process.env[key] = value
  try {
    const result = await dockerExecTool({
      container: 'host-env-probe',
      command: ['echo', 'inside'],
      env: { CONTAINER_VISIBLE: 'plain-value' },
      env_keys: [key],
      cwd: root,
    }, {
      findDockerCliImpl: () => fakeDocker,
    })

    assert.equal(result.ok, true, JSON.stringify(result))
    assert.match(result.stdout, /DOCKER_HOST_ENV_PRESENT/)
    assert.doesNotMatch(JSON.stringify(result), new RegExp(value))
  } finally {
    delete process.env[key]
  }
})
