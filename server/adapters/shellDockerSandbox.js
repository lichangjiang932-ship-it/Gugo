import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const DOCKER_IMAGE_RE = /^[a-z0-9](?:[a-z0-9._/-]*[a-z0-9])?(?::[A-Za-z0-9][A-Za-z0-9._-]{0,127}|@sha256:[a-f0-9]{64})$/u
const DOCKER_CONTAINER_NAME_RE = /^gugo-shell-[a-z0-9-]{1,48}$/u
const DOCKER_CLEANUP_TIMEOUT_MS = 10_000
const DOCKER_CLEANUP_ENV_KEYS = new Set([
  'APPDATA', 'COMSPEC', 'HOME', 'LOCALAPPDATA', 'PATH', 'PATHEXT',
  'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE', 'WINDIR',
])

function isolationError(message, code) {
  return Object.assign(new Error(message), { code, statusCode: 403, retryable: false })
}

function canonicalExecutable(value) {
  const configured = String(value || '').trim()
  if (!configured || !path.isAbsolute(configured)) {
    throw isolationError(
      'SHELL_SANDBOX_DOCKER_BIN must be an absolute Docker CLI path.',
      'SHELL_SANDBOX_DOCKER_BIN_INVALID',
    )
  }
  let executable
  try {
    executable = fs.realpathSync(configured)
    if (!fs.statSync(executable).isFile()) throw new Error('not a regular file')
    fs.accessSync(executable, fs.constants.X_OK)
  } catch {
    throw isolationError(
      'SHELL_SANDBOX_DOCKER_BIN must identify an executable regular file.',
      'SHELL_SANDBOX_DOCKER_BIN_INVALID',
    )
  }
  return executable
}

function canonicalDockerHost(value, platform = process.platform) {
  const fallback = platform === 'win32'
    ? 'npipe:////./pipe/docker_engine'
    : 'unix:///var/run/docker.sock'
  const host = String(value || fallback).trim()
  const localUnix = host.startsWith('unix:///')
    && host.length > 'unix:///'.length
    && !host.includes(String.fromCharCode(0))
    && !/[\r\n]/u.test(host)
    && !host.split('/').includes('..')
  const localWindowsPipe = /^npipe:\/\/\/\/\.\/pipe\/[A-Za-z0-9_.-]+$/u.test(host)
  if (!localUnix && !localWindowsPipe) {
    throw isolationError(
      'SHELL_SANDBOX_DOCKER_HOST must be a local unix socket or Windows named pipe.',
      'SHELL_SANDBOX_DOCKER_HOST_INVALID',
    )
  }
  return host
}

function canonicalImage(value, { requireDigest = false } = {}) {
  const image = String(value || '').trim()
  if (!DOCKER_IMAGE_RE.test(image) || /:latest$/iu.test(image)
    || (requireDigest && !/@sha256:[a-f0-9]{64}$/u.test(image))) {
    throw isolationError(
      requireDigest
        ? 'SHELL_SANDBOX_DOCKER_IMAGE must use a sha256 digest when OS isolation is required.'
        : 'SHELL_SANDBOX_DOCKER_IMAGE must use an explicit non-latest tag or sha256 digest.',
      'SHELL_SANDBOX_DOCKER_IMAGE_INVALID',
    )
  }
  return image
}

function containerWorkdir(rootPath, cwd) {
  const relative = path.relative(rootPath, cwd)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw isolationError('Shell cwd escapes the Docker sandbox mount.', 'SHELL_SANDBOX_CWD_INVALID')
  }
  return relative ? `/workspace/${relative.split(path.sep).join('/')}` : '/workspace'
}

function assertCommandUsesContainerPaths(command, rootPath) {
  const normalizedCommand = String(command).replaceAll('\\', '/')
  const normalizedRoot = String(rootPath).replaceAll('\\', '/')
  if (normalizedRoot && normalizedCommand.toLowerCase().includes(normalizedRoot.toLowerCase())) {
    throw isolationError(
      'Docker-isolated Shell commands must use /workspace-relative paths, not host absolute paths.',
      'SHELL_SANDBOX_HOST_PATH_FORBIDDEN',
    )
  }
  if (process.platform === 'win32' && /(?:^|[\s"'])\b[A-Za-z]:[\\/]/u.test(command)) {
    throw isolationError(
      'Docker-isolated Shell commands must use /workspace-relative paths, not Windows host paths.',
      'SHELL_SANDBOX_HOST_PATH_FORBIDDEN',
    )
  }
}

export function resolveDockerShellSandbox({
  command,
  cwd,
  rootPath,
  inheritedEnvKeys = [],
  env = process.env,
} = {}) {
  const mode = String(env.SHELL_SANDBOX_MODE || 'host').trim().toLowerCase()
  const isolationRequired = String(env.SHELL_REQUIRE_OS_ISOLATION || '') === '1'
  if (!['host', 'docker'].includes(mode)) {
    throw isolationError('SHELL_SANDBOX_MODE must be host or docker.', 'SHELL_SANDBOX_MODE_INVALID')
  }
  if (mode === 'host') {
    if (isolationRequired) {
      throw isolationError(
        'Host Shell is disabled because SHELL_REQUIRE_OS_ISOLATION=1.',
        'SHELL_OS_ISOLATION_REQUIRED',
      )
    }
    return null
  }

  const canonicalRoot = fs.realpathSync(rootPath || cwd)
  const canonicalCwd = fs.realpathSync(cwd)
  if (!fs.statSync(canonicalRoot).isDirectory() || !fs.statSync(canonicalCwd).isDirectory()) {
    throw isolationError('Docker sandbox root and cwd must be directories.', 'SHELL_SANDBOX_CWD_INVALID')
  }
  assertCommandUsesContainerPaths(command, canonicalRoot)
  const executable = canonicalExecutable(env.SHELL_SANDBOX_DOCKER_BIN)
  const dockerHost = canonicalDockerHost(env.SHELL_SANDBOX_DOCKER_HOST)
  const image = canonicalImage(env.SHELL_SANDBOX_DOCKER_IMAGE, {
    requireDigest: isolationRequired,
  })
  const containerName = `gugo-shell-${process.pid}-${randomBytes(8).toString('hex')}`
  const args = [
    '--host', dockerHost,
    'run', '--rm', '--init', '--pull=never', '--name', containerName,
    '--network=none', '--read-only', '--cap-drop=ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', '256', '--memory', '1g', '--cpus', '2',
    '--volume', `${canonicalRoot}:/workspace:rw`,
    '--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=256m',
    '--env', 'HOME=/tmp', '--env', 'XDG_CACHE_HOME=/tmp/.cache',
    '--workdir', containerWorkdir(canonicalRoot, canonicalCwd),
  ]
  if (typeof process.getuid === 'function' && typeof process.getgid === 'function') {
    args.push('--user', `${process.getuid()}:${process.getgid()}`)
  }
  // Pass names only. The Docker CLI inherits approved values through its
  // process environment; putting values in argv would expose secrets to host
  // process listings and audit tooling.
  for (const key of inheritedEnvKeys) args.push('--env', key)
  // Override image ENTRYPOINT as well as CMD; otherwise an audited tag change
  // or a hostile local image could run hidden startup code before the command.
  args.push('--entrypoint', '/bin/sh', image, '-lc', String(command))
  return {
    shellPath: executable,
    shellArgs: args,
    windowsVerbatimArguments: false,
    isolation: 'docker',
    image,
    dockerHost,
    containerName,
  }
}

function dockerCleanupEnv(source = process.env) {
  return Object.fromEntries(Object.entries(source).filter(([key]) => (
    DOCKER_CLEANUP_ENV_KEYS.has(String(key).toUpperCase())
  )))
}

function runDockerCleanup(executable, args, {
  spawnProcessFn = spawn,
  timeoutMs = DOCKER_CLEANUP_TIMEOUT_MS,
} = {}) {
  return new Promise((resolve) => {
    let settled = false
    let stderr = ''
    const child = spawnProcessFn(executable, args, {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: dockerCleanupEnv(),
    })
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* process may already be gone */ }
      finish({ ok: false, error: 'Docker container cleanup timed out.' })
    }, timeoutMs)
    child.stderr?.setEncoding?.('utf8')
    child.stderr?.on?.('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-2_000) })
    child.once('error', (error) => finish({ ok: false, error: error?.message || String(error) }))
    child.once('exit', (code) => {
      if (code === 0 || /No such container/iu.test(stderr)) {
        finish({ ok: true, removed: code === 0 })
      } else {
        finish({ ok: false, error: stderr.trim() || `Docker cleanup exited with code ${code}` })
      }
    })
  })
}

export async function cleanupDockerShellSandbox(sandbox, options = {}) {
  const containerName = String(sandbox?.containerName || '').trim()
  if (!DOCKER_CONTAINER_NAME_RE.test(containerName)) {
    return { ok: false, error: 'Docker sandbox cleanup identity is invalid.' }
  }
  const executable = canonicalExecutable(sandbox?.shellPath)
  const dockerHost = canonicalDockerHost(sandbox?.dockerHost)
  return runDockerCleanup(executable, [
    '--host', dockerHost, 'rm', '--force', containerName,
  ], options)
}
