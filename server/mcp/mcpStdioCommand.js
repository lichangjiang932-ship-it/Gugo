import { readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'

function commandError(code, message) {
  return Object.assign(new Error(message), { code, retryable: false })
}

function isFile(file) {
  try { return statSync(file).isFile() } catch { return false }
}

function packageName(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')).name } catch { return null }
}

function validateCommand(command, args) {
  if (typeof command !== 'string' || !command.trim() || command !== command.trim()
    || /\p{Cc}/u.test(command) || command.includes('"')) {
    throw commandError('MCP_STDIO_COMMAND_INVALID', 'MCP command must be one executable name or an absolute path, without shell quoting.')
  }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
    throw commandError('MCP_STDIO_ARGUMENTS_INVALID', 'MCP args must be an array of literal strings without NUL bytes.')
  }
}

function canonicalFile(file, io) {
  if (!io.isFile(file)) return null
  try { return path.win32.normalize(io.realpath(file)) } catch { return null }
}

function inside(directory, candidate) {
  const relative = path.win32.relative(directory, candidate)
  return relative === '' || (!relative.startsWith('..\\') && relative !== '..' && !path.win32.isAbsolute(relative))
}

function trustedSearchRoots(sourceEnv, cwd) {
  const raw = Object.entries(sourceEnv || {}).find(([key]) => key.toUpperCase() === 'PATH')?.[1]
  return [...new Set(String(raw || '').split(';').map((entry) => entry.trim().replace(/^"|"$/gu, '')))]
    .filter((entry) => path.win32.isAbsolute(entry) && !inside(cwd, entry))
    .slice(0, 128)
}

function nativeExecutable(command, { executablePath, roots, io, cwd }) {
  if (/^node(?:\.exe)?$/iu.test(command)) {
    const nativeNode = canonicalFile(executablePath, io)
    // Desktop's process.execPath can be Gugo/Electron.exe. Runtime injection
    // flags remain filtered: use a real local node.exe, never launch another GUI.
    if (nativeNode && /^node\.exe$/iu.test(path.win32.basename(nativeNode))) return nativeNode
  }
  const explicit = path.win32.isAbsolute(command)
  const extension = path.win32.extname(command)
  if (extension && extension.toLowerCase() !== '.exe') {
    throw commandError('MCP_STDIO_COMMAND_UNSUPPORTED', 'Windows MCP requires a native .exe, or the standard npm/npx CLI. Arbitrary batch and PowerShell shims are not executed.')
  }
  if (!explicit && path.win32.basename(command) !== command) {
    throw commandError('MCP_STDIO_COMMAND_INVALID', 'Relative executable paths are not supported; explicitly allowlist an absolute executable path.')
  }
  const name = extension ? command : `${command}.exe`
  const candidates = explicit ? [name] : roots.map((root) => path.win32.join(root, name))
  for (const candidate of candidates) {
    const file = canonicalFile(candidate, io)
    if (file && /\.exe$/iu.test(file) && (explicit || !inside(cwd, file))) return file
  }
  throw commandError('MCP_STDIO_EXECUTABLE_NOT_FOUND', 'The allowlisted MCP executable was not found in the host PATH. Install it locally or configure an explicitly allowlisted absolute .exe path.')
}

function npmCli(command, cliName, { roots, executablePath, io, cwd }) {
  const explicit = path.win32.isAbsolute(command)
  if (explicit && !canonicalFile(command, io)) {
    throw commandError('MCP_STDIO_EXECUTABLE_NOT_FOUND', 'The explicitly configured npm/npx launcher was not found.')
  }
  const search = explicit ? [path.win32.dirname(command)] : [path.win32.dirname(executablePath), ...roots]
  for (const root of search) {
    const packageRoot = path.win32.join(root, 'node_modules', 'npm')
    if (io.packageName(path.win32.join(packageRoot, 'package.json')) !== 'npm') continue
    const cli = canonicalFile(path.win32.join(packageRoot, 'bin', `${cliName}-cli.js`), io)
    if (!cli) continue
    let canonicalRoot
    try { canonicalRoot = io.realpath(packageRoot) } catch { continue }
    if (!explicit && root !== path.win32.dirname(executablePath) && inside(cwd, canonicalRoot)) continue
    if (inside(canonicalRoot, cli)) return cli
  }
  throw commandError('MCP_STDIO_NPM_CLI_NOT_FOUND', 'A trusted local npm installation was not found. Install npm alongside Node.js; MCP never runs .cmd through a shell or installs npm automatically.')
}

/** Resolve only Windows launch mechanics. Bootstrap still authorizes the original command. */
export function resolveMcpStdioCommand({ command, args = [] }, {
  platform = process.platform, executablePath = process.execPath, sourceEnv = process.env,
  cwd = process.cwd(), isFileFn = isFile, realpathFn = realpathSync, packageNameFn = packageName,
} = {}) {
  validateCommand(command, args)
  if (platform !== 'win32') return { command, args: [...args] }
  const io = { isFile: isFileFn, realpath: realpathFn, packageName: packageNameFn }
  const roots = trustedSearchRoots(sourceEnv, cwd)
  const options = { executablePath, roots, io, cwd }
  const base = path.win32.basename(command)
  const npm = /^(npm|npx)(?:\.cmd)?$/iu.exec(base)
  if (npm) {
    if (base !== command && !path.win32.isAbsolute(command)) {
      throw commandError('MCP_STDIO_COMMAND_INVALID', 'npm/npx launcher paths must be absolute and explicitly allowlisted.')
    }
    const nodeExecutable = nativeExecutable('node', options)
    const cli = npmCli(command, npm[1].toLowerCase(), { ...options, executablePath: nodeExecutable })
    return { command: nodeExecutable, args: [cli, ...args] }
  }
  return { command: nativeExecutable(command, options), args: [...args] }
}
