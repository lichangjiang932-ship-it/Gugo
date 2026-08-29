/**
 * bash_exec 危险命令拦截器。
 *
 * ⚠ 安全边界声明(C-P1.3):
 *   这个黑名单**不是安全边界**,只是"防手滑 / 防 prompt-injection 一行 payload"的护栏。
 *   它无法挡住有意绕过:变量拼接(`R=-rf; rm $R /`)、编码执行(`base64 -d | sh`)、
 *   解释器外泄(`python3 -c "..."`)、命令替换(`$(printf '\x72\x6d')`)等都能平凡绕过——
 *   黑名单注定补不全,不要把它当成沙箱。
 *
 *   真正的信任模型是:**开启 `WORKSPACE_SHELL_ENABLED=1` ≡ 完全信任能调用该接口的用户。**
 *   该用户能在 server 进程权限下执行任意命令。若不信任用户,就不要开这个 env;
 *   需要给不可信用户开 shell,必须上 OS 级隔离(容器 / nsjail / seccomp),而不是靠本文件。
 *   启动期会由 warnShellTrust() 打一条醒目 warn 提醒运维这一点。
 *
 * 设计原则:
 *   - 黑名单而非白名单(白名单会过严,影响正常 dev 体验)
 *   - 命中 → throw,带可读理由,记审计(由 caller 写 denied)
 *   - 不解析 shell AST(代价过大),用保守的字面 + 正则匹配
 *   - 误杀宁可严,正常 dev 命令不会触发(rm -rf node_modules 是允许的,只挡根目录类绝对路径)
 *   - 2026-08 增补覆盖:base64 编码执行、下载中转管道、PowerShell iwr|irm|iex 与
 *     -enc、eval 包裹远程下载、/dev/tcp 反向连接、nc -e。仍是字面正则,
 *     变量拼接等间接绕过依旧不设防——本文件不是沙箱。
 */

const FORK_BOMB_RE = /:\(\)\s*\{[^}]*:\|:[^}]*\}[^}]*:/  // :(){:|:&};:
// rm -rf 加 原子路径:`/` 只有 后接空白/行末/管道 才算 "根目录"，避免误伤 /tmp/...
const RM_ROOT_RE = /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f?|-[a-zA-Z]*f[a-zA-Z]*r?|--recursive\b[^|;&]*--force\b|--force\b[^|;&]*--recursive\b)\s+(\/(?:\s|$|\*|\||;|&)|~(?:\s|$|\/)|\$HOME\b|\/etc\b|\/usr\b|\/var\b|\/bin\b|\/sbin\b|\/boot\b|\/root\b|\/home(?:\s|$|\/\s|\/\*))/
const RM_NO_PRESERVE_RE = /\brm\s[^|;&]*--no-preserve-root\b/
const DD_DEVICE_RE = /\bdd\s+[^|;&]*of=\/dev\/(sd[a-z]|nvme|hd[a-z]|mmcblk)/
const MKFS_RE = /\bmkfs(\.\w+)?\s+\/dev\//
const FORMAT_RE = /\bformat\s+[a-z]:/i
const CURL_PIPE_SH_RE = /\b(curl|wget)\s[^|;&]*\|\s*(sudo\s+)?(sh|bash|zsh|fish|python3?|node|ruby|perl)\b/
const CHMOD_777_ROOT_RE = /\bchmod\s+-R\s+777\s+(\/|~|\$HOME|\/etc|\/usr|\/var)/
// SSH/AWS 私钥外泄:id_xxx 后面不能跟字母数字也不能跟 .pub(避免贪婪回溯让 id_rsa.pub 也命中)
const SSH_KEY_EXFIL_RE = /\b(cat|less|more|head|tail|xxd|base64|od)\s[^|;&]*(\.ssh\/id_[a-z0-9]+(?![a-z0-9.])|\.aws\/credentials|\.gnupg\/[a-z]*sec|\.docker\/config\.json)/
// env exfil:只拦"导到文件"或"管道到出口命令"，不拦 env | grep 这种本地过滤
const ENV_EXFIL_RE = /\b(env|printenv|set)\s*(>|>>|\|\s*(curl|wget|nc|ncat|socat|ssh|scp|rsync|bash|sh|zsh|python|node|ruby|perl|telnet))/
const WINDOWS_DEVICE_PATH_RE = /(?:^|[\s"'=,(])\\\\(?:[.?]\\|globalroot\\)/i
// A tilde expands a home directory only when it starts a shell token. Without
// that boundary, valid Windows 8.3 path segments such as RUNNER~1 are mistaken
// for `~user` expansion before literal absolute-path authorization can run.
const HOME_EXPANSION_RE = /(?:^|[\s"'=,(;|&<>])~(?:[\\/]|[A-Za-z0-9_-]+[\\/])/i
const DYNAMIC_PATH_RE = /(?:%[^%\r\n]+%[\\/]|\$env:[A-Za-z_][A-Za-z0-9_]*[\\/]|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?[\\/])/i
const PARENT_PATH_RE = /(?:^|[\\/\s"'=,(])\.\.(?:[\\/\s"'),;]|$)/
const UNQUOTED_WINDOWS_PAREN_PATH_RE = /(?:^|[\s=,(])((?:[A-Za-z]:[\\/]|\\\\)[^\s"'<>|;&,]*\([^()\s"'<>|;&,]*\)(?=[^\s"'<>|;&,)])[^\s"'<>|;&,]*)/i

// ---- 2026-08 增补:常见绕过形态(C-P1.3 仍是护栏而非沙箱) ----
// base64 解码结果直接管道进解释器(cat x.b64 | base64 -d | sh)
const BASE64_DECODE_PIPE_RE = /\bbase64\s+(?:-{1,2}[a-zA-Z]*d[a-zA-Z]*|--decode)\b[^|;&]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|fish|dash|ksh|python3?|node|perl|ruby|powershell|pwsh)\b/
// 下载管道隔一段再执行(curl url | base64 -d | bash);终点必须是解释器才算高危
const DOWNLOAD_PIPE_INTERP_RE = /\b(?:curl|wget)\b[^|;&]*\|\s*[^|;&]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|fish|dash|ksh|python3?|node|perl|ruby|iex)\b/i
// PowerShell 下载并执行经典形态(iwr url | iex / irm url | iex)
const PS_DOWNLOAD_IEX_RE = /\b(?:iwr|irm|invoke-webrequest|invoke-restmethod)\b[^|;&]*\|\s*(?:iex|invoke-expression)\b/i
// powershell -enc / -EncodedCommand(整段编码指令,无法预检内容)
const PS_ENCODED_COMMAND_RE = /\bpowershell(?:\.exe)?\b[^;&|]*\s-(?:enc(?:odedcommand)?|ec)\b/i
// eval "$(curl/wget ...)":把远程脚本包进当前 shell 执行
const EVAL_REMOTE_DOWNLOAD_RE = /\beval\s*"?\s*\$\([^)]*(?:curl|wget|iwr|irm)\b/i
// /dev/tcp、/dev/udp 反向连接(bash 内建,黑名单外唯一出口)
const DEV_SOCKET_RE = /[\\/]dev\/(?:tcp|udp)[\\/]/
// nc -e 直接反弹 shell
const NC_EXEC_RE = /\bnc(?:at)?\b[^;&|]*\s-e\b/

const RULES = [
  { re: FORK_BOMB_RE, reason: 'fork bomb' },
  { re: RM_ROOT_RE, reason: '递归删除系统/家目录' },
  { re: RM_NO_PRESERVE_RE, reason: 'rm --no-preserve-root 被禁' },
  { re: DD_DEVICE_RE, reason: 'dd 写入块设备' },
  { re: MKFS_RE, reason: 'mkfs 格式化块设备' },
  { re: FORMAT_RE, reason: 'format 格式化盘符' },
  { re: CURL_PIPE_SH_RE, reason: '从网络管道直接 sh/bash(供应链风险)' },
  { re: CHMOD_777_ROOT_RE, reason: '递归 chmod 777 系统目录' },
  { re: SSH_KEY_EXFIL_RE, reason: '读取 SSH/AWS/GPG 私钥' },
  { re: ENV_EXFIL_RE, reason: '导出 env 到外部(可能泄露密钥)' },
  { re: BASE64_DECODE_PIPE_RE, reason: 'base64 解码后管道进解释器(编码执行)' },
  { re: DOWNLOAD_PIPE_INTERP_RE, reason: '下载经中转管道进入解释器(供应链风险)' },
  { re: PS_DOWNLOAD_IEX_RE, reason: 'PowerShell 下载即执行(iwr/irm | iex)' },
  { re: PS_ENCODED_COMMAND_RE, reason: 'powershell 编码指令(-enc)被禁' },
  { re: EVAL_REMOTE_DOWNLOAD_RE, reason: 'eval 包裹远程下载脚本' },
  { re: DEV_SOCKET_RE, reason: '/dev/tcp 或 /dev/udp 反向连接' },
  { re: NC_EXEC_RE, reason: 'nc -e 反弹 shell' },
]

const SIMPLE_READ_COMMANDS = new Set([
  'pwd', 'ls', 'dir', 'tree', 'cat', 'type', 'head', 'tail', 'wc', 'stat', 'file',
  'du', 'df', 'where', 'which', 'whoami', 'uname', 'echo',
])
const GIT_READ_SUBCOMMANDS = new Set(['status', 'diff', 'log', 'show', 'blame', 'grep', 'rev-parse', 'ls-files', 'ls-tree'])
const NPM_READ_SUBCOMMANDS = new Set(['list', 'ls', 'view', 'outdated', 'why', 'explain'])
const SHELL_META_RE = /[;&|><`\r\n]|\$\(/
const GIT_WRITE_OR_EXEC_OPTIONS = new Set([
  '--output', '--ext-diff', '--textconv', '--open-files-in-pager',
])

function tokenTargetsOutsideWorkspace(token) {
  const source = String(token || '')
  const values = [source]
  const equalsAt = source.indexOf('=')
  if (equalsAt >= 0) values.push(source.slice(equalsAt + 1))
  return values.some((value) => (
    /^(?:~(?:[\\/]|$)|[a-zA-Z]:[\\/]|[\\/])/.test(value)
    || /(^|[\\/])\.\.(?:[\\/]|$)/.test(value)
    || /^(?:\$[A-Za-z_][A-Za-z0-9_]*|%[^%]+%)(?:[\\/]|$)/.test(value)
  ))
}

function hasGitWriteOrExecOption(tokens) {
  return tokens.slice(2).some((token) => {
    if (token === '-O' || token.startsWith('-O')) return true
    const normalized = String(token).toLowerCase()
    return GIT_WRITE_OR_EXEC_OPTIONS.has(normalized)
      || [...GIT_WRITE_OR_EXEC_OPTIONS].some((option) => normalized.startsWith(`${option}=`))
  })
}

/**
 * Conservative command-level read-only classifier. This is an approval UX
 * hint, not a sandbox: anything ambiguous remains exec/high-risk.
 */
export function isReadOnlyShellCommand(command) {
  if (typeof command !== 'string') return false
  const source = command.trim()
  if (!source || SHELL_META_RE.test(source)) return false
  const tokens = source.match(/"[^"]*"|'[^']*'|\S+/g)?.map((token) => token.replace(/^(?:"|')|(?:"|')$/g, '')) || []
  if (!tokens.length || tokens.some(tokenTargetsOutsideWorkspace)) return false
  const executable = String(tokens[0]).toLowerCase().replace(/\.exe$/, '')
  if (SIMPLE_READ_COMMANDS.has(executable)) {
    if (executable === 'file' && tokens.slice(1).some((token) => token === '-C' || token === '--compile')) return false
    return true
  }
  if (executable === 'date' || executable === 'hostname') {
    return tokens.length === 1 || (tokens.length === 2 && ['--help', '--version'].includes(tokens[1]))
  }
  if (executable === 'rg') return !tokens.some((token) => token === '--pre' || token.startsWith('--pre='))
  if (executable === 'git') {
    if (tokens.length === 2 && tokens[1] === '--version') return true
    return GIT_READ_SUBCOMMANDS.has(String(tokens[1] || '').toLowerCase()) && !hasGitWriteOrExecOption(tokens)
  }
  if (executable === 'npm') {
    if (tokens.length === 2 && ['--version', '-v'].includes(tokens[1])) return true
    return NPM_READ_SUBCOMMANDS.has(String(tokens[1] || '').toLowerCase())
  }
  if (['node', 'python', 'python3', 'ruby', 'perl'].includes(executable)) {
    return tokens.length === 2 && ['--version', '-v', '-V'].includes(tokens[1])
  }
  return false
}

/**
 * @returns {null | { reason: string }} null 表示放行
 */
export function checkBashCommandDanger(command) {
  if (typeof command !== 'string') return null
  // 折叠多空白,但保留原文做正则匹配
  const trimmed = command.trim()
  if (!trimmed) return null
  for (const rule of RULES) {
    if (rule.re.test(trimmed)) return { reason: rule.reason }
  }
  return null
}

function cleanPathCandidate(value, { quoted = false } = {}) {
  const candidate = String(value || '').trim()
  return quoted ? candidate : candidate.replace(/[),]+$/u, '')
}

/**
 * Extract literal absolute paths from a shell command so the caller can run
 * every one through the same per-user local-file authorization service used
 * by read_file/write_file. This is deliberately conservative and is an
 * application-level guard, not an OS sandbox.
 */
export function extractAbsoluteShellPaths(command, { platform = process.platform } = {}) {
  const source = String(command || '')
  const found = []
  const patterns = platform === 'win32'
    ? [
        { pattern: /"((?:[A-Za-z]:[\\/]|\\\\)[^"\r\n]+?)"/g, quoted: true },
        { pattern: /'((?:[A-Za-z]:[\\/]|\\\\)[^'\r\n]+?)'/g, quoted: true },
        { pattern: /(?:^|[\s=,(])((?:[A-Za-z]:[\\/]|\\\\)[^\s"'<>|;&,)]+)/g, quoted: false },
      ]
    : [
        { pattern: /"(\/[^"\r\n]+?)"/g, quoted: true },
        { pattern: /'(\/[^'\r\n]+?)'/g, quoted: true },
        { pattern: /(?:^|[\s=,(])(\/[^\s"'<>|;&,)]+)/g, quoted: false },
      ]
  for (const { pattern, quoted } of patterns) {
    for (const match of source.matchAll(pattern)) {
      const candidate = cleanPathCandidate(match[1], { quoted })
      if (candidate) found.push(candidate)
    }
  }
  const normalize = (value) => platform === 'win32' ? value.toLowerCase() : value
  return [...new Map(found.map((value) => [normalize(value), value])).values()]
}

/**
 * Reject path expressions that cannot be resolved and authorized before the
 * child process starts. Literal absolute paths are allowed and validated by
 * fsShellTools; dynamic/home/device paths and parent traversal are not.
 */
export function checkShellPathSyntax(command, { platform = process.platform } = {}) {
  if (typeof command !== 'string' || !command.trim()) return null
  if (WINDOWS_DEVICE_PATH_RE.test(command)) return { reason: '不允许访问 Windows 设备路径' }
  if (HOME_EXPANSION_RE.test(command) || DYNAMIC_PATH_RE.test(command)) {
    return { reason: '路径必须使用可预检的字面量，不能使用环境变量或主目录展开' }
  }
  if (PARENT_PATH_RE.test(command)) return { reason: '命令路径不能包含父目录跳转（..）' }
  if (platform === 'win32') {
    const unquoted = command.replace(/"[^"\r\n]*"|'[^'\r\n]*'/g, (value) => ' '.repeat(value.length))
    const match = UNQUOTED_WINDOWS_PAREN_PATH_RE.exec(unquoted)
    if (match) {
      return {
        reason: 'Windows 绝对路径包含未加引号的括号',
        code: 'SHELL_PATH_QUOTING_REQUIRED',
        statusCode: 400,
        path: match[1],
        hint: '请用双引号完整包裹 Windows command 中的每个绝对路径，即使路径不含空格。',
      }
    }
  }
  return null
}

// 测试用
export const _internals = { RULES }

/**
 * 当 WORKSPACE_SHELL_ENABLED=1 时返回一条信任声明 warn 文案,否则返回 null。
 * 黑名单不是安全边界,开 shell = 完全信任用户(见文件头注释)。
 */
export function shellTrustWarning(env = process.env) {
  if (env.WORKSPACE_SHELL_ENABLED !== '1') return null
  return (
    'WORKSPACE_SHELL_ENABLED=1: bash_exec 已开启。' +
    '危险命令黑名单仅防手滑,不是安全边界——开启 shell 等同于完全信任能调用该接口的用户' +
    '(可在 server 进程权限下执行任意命令)。不信任用户请勿开此 env,' +
    '不可信场景须上 OS 级隔离(容器 / nsjail / seccomp)。'
  )
}

/**
 * 启动期调用:shell 开启时打一条醒目 warn 日志。
 */
export function warnShellTrust(env = process.env, logger = console) {
  const msg = shellTrustWarning(env)
  if (msg) logger.warn(`[bashGuard] ${msg}`)
}
