import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'

import { sanitizeChildEnv } from '../utils/sensitiveEnv.js'

export const INTERRUPT_GRACE_MS = 5_000
export const MARKER_PREFIX = '__GOGO_END__:'

export function pathKey(value) {
  const normalized = path.normalize(path.resolve(value))
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

export function sameOrInside(rootPath, candidatePath) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath))
  return relative === ''
    || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function shellQuote(value) {
  const escaped = String(value).replaceAll("'", "'\"'\"'")
  return `'${escaped}'`
}

export function commandToken() {
  return randomBytes(8).toString('hex')
}

export function buildShellPayload(command, ephemeralEnv, token) {
  const prefix = `__gugo_${token}`
  const lines = []
  const cleanup = [`${prefix}_code`, `${prefix}_cwd`]
  let index = 0
  for (const [key, value] of Object.entries(ephemeralEnv || {})) {
    const setName = `${prefix}_set_${index}`
    const valueName = `${prefix}_value_${index}`
    cleanup.push(setName, valueName)
    lines.push(`${setName}=\${${key}+x}`)
    lines.push(`${valueName}=\${${key}-}`)
    lines.push(`export ${key}=${shellQuote(value)}`)
    index += 1
  }
  lines.push('{')
  lines.push(command)
  lines.push('} </dev/null')
  lines.push(`${prefix}_code=$?`)
  lines.push(`${prefix}_cwd=$(pwd -P 2>/dev/null || printf '%s' "$PWD")`)

  index = 0
  for (const key of Object.keys(ephemeralEnv || {})) {
    const setName = `${prefix}_set_${index}`
    const valueName = `${prefix}_value_${index}`
    lines.push(`if [ "$${setName}" = x ]; then export ${key}="$${valueName}"; else unset ${key}; fi`)
    index += 1
  }
  lines.push(
    `printf '\\n${MARKER_PREFIX}${token}:%s:%s\\n' "$${prefix}_code" "$${prefix}_cwd"; unset ${cleanup.join(' ')}`,
  )
  return `${lines.join('\n')}\n`
}

function powerShellPath() {
  const systemRoot = String(process.env.SystemRoot || process.env.WINDIR || '').trim()
  return systemRoot
    ? `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    : 'powershell.exe'
}

function signalWindowsDescendants(rootPid, force) {
  const script = [
    `$root=${Math.max(1, Number(rootPid) || 1)}`,
    '$rows=@(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)',
    '$ids=New-Object System.Collections.Generic.HashSet[int]',
    '$null=$ids.Add([int]$root)',
    'do { $changed=$false; foreach($row in $rows) { if($ids.Contains([int]$row.ParentProcessId) -and $ids.Add([int]$row.ProcessId)) { $changed=$true } } } while($changed)',
    '$targets=@($ids | Where-Object { $_ -ne $root } | Sort-Object -Descending)',
    `$targets | ForEach-Object { Stop-Process -Id $_ ${force ? '-Force ' : ''}-ErrorAction SilentlyContinue }`,
  ].join('; ')
  try {
    const helper = spawn(powerShellPath(), [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      script,
    ], { env: sanitizeChildEnv(), windowsHide: true, stdio: 'ignore' })
    helper.unref()
  } catch { /* best-effort */ }
}

function readPosixProcessTable() {
  return new Promise((resolve) => {
    execFile('ps', ['-eo', 'pid=,ppid='], {
      env: sanitizeChildEnv(),
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
      timeout: 2_000,
    }, (error, stdout) => {
      if (error) {
        resolve([])
        return
      }
      resolve(String(stdout || '').split(/\r?\n/).map((line) => {
        const match = line.trim().match(/^(\d+)\s+(\d+)$/)
        return match ? { pid: Number(match[1]), parentPid: Number(match[2]) } : null
      }).filter(Boolean))
    })
  })
}

async function signalPosixDescendants(rootPid, signal) {
  const rows = await readPosixProcessTable()
  const tracked = new Set([rootPid])
  let changed = true
  while (changed) {
    changed = false
    for (const row of rows) {
      if (tracked.has(row.parentPid) && !tracked.has(row.pid)) {
        tracked.add(row.pid)
        changed = true
      }
    }
  }
  const targets = rows.filter((row) => tracked.has(row.pid) && row.pid !== rootPid).reverse()
  for (const row of targets) {
    try { process.kill(row.pid, signal) } catch { /* already gone */ }
  }
  return targets.length > 0
}

export function signalDescendants(child, signal) {
  if (!child?.pid) return Promise.resolve(false)
  if (process.platform === 'win32') {
    signalWindowsDescendants(child.pid, signal === 'SIGKILL')
    return Promise.resolve(true)
  }
  return signalPosixDescendants(child.pid, signal)
}

export function hardKillProcessTree(child) {
  if (!child?.pid) return
  try {
    if (process.platform === 'win32') {
      try {
        spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
          env: sanitizeChildEnv(),
          windowsHide: true,
          stdio: 'ignore',
        }).unref()
      } catch { /* taskkill unavailable */ }
      child.kill('SIGKILL')
      return
    }
    try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
  } catch { /* already gone */ }
}

export function setChildReferenced(child, referenced) {
  if (!child) return
  const method = referenced ? 'ref' : 'unref'
  child[method]?.()
  const streams = new Set([
    child.stdin,
    child.stdout,
    child.stderr,
    ...(Array.isArray(child.stdio) ? child.stdio : []),
  ])
  for (const stream of streams) stream?.[method]?.()
}

export function softCloseProcessTree(child) {
  if (!child?.pid) return
  if (process.platform === 'win32') {
    signalWindowsDescendants(child.pid, false)
    try { child.kill('SIGTERM') } catch { /* already gone */ }
    return
  }
  try { process.kill(-child.pid, 'SIGTERM') } catch {
    try { child.kill('SIGTERM') } catch { /* already gone */ }
  }
}
