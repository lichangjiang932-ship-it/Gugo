import { CliUsageError } from './errors.js'
import { assertCliRuntimeDirectory } from './runtimeSelection.js'

const BOOLEAN_FLAGS = new Map([
  ['--headless', 'headless'],
  ['--probe', 'probe'],
  ['--json', 'json'],
  ['--integrity', 'integrity'],
])
const VALUE_FLAGS = new Map([
  ['--model', 'model'],
  ['--provider', 'provider'],
  ['--cwd', 'cwd'],
])

/**
 * Parse `gugo doctor` arguments. Without `--headless` the command keeps its
 * existing authenticated HTTP behavior. Headless-only options are rejected when
 * `--headless` is absent so a typo cannot silently hit a running server.
 */
export function parseDoctorArgs(argv = []) {
  const options = { headless: false, probe: false, model: null, provider: null, cwd: null }
  const seen = new Set()
  for (let index = 0; index < argv.length; index += 1) {
    const raw = String(argv[index])
    if (!raw.startsWith('--') || raw === '--') {
      throw new CliUsageError('CLI_ARGUMENT_UNEXPECTED', `unexpected argument for doctor: ${raw}`)
    }
    const equalAt = raw.indexOf('=')
    const key = raw.slice(2, equalAt >= 0 ? equalAt : undefined)
    const full = `--${key}`
    if (seen.has(full)) {
      throw new CliUsageError('CLI_OPTION_DUPLICATE', `${full} may only be specified once`)
    }
    seen.add(full)
    if (BOOLEAN_FLAGS.has(full)) {
      if (equalAt >= 0) {
        throw new CliUsageError('CLI_OPTION_VALUE_REQUIRED', `${full} does not take a value`)
      }
      options[BOOLEAN_FLAGS.get(full)] = true
      continue
    }
    if (!VALUE_FLAGS.has(full)) {
      throw new CliUsageError('CLI_OPTION_UNKNOWN', `unknown option for doctor: ${full}`)
    }
    const value = equalAt >= 0 ? raw.slice(equalAt + 1) : argv[++index]
    const normalized = value === undefined ? '' : String(value).trim()
    if (!normalized || String(value).startsWith('--')) {
      throw new CliUsageError('CLI_OPTION_VALUE_REQUIRED', `${full} requires a value`)
    }
    options[VALUE_FLAGS.get(full)] = normalized
  }
  if (!options.headless && (options.probe || options.model || options.provider || options.cwd || options.integrity)) {
    throw new CliUsageError(
      'CLI_OPTION_UNKNOWN',
      '--probe/--model/--provider/--cwd/--integrity require --headless',
    )
  }
  return options
}

/**
 * Run the local, browser-free preflight. It never contacts a model unless
 * `--probe` was explicitly requested. The report is JSON on stdout; the exit
 * code is 0 only when no blocking reason was found.
 */
export async function cmdDoctorHeadless({ model, provider, cwd, probe, integrity, runtimeCwd = process.cwd(), env = process.env } = {}) {
  assertCliRuntimeDirectory(runtimeCwd)
  const { runHeadlessDoctor } = await import('../../server/services/headlessDoctorService.js')
  const report = await runHeadlessDoctor({
    // Runtime selection is independent of --cwd, which only selects the task
    // workspace. Project files cannot relocate the selected trusted runtime.
    runtimeCwd,
    env,
    workspaceCwd: cwd || process.cwd(),
    providerId: provider || '',
    modelName: model || '',
    probe: probe === true,
    integrity: integrity === true,
  })
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  return report.ok === true ? 0 : 1
}
