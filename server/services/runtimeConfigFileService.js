import fs from 'node:fs'
import path from 'node:path'
import {
  readRuntimeConfigFileSnapshot,
  resolveRuntimeConfigPaths,
} from '../utils/runtimeEnv.js'

const EMPTY_RUNTIME_CONFIG = '{\n  "env": {}\n}\n'
const SENSITIVE_RUNTIME_CONFIG_KEY = /(apikey|token|secret|password|credential|privatekey)/i

function runtimeConfigError(message, code, statusCode = 500) {
  const error = new Error(message)
  error.code = code
  error.statusCode = statusCode
  return error
}

function assertBrowserSafeConfig(value) {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach(assertBrowserSafeConfig)
    return
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    const normalizedKey = key.replace(/[^a-z0-9]/gi, '')
    if (SENSITIVE_RUNTIME_CONFIG_KEY.test(normalizedKey)) {
      throw runtimeConfigError(
        'runtime config contains a sensitive field and cannot be opened in the browser',
        'SENSITIVE_RUNTIME_CONFIG',
        409,
      )
    }
    assertBrowserSafeConfig(nestedValue)
  }
}

/**
 * Return the installation-scoped, non-secret runtime configuration shown by
 * Settings. The target path is derived entirely on the server and never from
 * request input.
 */
export function readBrowserRuntimeConfig({ cwd = process.cwd(), env = process.env } = {}) {
  const filePath = resolveRuntimeConfigPaths({ cwd, env }).user
  fs.mkdirSync(path.dirname(filePath), { recursive: true })

  try {
    fs.writeFileSync(filePath, EMPTY_RUNTIME_CONFIG, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }

  const stat = fs.lstatSync(filePath)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw runtimeConfigError(
      'runtime config must be a regular file',
      'INVALID_RUNTIME_CONFIG_FILE',
      409,
    )
  }

  // Validate and parse the exact bytes returned to the browser. Unknown
  // metadata is preserved, but secret-bearing keys are never exposed.
  const snapshot = readRuntimeConfigFileSnapshot(filePath)
  assertBrowserSafeConfig(snapshot.document)
  return {
    filename: path.basename(filePath),
    content: snapshot.content.toString('utf8'),
  }
}
