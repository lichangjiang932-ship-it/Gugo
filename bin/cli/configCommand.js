import { CliUsageError } from './errors.js'
import { assertCliRuntimeDirectory, resolveCliRuntimeSelection } from './runtimeSelection.js'
import { resolveServerUrl } from './serverCommands.js'

export function parseConfigArgs(argv = []) {
  let json = false
  for (const raw of argv) {
    if (raw !== '--json') {
      throw new CliUsageError(String(raw).startsWith('--') ? 'CLI_OPTION_UNKNOWN' : 'CLI_ARGUMENT_UNEXPECTED',
        'config accepts only --json; use gugo --runtime-dir <dir> config to select a runtime')
    }
    if (json) throw new CliUsageError('CLI_OPTION_DUPLICATE', '--json may only be specified once')
    json = true
  }
  return { json }
}

const DEFAULT_PERMISSION_POLICY = 'Without an explicit --mode, CLI uses normal, narrowed to a saved plan mode. Saved acceptEdits/bypass never silently widen CLI permissions.'

/** Deliberately no DB, owner bootstrap, vault, network request or browser launch. */
export async function inspectCliConfiguration({ runtime = null, env = process.env } = {}) {
  runtime ||= resolveCliRuntimeSelection({ env })
  assertCliRuntimeDirectory(runtime.cwd)
  const { resolveRuntimeStartupConfiguration } = await import('../../server/utils/runtimeEnv.js')
  const configuration = resolveRuntimeStartupConfiguration({ cwd: runtime.cwd, env, warnOnMissingDotEnv: false })
  const { runtimeEnv, paths, precedence, layers } = configuration
  const sourceOf = (key) => [...precedence].reverse().find((source) => Object.hasOwn(layers[source], key)) || 'default'
  return {
    readOnly: true,
    runtime: { cwd: runtime.cwd, source: runtime.source,
      dataDir: runtimeEnv.APP_DATA_DIR, dbPath: runtimeEnv.APP_DB_PATH, artifactDir: runtimeEnv.ARTIFACT_DIR,
      storageSources: Object.fromEntries(['APP_DATA_DIR', 'APP_DB_PATH', 'ARTIFACT_DIR'].map((key) => [key, sourceOf(key)])) },
    configuration: { paths, precedence, dotenvEnabled: env.GUGO_LOAD_DOTENV !== '0' },
    identity: { inspected: false, credentialStoreOpened: false, source: 'local_runtime_database',
      note: 'Only the selected local runtime owner may supply models, grants, MCP, skills and memories. HTTP tokens are never local DB authorization.' },
    permissions: { defaultPolicy: DEFAULT_PERMISSION_POLICY, persistedModeInspected: false },
    settings: { url: `${resolveServerUrl(runtimeEnv)}/#/settings`, verified: false,
      note: 'Link only: no server was contacted or started. A server URL does not bind the local CLI database; compare runtime paths before editing.' },
  }
}

export async function cmdConfig(argv, { stdout = process.stdout, runtime, env = process.env } = {}) {
  const { json } = parseConfigArgs(argv)
  const report = await inspectCliConfiguration({ runtime, env })
  if (json) stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  else stdout.write([
    `Runtime directory: ${report.runtime.cwd} (${report.runtime.source})`,
    `Data directory: ${report.runtime.dataDir}`,
    `Database: ${report.runtime.dbPath}`,
    `Artifacts: ${report.runtime.artifactDir}`,
    `User configuration: ${report.configuration.paths.user}`,
    `Project configuration: ${report.configuration.paths.project}`,
    `Explicit configuration: ${report.configuration.paths.explicit || '(none)'}`,
    `Precedence (low to high): ${report.configuration.precedence.join(' < ')}`,
    report.permissions.defaultPolicy,
    `Existing web settings: ${report.settings.url}`,
    report.settings.note,
    'Read-only: no credential stores, owner records, databases or model endpoints were opened.', '',
  ].map((line) => line.replace(/[\p{Cc}\p{Cf}]/gu, ' ')).join('\n'))
  return 0
}
