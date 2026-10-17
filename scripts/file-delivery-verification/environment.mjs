import path from 'node:path'
import { mkdirSync } from 'node:fs'
import { createIsolatedWebEnvironment } from '../verify-isolated-web.mjs'

/** Bootstrap environment only; the trusted worker receives one model binding over IPC. */
export function createFileDeliveryEnvironment(options) {
  const env = createIsolatedWebEnvironment(options)
  delete env.GUGO_PURE_LOCAL_MODE
  delete env.GUGO_SQLITE_DRIVER
  return {
    ...env,
    NODE_ENV: 'production',
    GUGO_RUNTIME_CWD: options.runRoot,
    GUGO_CLI_WORKSPACE_ROOT: env.WORKSPACE_ROOT,
    WORKSPACE_FS_ENABLED: '1',
    WORKSPACE_SHARED_TRUSTED: '1',
    VITE_DEV_PORT: String(options.port),
  }
}

/** Validate the IPC worker before loading any application runtime. */
export function assertFileDeliveryWorkerEnvironment({ runRoot, projectRoot, port, actualEnv = process.env, cwd = process.cwd() }) {
  const expected = createFileDeliveryEnvironment({ runRoot, projectRoot, port })
  const canonical = value => {
    const result = Object.create(null)
    for (const [key, item] of Object.entries(value)) {
      const name = process.platform === 'win32' ? key.toUpperCase() : key
      if (Object.hasOwn(result, name)) throw new TypeError('File delivery worker environment has duplicate keys')
      result[name] = item
    }
    return result
  }
  const actual = canonical(actualEnv)
  const wanted = canonical(expected)
  if (path.resolve(cwd) !== projectRoot || [...new Set([...Object.keys(actual), ...Object.keys(wanted)])].some(key => actual[key] !== wanted[key])) {
    throw new TypeError('File delivery worker environment is not isolated')
  }
}

export function prepareFileDeliveryDirectories(env) {
  for (const key of [
    'HOME', 'GUGO_HOME', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME',
    'APP_DATA_DIR', 'ARTIFACT_DIR', 'WORKSPACE_ROOT', 'TEMP', 'npm_config_cache',
  ]) mkdirSync(env[key], { recursive: true })
}

export function fileDeliveryBuildOptions({ runRoot, projectRoot, port }) {
  createFileDeliveryEnvironment({ runRoot, projectRoot, port, sourceEnv: {} })
  return {
    configFile: path.join(projectRoot, 'vite.config.js'),
    configLoader: 'native',
    envDir: false,
    cacheDir: path.join(runRoot, 'vite-cache'),
    build: { outDir: path.join(runRoot, 'dist'), emptyOutDir: true },
  }
}
