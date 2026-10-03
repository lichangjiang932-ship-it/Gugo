import { statSync } from 'node:fs'
import path from 'node:path'
import { CliUsageError } from './errors.js'
import { validateRuntimeStoragePath } from '../../server/utils/runtimeStoragePath.js'

/** Only command-prefix arguments select a runtime; tool prompts are untouched. */
export function parseCliRuntimeArgs(argv = []) {
  let index = 0
  let runtimeDir = null
  while (argv[index] === '--runtime-dir' || String(argv[index] || '').startsWith('--runtime-dir=')) {
    if (runtimeDir !== null) throw new CliUsageError('CLI_OPTION_DUPLICATE', '--runtime-dir may only be specified once')
    const raw = String(argv[index++])
    const value = raw.includes('=') ? raw.slice(raw.indexOf('=') + 1) : argv[index++]
    if (typeof value !== 'string' || !value.trim() || value.startsWith('--')) {
      throw new CliUsageError('CLI_OPTION_VALUE_REQUIRED', '--runtime-dir requires a directory before the command')
    }
    runtimeDir = value
  }
  return { argv: argv.slice(index), runtimeDir }
}

/** Read only the original launcher env, never a project/runtime JSON result. */
export function resolveCliRuntimeSelection({ runtimeDir = null, cwd = process.cwd(), env = process.env } = {}) {
  const environmental = String(env.GUGO_RUNTIME_CWD || '').trim()
  const requested = runtimeDir ?? (environmental || cwd)
  try { validateRuntimeStoragePath(requested, { key: 'runtime directory' }) }
  catch { throw new CliUsageError('CLI_RUNTIME_DIR_INVALID', 'runtime directory must be a valid filesystem directory path') }
  return Object.freeze({ cwd: path.resolve(cwd, requested),
    source: runtimeDir !== null ? 'argument' : environmental ? 'environment' : 'cwd' })
}

export function assertCliRuntimeDirectory(cwd) {
  let entry
  try { entry = statSync(cwd) }
  catch { throw new CliUsageError('CLI_RUNTIME_DIR_NOT_FOUND', 'runtime directory is unavailable; check --runtime-dir or GUGO_RUNTIME_CWD') }
  if (!entry.isDirectory()) throw new CliUsageError('CLI_RUNTIME_DIR_NOT_DIRECTORY', 'runtime directory must be a directory')
  return cwd
}
