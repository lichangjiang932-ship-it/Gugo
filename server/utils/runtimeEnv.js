import fs from 'node:fs'
import path from 'node:path'

// 只在第一次没找到 .env 时提示一次,避免每次调用都刷屏
let missingEnvWarned = false

export function readRuntimeEnvFile(cwd = process.cwd()) {
  const envPath = path.join(cwd, '.env')
  if (!fs.existsSync(envPath)) {
    // ★ 找不到 .env 时原来是完全静默的 —— 从子目录启动服务(很常见)
    // 会导致所有模型配置凭空消失,而用户看到的只是「没配模型」,
    // 完全想不到是启动目录的问题。至少说一声。
    if (!missingEnvWarned && !process.env.MODEL_BASE_URL && !process.env.MODEL_PROVIDERS) {
      missingEnvWarned = true
      console.warn(
        `[env] 未找到 ${envPath} —— 模型配置将只从系统环境变量读取。`
        + '\n[env] 如果你已经写了 .env，请确认是从**仓库根目录**启动服务（npm run serve）。',
      )
    }
    return {}
  }

  const entries = {}
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    if (!key) continue
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    entries[key] = value
  }
  return entries
}

export function getRuntimeEnv(env = process.env, { cwd = process.cwd() } = {}) {
  return { ...readRuntimeEnvFile(cwd), ...env }
}
