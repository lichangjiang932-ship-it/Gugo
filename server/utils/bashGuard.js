/**
 * bash_exec 危险命令拦截器。
 *
 * 这里不做"完整 sandbox"(那是 M4 系统级隔离的事),只挡明确的破坏性 / 数据外泄模式,
 * 防 prompt injection 一行 payload 把磁盘炸了或把密钥送出去。
 *
 * 设计原则:
 *   - 黑名单而非白名单(白名单会过严,影响正常 dev 体验)
 *   - 命中 → throw,带可读理由,记审计(由 caller 写 denied)
 *   - 不解析 shell AST(代价过大),用保守的字面 + 正则匹配
 *   - 误杀宁可严,正常 dev 命令不会触发(rm -rf node_modules 是允许的,只挡根目录类绝对路径)
 */

const FORK_BOMB_RE = /:\(\)\s*\{[^}]*:\|:[^}]*\}[^}]*:/  // :(){:|:&};:
// rm -rf 加 原子路径:`/` 只有 后接空白/行末/管道 才算 "根目录"，避免误伤 /tmp/...
const RM_ROOT_RE = /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f?|-[a-zA-Z]*f[a-zA-Z]*r?|--recursive\b[^|;&]*--force\b|--force\b[^|;&]*--recursive\b)\s+(\/(?:\s|$|\*|\||;|&)|~(?:\s|$|\/)|\$HOME\b|\/etc\b|\/usr\b|\/var\b|\/bin\b|\/sbin\b|\/boot\b|\/root\b|\/home(?:\s|$|\/\s|\/\*))/
const RM_NO_PRESERVE_RE = /\brm\s[^|;&]*--no-preserve-root\b/
const DD_DEVICE_RE = /\bdd\s+[^|;&]*of=\/dev\/(sd[a-z]|nvme|hd[a-z]|mmcblk)/
const MKFS_RE = /\bmkfs(\.\w+)?\s+\/dev\//
const FORMAT_RE = /\bformat\s+[a-z]:/i
const CURL_PIPE_SH_RE = /\b(curl|wget)\s[^|;&]*\|\s*(sh|bash|zsh|fish|python|node|ruby|perl)\b/
const CHMOD_777_ROOT_RE = /\bchmod\s+-R\s+777\s+(\/|~|\$HOME|\/etc|\/usr|\/var)/
// SSH/AWS 私钥外泄:id_xxx 后面不能跟字母数字也不能跟 .pub(避免贪婪回溯让 id_rsa.pub 也命中)
const SSH_KEY_EXFIL_RE = /\b(cat|less|more|head|tail|xxd|base64|od)\s[^|;&]*(\.ssh\/id_[a-z0-9]+(?![a-z0-9.])|\.aws\/credentials|\.gnupg\/[a-z]*sec|\.docker\/config\.json)/
// env exfil:只拦"导到文件"或"管道到出口命令"，不拦 env | grep 这种本地过滤
const ENV_EXFIL_RE = /\b(env|printenv|set)\s*(>|>>|\|\s*(curl|wget|nc|ncat|socat|ssh|scp|rsync|bash|sh|zsh|python|node|ruby|perl|telnet))/

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
]

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

// 测试用
export const _internals = { RULES }
