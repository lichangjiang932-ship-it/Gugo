/**
 * 统一的敏感 env 屏蔽规则。
 *
 * 凡是 spawn / execFile 子进程(bash_exec / git / MCP stdio)都必须经过 sanitizeChildEnv,
 * 防 prompt injection 通过 `env` / `printenv` / `cat /proc/self/environ` 偷密钥。
 *
 * 规则:
 *   1. 明确黑名单:已知会装载敏感值的 env(覆盖所有主流 provider + 项目自家密钥)
 *   2. 通配符:凭据型后缀，以及任意 LD_ / DYLD_ loader 变量
 *   3. 运行时注入:NODE_OPTIONS / *PATH / shell 启动脚本等
 *
 * extra 参数默认也会过滤；只有 allowExtraKeys 显式列出的独立凭据对象键
 * 才能加宽，且运行时注入变量永远不能恢复。
 */

const RUNTIME_INJECTION_ENV = new Set([
  // Node/Python/shell runtimes can execute attacker-controlled code before the
  // requested command. These are never eligible for env_keys restoration.
  'NODE_OPTIONS',
  'NODE_PATH',
  'NPM_CONFIG_NODE_OPTIONS',
  'PYTHONPATH',
  'PYTHONHOME',
  'PYTHONSTARTUP',
  'PYTHONINSPECT',
  'BASH_ENV',
  'ENV',
  'PROMPT_COMMAND',
  'ZDOTDIR',
  'RUBYOPT',
  'RUBYLIB',
  'PERL5OPT',
  'PERL5LIB',
  'PERLLIB',
  'JAVA_TOOL_OPTIONS',
  'JDK_JAVA_OPTIONS',
  '_JAVA_OPTIONS',
  'CLASSPATH',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_EXTERNAL_DIFF',
])

const EXPLICIT_DENY = new Set([
  // 项目自家
  'MODEL_API_KEY',
  'MAIL_PASSWORD',
  'APP_SECRET',
  'AUTH_SECRET',
  'DATABASE_URL',
  // 主流 LLM provider
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'DEEPSEEK_API_KEY',
  'MISTRAL_API_KEY',
  'GROQ_API_KEY',
  'TOGETHER_API_KEY',
  // 平台/云
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'NPM_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AZURE_CLIENT_SECRET',
  'GCP_SERVICE_ACCOUNT_KEY',
  // SMTP/IMAP
  'MAIL_PASS',
  'SMTP_PASSWORD',
  ...RUNTIME_INJECTION_ENV,
])

const DENY_PREFIX = ['LD_', 'DYLD_']
const DENY_SUFFIX = ['_API_KEY', '_TOKEN', '_SECRET', '_PASSWORD', '_PASS', '_CREDENTIALS', '_PRIVATE_KEY', '_KEY']

// These values either belong to the running Gugo service or can inject code
// into a runtime before the requested command begins. Even an explicitly
// approved command must not borrow them. Operational credentials such as
// GH_TOKEN, NPM_TOKEN, cloud CLI credentials, and DATABASE_URL remain eligible
// for the explicit env_keys path because coding tasks legitimately need them.
const PROTECTED_EXECUTION_ENV = new Set([
  'MODEL_API_KEY',
  'MAIL_PASSWORD',
  'MAIL_PASS',
  'SMTP_PASSWORD',
  'APP_SECRET',
  'AUTH_SECRET',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'DEEPSEEK_API_KEY',
  'MISTRAL_API_KEY',
  'GROQ_API_KEY',
  'TOGETHER_API_KEY',
  ...RUNTIME_INJECTION_ENV,
])

function hasDeniedPrefix(normalizedKey) {
  return DENY_PREFIX.some((prefix) => normalizedKey.startsWith(prefix))
}

function normalizedEnvKey(key) {
  return typeof key === 'string' ? key.toUpperCase() : ''
}

function isUsableEnvEntry(key, value) {
  return typeof key === 'string'
    && key.length > 0
    && !key.startsWith('=')
    && !key.includes('\0')
    && value != null
}

function envKeyIdentity(key, platform) {
  return platform === 'win32' ? normalizedEnvKey(key) : key
}

function findEnvEntry(env, requestedKey, platform) {
  if (!env || typeof env !== 'object' || typeof requestedKey !== 'string') return null
  const requestedIdentity = envKeyIdentity(requestedKey, platform)
  for (const [key, value] of Object.entries(env)) {
    if (envKeyIdentity(key, platform) === requestedIdentity) return [key, value]
  }
  return null
}

function setEnvEntry(out, identities, key, value, platform) {
  const identity = envKeyIdentity(key, platform)
  const previousKey = identities.get(identity)
  if (previousKey && previousKey !== key) delete out[previousKey]
  // defineProperty also handles a legitimate "__proto__" environment key
  // without invoking Object.prototype's legacy setter.
  Object.defineProperty(out, key, {
    value: String(value),
    enumerable: true,
    configurable: true,
    writable: true,
  })
  identities.set(identity, key)
}

export function isSensitiveEnvKey(key) {
  if (!key || typeof key !== 'string') return false
  const normalized = normalizedEnvKey(key)
  if (EXPLICIT_DENY.has(normalized)) return true
  if (hasDeniedPrefix(normalized)) return true
  for (const suffix of DENY_SUFFIX) {
    if (normalized.endsWith(suffix)) return true
  }
  return false
}

export function isRuntimeInjectionEnvKey(key) {
  if (typeof key !== 'string') return false
  const normalized = normalizedEnvKey(key)
  return RUNTIME_INJECTION_ENV.has(normalized) || hasDeniedPrefix(normalized)
}

export function isProtectedExecutionEnvKey(key) {
  if (typeof key !== 'string') return false
  const normalized = normalizedEnvKey(key)
  return PROTECTED_EXECUTION_ENV.has(normalized) || isRuntimeInjectionEnvKey(normalized)
}

/**
 * 复制 sourceEnv 并剥掉所有敏感 key,可选追加 extra(extra 自身也会过滤敏感 key)。
 * inheritKeys 只从宿主 sourceEnv 按名称恢复非服务凭据；allowExtraKeys 只从
 * 独立 extra 对象按名称恢复显式配置值。两条路径都无法恢复运行时注入变量。
 * 返回纯 string -> string 的 plain object,可直接喂 child_process。
 */
export function sanitizeChildEnv(extra = {}, {
  allowExtraKeys = [],
  inheritKeys = [],
  platform = process.platform,
  sourceEnv = process.env,
} = {}) {
  const out = {}
  const identities = new Map()
  for (const [k, v] of Object.entries(sourceEnv || {})) {
    if (!isUsableEnvEntry(k, v)) continue
    if (isSensitiveEnvKey(k)) continue
    setEnvEntry(out, identities, k, v, platform)
  }
  if (extra && typeof extra === 'object') {
    for (const [k, v] of Object.entries(extra)) {
      if (!isUsableEnvEntry(k, v) || isSensitiveEnvKey(k)) continue
      setEnvEntry(out, identities, k, v, platform)
    }
  }
  // Sensitive values are restored only by name from process.env. Callers must
  // expose those names in an already-approved tool call; literal values never
  // enter model-authored arguments, audit records, or tool results.
  for (const key of Array.isArray(inheritKeys) ? inheritKeys : []) {
    if (typeof key !== 'string' || !key || isProtectedExecutionEnvKey(key)) continue
    const entry = findEnvEntry(sourceEnv, key, platform)
    if (!entry || !isUsableEnvEntry(entry[0], entry[1])) continue
    setEnvEntry(out, identities, entry[0], entry[1], platform)
  }
  // Some adapters (notably MCP stdio) own a separate, encrypted credential
  // object. They may explicitly authorize selected keys from that object. This
  // never widens inherited host env and can never restore pre-execution hooks.
  for (const key of Array.isArray(allowExtraKeys) ? allowExtraKeys : []) {
    if (typeof key !== 'string' || !key || isRuntimeInjectionEnvKey(key)) continue
    const entry = findEnvEntry(extra, key, platform)
    if (!entry || !isUsableEnvEntry(entry[0], entry[1])) continue
    setEnvEntry(out, identities, entry[0], entry[1], platform)
  }
  return out
}

// 暴露内部表给测试用
export const _internals = {
  EXPLICIT_DENY,
  DENY_PREFIX,
  DENY_SUFFIX,
  PROTECTED_EXECUTION_ENV,
  RUNTIME_INJECTION_ENV,
}
