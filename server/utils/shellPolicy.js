/**
 * Shell network-egress policy (opt-in hardening tier, P2 sandbox ladder).
 *
 * This is an application-level guard between the bash tripwire (bashGuard)
 * and a future OS-level sandbox. It classifies commands that open outbound
 * network connections and enforces GUGO_SHELL_NETWORK_MODE:
 *   - 'allow' (default): current behavior, nothing changes.
 *   - 'deny': every classified network invocation is rejected before spawn,
 *     with an audit trail written by the caller.
 *
 * Like the bashGuard blacklist this is not a security boundary: interpreted
 * payloads (python -c ...) can still reach the network. Its purpose is to
 * give operators an enforceable egress posture for shell tools without
 * standing up a full sandbox.
 */

const NETWORK_COMMANDS = new Set([
  'curl', 'wget', 'nc', 'ncat', 'netcat', 'socat',
  'ssh', 'scp', 'sftp', 'rsync', 'telnet', 'ftp', 'ping',
])

const GIT_NETWORK_SUBCOMMANDS = new Set(['clone', 'fetch', 'pull', 'push', 'ls-remote'])
const NPM_NETWORK_SUBCOMMANDS = new Set(['install', 'i', 'add', 'update', 'publish', 'login', 'adduser'])
const PIP_NETWORK_SUBCOMMANDS = new Set(['install', 'download', 'upload'])

const PS_NETWORK_CMDLET_RE = /\b(?:invoke-webrequest|invoke-restmethod|iwr|irm)\b/i
const SEGMENT_SPLIT_RE = /(?:\|\||&&|;|\||&|\n)/

function normalizeExecutable(token) {
  return String(token || '').toLowerCase().replace(/\.exe$/, '')
}

function splitSegments(command) {
  // Strip quoted spans so separators inside strings do not create segments.
  const masked = String(command || '').replace(/"[^"\r\n]*"|'[^'\r\n]*'/g, (value) => ' '.repeat(value.length))
  return masked.split(SEGMENT_SPLIT_RE).map((segment) => segment.trim()).filter(Boolean)
}

function tokensOf(segment) {
  return segment.match(/"[^"]*"|'[^']*'|\S+/g)?.map((token) => token.replace(/^(?:"|')|(?:"|')$/g, '')) || []
}

/**
 * Classify one command line into its network-capable invocations.
 * @returns {Array<{ kind: string, name: string }>} empty when no network use is found
 */
export function classifyShellNetworkUse(command) {
  if (typeof command !== 'string' || !command.trim()) return []
  const uses = []
  const seen = new Set()
  for (const segment of splitSegments(command)) {
    const tokens = tokensOf(segment)
    if (!tokens.length) continue
    let index = 0
    // Skip leading env assignments (FOO=bar cmd ...).
    while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) index += 1
    const executable = normalizeExecutable(tokens[index])
    const args = tokens.slice(index + 1).map((token) => token.toLowerCase())
    let entry = null
    if (NETWORK_COMMANDS.has(executable)) {
      entry = { kind: 'command', name: executable }
    } else if (executable === 'git') {
      const subcommand = String(args.find((token) => !token.startsWith('-')) || '').toLowerCase()
      if (GIT_NETWORK_SUBCOMMANDS.has(subcommand)) entry = { kind: 'git', name: `git ${subcommand}` }
    } else if (executable === 'npm' || executable === 'pnpm' || executable === 'yarn' || executable === 'bun') {
      const subcommand = String(args.find((token) => !token.startsWith('-')) || '').toLowerCase()
      if (NPM_NETWORK_SUBCOMMANDS.has(subcommand)) entry = { kind: executable, name: `${executable} ${subcommand}` }
    } else if (executable === 'pip' || executable === 'pip3') {
      const subcommand = String(args.find((token) => !token.startsWith('-')) || '').toLowerCase()
      if (PIP_NETWORK_SUBCOMMANDS.has(subcommand)) entry = { kind: executable, name: `${executable} ${subcommand}` }
    } else if (executable === 'python' || executable === 'python3') {
      const dashM = args.indexOf('-m')
      if (dashM >= 0 && normalizeExecutable(args[dashM + 1] || '') === 'pip') {
        const subcommand = String(args.slice(dashM + 2).find((token) => !token.startsWith('-')) || '').toLowerCase()
        if (PIP_NETWORK_SUBCOMMANDS.has(subcommand)) entry = { kind: executable, name: `${executable} -m pip ${subcommand}` }
      }
    }
    if (!entry && PS_NETWORK_CMDLET_RE.test(segment)) entry = { kind: 'powershell', name: 'powershell web cmdlet' }
    if (entry && !seen.has(`${entry.kind}:${entry.name}`)) {
      seen.add(`${entry.kind}:${entry.name}`)
      uses.push(entry)
    }
  }
  return uses
}

/**
 * Resolve GUGO_SHELL_NETWORK_MODE. Unknown values fall back to 'allow'.
 */
export function resolveShellNetworkMode(env = process.env) {
  const mode = String(env.GUGO_SHELL_NETWORK_MODE || '').trim().toLowerCase()
  return mode === 'deny' ? 'deny' : 'allow'
}

/**
 * @returns {null | { reason: string, code: string }} null 表示放行
 */
export function checkShellNetworkPolicy(command, env = process.env) {
  if (resolveShellNetworkMode(env) !== 'deny') return null
  const uses = classifyShellNetworkUse(command)
  if (!uses.length) return null
  return {
    code: 'SHELL_NETWORK_DENIED',
    reason: `网络策略为 deny，已拦截出网命令：${uses.map((use) => use.name).join('、')}`,
  }
}

export function describeShellPolicy(env = process.env) {
  return Object.freeze({
    networkMode: resolveShellNetworkMode(env),
  })
}
