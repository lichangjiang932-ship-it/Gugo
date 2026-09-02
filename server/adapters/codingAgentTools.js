import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

import {
  bashExecTool,
  resolveForFileTool,
  resolveForShellCwd,
  writeFileTool,
} from './fsShellTools.js'
import { dispatchApplyPatchTool } from '../utils/applyPatch.js'
import { projectVerificationFields } from '../utils/processExecutionFailure.js'
import { fileDownloadTool, codingAgentDownloadInternals } from './codingAgentDownload.js'
import {
  DEFAULT_DOCKER_TIMEOUT_MS,
  DEFAULT_TEST_TIMEOUT_MS,
  MAX_DOCKER_TIMEOUT_MS,
  MAX_TEST_TIMEOUT_MS,
  assertToolPermitted,
  clampInteger,
  quoteCommandArg,
  redactForwardedEnvValues,
  toolError,
} from './codingAgentToolSupport.js'

export { CODING_AGENT_TOOL_SPECS } from './codingAgentToolSpecs.js'
export { fileDownloadTool } from './codingAgentDownload.js'

function inferTestCommand(cwd, requestedFramework = 'auto') {
  const framework = String(requestedFramework || 'auto').trim().toLowerCase()
  const exists = (name) => fs.existsSync(path.join(cwd, name))
  const packageJsonPath = path.join(cwd, 'package.json')
  let packageJson = null
  if (exists('package.json')) {
    try { packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) } catch { /* invalid package.json is reported by the runner */ }
  }

  if (framework === 'npm' || (framework === 'auto' && packageJson?.scripts?.test)) {
    return { framework: 'npm', command: 'npm test' }
  }
  if (framework === 'pytest' || (framework === 'auto' && [
    'pytest.ini', 'pyproject.toml', 'setup.cfg', 'tox.ini', 'requirements.txt',
  ].some(exists))) {
    return { framework: 'pytest', command: 'python -m pytest' }
  }
  if (framework === 'cargo' || (framework === 'auto' && exists('Cargo.toml'))) {
    return { framework: 'cargo', command: 'cargo test' }
  }
  if (framework === 'go' || (framework === 'auto' && exists('go.mod'))) {
    return { framework: 'go', command: 'go test ./...' }
  }
  if (framework === 'maven' || (framework === 'auto' && exists('pom.xml'))) {
    return { framework: 'maven', command: 'mvn test' }
  }
  if (framework === 'gradle' || (framework === 'auto' && (exists('gradlew') || exists('gradlew.bat') || exists('build.gradle')))) {
    const wrapper = process.platform === 'win32' && exists('gradlew.bat')
      ? 'gradlew.bat'
      : (exists('gradlew') ? './gradlew' : 'gradle')
    return { framework: 'gradle', command: `${wrapper} test` }
  }
  if (framework !== 'auto') {
    throw toolError(`不支持的测试框架: ${framework}`, 400, 'TEST_FRAMEWORK_UNSUPPORTED')
  }
  throw toolError(
    '无法自动识别测试框架；请传入 command，或指定 npm/pytest/cargo/go/maven/gradle。',
    400,
    'TEST_FRAMEWORK_NOT_DETECTED',
  )
}

export async function runCommandTool({
  command,
  cmd,
  cwd,
  timeout_ms,
  expected_outputs = [],
  env_keys = [],
  userId = null,
  signal = null,
} = {}) {
  assertToolPermitted(userId, 'run_command')
  const selected = typeof command === 'string' && command.trim()
    ? command.trim()
    : (typeof cmd === 'string' ? cmd.trim() : '')
  if (!selected) throw toolError('command 必填', 400, 'COMMAND_REQUIRED')
  const result = await bashExecTool({
    command: selected,
    cwd,
    timeout_ms,
    expected_outputs,
    env_keys,
    userId,
    signal,
  }, {
    permissionToolName: 'run_command',
  })
  return redactForwardedEnvValues(result, env_keys)
}

function normalizeLinePatch(text, { startLine, endLine, replacement }) {
  const original = String(text)
  const eol = original.includes('\r\n') ? '\r\n' : '\n'
  const hadTrailingEol = /\r?\n$/u.test(original)
  const normalized = original.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  if (hadTrailingEol) lines.pop()
  const start = Number(startLine)
  const end = Number(endLine)
  if (!Number.isInteger(start) || start < 1 || start > lines.length + 1) {
    throw toolError(`start_line 必须在 1 到 ${lines.length + 1} 之间`, 400, 'PATCH_LINE_RANGE_INVALID')
  }
  if (!Number.isInteger(end) || end < start - 1 || end > lines.length) {
    throw toolError(`end_line 必须在 ${start - 1} 到 ${lines.length} 之间`, 400, 'PATCH_LINE_RANGE_INVALID')
  }
  if (typeof replacement !== 'string') {
    throw toolError('replacement 必须是字符串', 400, 'PATCH_REPLACEMENT_INVALID')
  }
  const replacementNormalized = replacement.replace(/\r\n/g, '\n')
  const replacementLines = replacementNormalized === '' ? [] : replacementNormalized.split('\n')
  if (replacementLines.at(-1) === '') replacementLines.pop()
  const nextLines = [
    ...lines.slice(0, start - 1),
    ...replacementLines,
    ...lines.slice(end),
  ]
  return `${nextLines.join(eol)}${hadTrailingEol ? eol : ''}`
}

export async function patchFileTool({
  patch,
  dry_run = false,
  path: rawPath,
  start_line,
  end_line,
  replacement,
  expected_sha256,
  userId = null,
} = {}) {
  assertToolPermitted(userId, 'patch_file')
  if (typeof patch === 'string' && patch.trim()) {
    return dispatchApplyPatchTool('apply_patch', { patch, dry_run }, { userId })
  }
  const resolved = resolveForFileTool(rawPath, { userId, write: true })
  const stat = fs.statSync(resolved.fullPath)
  if (!stat.isFile()) throw toolError('path 必须是普通文件', 400, 'PATCH_FILE_REQUIRED')
  const original = fs.readFileSync(resolved.fullPath, 'utf8')
  const digest = createHash('sha256').update(original).digest('hex')
  const expected = String(expected_sha256 || '').trim().toLowerCase()
  if (expected && !/^[0-9a-f]{64}$/u.test(expected)) {
    throw toolError('expected_sha256 必须是 64 位十六进制字符串', 400, 'PATCH_CHECKSUM_INVALID')
  }
  if (expected && digest !== expected) {
    throw toolError('文件已在读取后发生变化或版本不匹配，请重新读取后再修改', 409, 'PATCH_FILE_CHANGED')
  }
  const next = normalizeLinePatch(original, {
    startLine: start_line,
    endLine: end_line,
    replacement,
  })
  if (next === original) throw toolError('patch_file 没有产生任何变化', 400, 'PATCH_NO_CHANGES')
  if (dry_run === true) {
    return {
      ok: true,
      dryRun: true,
      path: resolved.displayPath,
      scope: resolved.source,
      beforeSha256: digest,
      afterSha256: createHash('sha256').update(next).digest('hex'),
      replacedLines: Math.max(0, Number(end_line) - Number(start_line) + 1),
      replacementLines: replacement === '' ? 0 : replacement.replace(/\r\n/g, '\n').split('\n').filter((line, index, all) => index < all.length - 1 || line !== '').length,
    }
  }
  const result = await writeFileTool({
    path: resolved.fullPath,
    content: next,
    userId,
  }, {
    permissionToolName: 'patch_file',
  })
  return {
    ...result,
    beforeSha256: digest,
    afterSha256: createHash('sha256').update(next).digest('hex'),
  }
}

function parseTestSummary(stdout, stderr) {
  const text = `${stdout || ''}\n${stderr || ''}`
  const summary = {}
  const node = text.match(/# tests\s+(\d+)[\s\S]*?# pass\s+(\d+)[\s\S]*?# fail\s+(\d+)/iu)
  const pytestPassed = text.match(/\b(\d+) passed\b/iu)
  const pytestFailed = text.match(/\b(\d+) failed\b/iu)
  const pytestSkipped = text.match(/\b(\d+) skipped\b/iu)
  const coverage = text.match(/(?:All files|TOTAL)\s*\|?\s*(\d+(?:\.\d+)?)%?/iu)
  if (node) {
    summary.total = Number(node[1])
    summary.passed = Number(node[2])
    summary.failed = Number(node[3])
  } else if (pytestPassed || pytestFailed || pytestSkipped) {
    summary.passed = Number(pytestPassed?.[1] || 0)
    summary.failed = Number(pytestFailed?.[1] || 0)
    summary.skipped = Number(pytestSkipped?.[1] || 0)
    summary.total = summary.passed + summary.failed + summary.skipped
  }
  if (coverage) summary.coveragePercent = Number(coverage[1])
  return summary
}

export async function runTestTool({
  command,
  framework = 'auto',
  cwd: rawCwd,
  timeout_ms,
  env_keys = [],
  userId = null,
  signal = null,
} = {}) {
  assertToolPermitted(userId, 'run_test')
  const resolved = resolveForShellCwd(rawCwd, { userId })
  if (!fs.statSync(resolved.fullPath).isDirectory()) {
    throw toolError('cwd 必须是目录', 400, 'TEST_CWD_NOT_DIRECTORY')
  }
  const selected = typeof command === 'string' && command.trim()
    ? { framework: String(framework || 'custom'), command: command.trim() }
    : inferTestCommand(resolved.fullPath, framework)
  const timeout = clampInteger(timeout_ms, DEFAULT_TEST_TIMEOUT_MS, 1000, MAX_TEST_TIMEOUT_MS)
  const result = await bashExecTool({
    command: selected.command,
    cwd: resolved.fullPath,
    timeout_ms: timeout,
    expected_outputs: [],
    env_keys,
    userId,
    signal,
  }, {
    permissionToolName: 'run_test',
  })
  const safeResult = redactForwardedEnvValues(result, env_keys)
  return {
    ...safeResult,
    ...projectVerificationFields(result),
    framework: selected.framework,
    command: selected.command,
    summary: parseTestSummary(result.stdout, result.stderr),
  }
}

function executableFile(candidate, platform = process.platform) {
  try {
    if (!fs.statSync(candidate).isFile()) return false
    if (platform !== 'win32') fs.accessSync(candidate, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

function findDockerCli({
  env: sourceEnv = process.env,
  platform = process.platform,
  isExecutable = (candidate) => executableFile(candidate, platform),
} = {}) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  const pathValue = String(sourceEnv.PATH || sourceEnv.Path || sourceEnv.path || '')
  const pathEntries = pathValue
    .split(pathApi.delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ''))
    .filter(Boolean)
  const executableNames = platform === 'win32'
    ? ['docker.exe', 'docker.cmd', 'docker.bat', 'docker.com']
    : ['docker']
  for (const directory of pathEntries) {
    for (const name of executableNames) {
      if (isExecutable(pathApi.join(directory, name))) return 'docker'
    }
  }

  if (platform !== 'win32') return null
  const programDirectories = [
    sourceEnv.ProgramFiles,
    sourceEnv.ProgramW6432,
    sourceEnv['ProgramFiles(x86)'],
  ].filter(Boolean)
  const commonCandidates = [
    ...programDirectories.map((directory) => pathApi.join(
      directory,
      'Docker',
      'Docker',
      'resources',
      'bin',
      'docker.exe',
    )),
    sourceEnv.ProgramData
      ? pathApi.join(sourceEnv.ProgramData, 'DockerDesktop', 'version-bin', 'docker.exe')
      : null,
  ].filter(Boolean)
  return commonCandidates.find((candidate) => isExecutable(candidate)) || null
}

function dockerCommand({
  dockerCli = 'docker',
  container,
  command,
  workdir,
  env = {},
  containerOs = 'linux',
  platform = process.platform,
}) {
  const name = String(container || '').trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(name)) {
    throw toolError('container 必须是有效的 Docker 容器名或 ID', 400, 'DOCKER_CONTAINER_INVALID')
  }
  const normalizedContainerOs = String(containerOs || 'linux').trim().toLowerCase()
  if (!['linux', 'windows'].includes(normalizedContainerOs)) {
    throw toolError('container_os 必须是 linux 或 windows', 400, 'DOCKER_CONTAINER_OS_INVALID')
  }
  const executable = String(dockerCli || '').trim()
  if (!executable) throw toolError('Docker CLI 不可用', 503, 'DOCKER_NOT_AVAILABLE')
  const fixed = (value) => (/^[A-Za-z0-9_.:/\\-]+$/u.test(value)
    ? value
    : quoteCommandArg(value, platform))
  const argv = [fixed(executable), 'exec']
  if (workdir) argv.push('-w', quoteCommandArg(String(workdir), platform))
  for (const [key, value] of Object.entries(env || {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
      throw toolError(`无效的 Docker 环境变量名: ${key}`, 400, 'DOCKER_ENV_INVALID')
    }
    argv.push('-e', quoteCommandArg(`${key}=${String(value)}`, platform))
  }
  argv.push(name)
  if (Array.isArray(command)) {
    if (!command.length || command.some((value) => typeof value !== 'string' || !value)) {
      throw toolError('command 数组必须包含非空字符串', 400, 'DOCKER_COMMAND_INVALID')
    }
    argv.push(...command.map((value) => quoteCommandArg(value, platform)))
  } else if (typeof command === 'string' && command.trim()) {
    if (normalizedContainerOs === 'windows') {
      argv.push('cmd.exe', '/d', '/s', '/c', quoteCommandArg(command.trim(), platform))
    } else {
      argv.push('/bin/sh', '-lc', quoteCommandArg(command.trim(), platform))
    }
  } else {
    throw toolError('command 必填', 400, 'DOCKER_COMMAND_REQUIRED')
  }
  const commandLine = argv.join(' ')
  // cmd.exe /s /c strips the first and last quote from its command string.
  // Keep one outer pair so quoted executables (for example Docker Desktop
  // under Program Files) and quoted trailing arguments survive that pass.
  return platform === 'win32' ? `"${commandLine}"` : commandLine
}

export async function dockerExecTool({
  container,
  command,
  workdir,
  env,
  container_os = 'linux',
  env_keys = [],
  cwd: rawCwd,
  timeout_ms,
  expected_outputs = [],
  userId = null,
  signal = null,
} = {}, {
  findDockerCliImpl = findDockerCli,
  platform = process.platform,
} = {}) {
  assertToolPermitted(userId, 'docker_exec')
  const dockerCli = findDockerCliImpl({ platform })
  if (!dockerCli) {
    return {
      ok: false,
      exitCode: null,
      stdout: '',
      stderr: '未检测到 Docker CLI。',
      code: 'DOCKER_NOT_AVAILABLE',
      hint: '请安装 Docker Desktop/Engine，并确保 docker CLI 位于 PATH 或标准安装目录。',
    }
  }
  if (dockerCli !== 'docker') {
    try {
      resolveForFileTool(dockerCli, { userId, write: false })
    } catch {
      const pathApi = platform === 'win32' ? path.win32 : path.posix
      return {
        ok: false,
        exitCode: null,
        stdout: '',
        stderr: '已检测到 Docker CLI，但其目录不在 PATH 或当前授权范围中。',
        code: 'DOCKER_NOT_AVAILABLE',
        detectedPath: dockerCli,
        hint: `请将 ${pathApi.dirname(dockerCli)} 加入 PATH 后重试。`,
      }
    }
  }
  const timeout = clampInteger(timeout_ms, DEFAULT_DOCKER_TIMEOUT_MS, 1000, MAX_DOCKER_TIMEOUT_MS)
  const result = await bashExecTool({
    command: dockerCommand({
      dockerCli,
      container,
      command,
      workdir,
      env,
      containerOs: container_os,
      platform,
    }),
    cwd: rawCwd,
    timeout_ms: timeout,
    expected_outputs,
    env_keys,
    userId,
    signal,
  }, {
    permissionToolName: 'docker_exec',
  })
  const safeResult = redactForwardedEnvValues(result, env_keys)
  if (result.ok === false && /(?:not recognized|not found|ENOENT).*docker|docker.*(?:not recognized|not found)/iu.test(`${result.stderr}\n${result.error}`)) {
    return {
      ...safeResult,
      code: 'DOCKER_NOT_AVAILABLE',
      hint: '请安装并启动 Docker Desktop/Engine；工具会在下一次调用时自动复用系统 docker CLI。',
    }
  }
  return { ...safeResult, container: String(container || '').trim() }
}

export async function dispatchCodingAgentTool(name, args = {}, context = {}) {
  switch (name) {
    case 'run_command': return runCommandTool({ ...args, userId: context.userId, signal: context.signal })
    case 'patch_file': return patchFileTool({ ...args, userId: context.userId })
    case 'run_test': return runTestTool({ ...args, userId: context.userId, signal: context.signal })
    case 'docker_exec': return dockerExecTool({ ...args, userId: context.userId, signal: context.signal })
    case 'file_download': return fileDownloadTool(args, context)
    default: throw toolError(`未知 coding 工具: ${name}`, 404, 'CODING_TOOL_NOT_FOUND')
  }
}

export const _internals = {
  inferTestCommand,
  parseTestSummary,
  normalizeLinePatch,
  redactForwardedEnvValues,
  dockerCommand,
  findDockerCli,
  ...codingAgentDownloadInternals,
}
