/**
 * 统一的敏感 env 屏蔽规则。
 *
 * 凡是 spawn / execFile 子进程(bash_exec / git / MCP stdio)都必须经过 sanitizeChildEnv,
 * 防 prompt injection 通过 `env` / `printenv` / `cat /proc/self/environ` 偷密钥。
 *
 * 规则:
 *   1. 明确黑名单:已知会装载敏感值的 env(覆盖所有主流 provider + 项目自家密钥)
 *   2. 通配符:任何以 _API_KEY / _TOKEN / _SECRET / _PASSWORD / _PASS / _CREDENTIALS 结尾的
 *   3. 项目自家前缀:APP_SECRET / AUTH_SECRET / DATABASE_URL
 *
 * extra 参数允许调用方追加自己的额外 env(已经经过 sanitize 校验)。
 */

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
])

const DENY_SUFFIX = ['_API_KEY', '_TOKEN', '_SECRET', '_PASSWORD', '_PASS', '_CREDENTIALS', '_PRIVATE_KEY']

export function isSensitiveEnvKey(key) {
  if (!key || typeof key !== 'string') return false
  if (EXPLICIT_DENY.has(key)) return true
  for (const suffix of DENY_SUFFIX) {
    if (key.length > suffix.length && key.endsWith(suffix)) return true
  }
  return false
}

/**
 * 复制 process.env 并剥掉所有敏感 key,可选追加 extra(extra 自身也会过滤敏感 key)。
 * 返回纯 string -> string 的 plain object,可直接喂 child_process。
 */
export function sanitizeChildEnv(extra = {}) {
  const out = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (!k || k.startsWith('=')) continue
    if (v == null) continue
    if (isSensitiveEnvKey(k)) continue
    out[k] = String(v)
  }
  if (extra && typeof extra === 'object') {
    for (const [k, v] of Object.entries(extra)) {
      if (!k || isSensitiveEnvKey(k)) continue
      if (v == null) continue
      out[k] = String(v)
    }
  }
  return out
}

// 暴露内部表给测试用
export const _internals = { EXPLICIT_DENY, DENY_SUFFIX }
