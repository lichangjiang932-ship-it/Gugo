import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { credentialsPath, settingsPath } from './llmConfigStore.js'

/**
 * Open one of the two configuration files in the user's editor.
 *
 * The capability is deliberately narrow: the caller names a target, never a
 * path, so this can only ever open settings.yaml or .credentials.yaml — the
 * same files the page is showing. Anything else is refused before a process is
 * spawned.
 */
export const OPEN_TARGETS = Object.freeze(['settings', 'credentials'])

export function configPathFor(target, env = process.env) {
  if (target === 'settings') return settingsPath(env)
  if (target === 'credentials') return credentialsPath(env)
  return ''
}

export function platformOpenCommand(path, platform = process.platform) {
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '', path] }
  if (platform === 'darwin') return { command: 'open', args: [path] }
  return { command: 'xdg-open', args: [path] }
}

export function openConfigFile(target, { env = process.env, platform = process.platform, spawnImpl = spawn, ensure = true } = {}) {
  const path = configPathFor(target, env)
  if (!path) return { ok: false, code: 'LLM_OPEN_TARGET_INVALID', message: String(target || '') }
  if (ensure && !existsSync(path)) return { ok: false, code: 'LLM_CONFIG_FILE_MISSING', path }
  try {
    const { command, args } = platformOpenCommand(path, platform)
    const child = spawnImpl(command, args, { detached: true, stdio: 'ignore' })
    child?.unref?.()
    return { ok: true, path }
  } catch (error) {
    return { ok: false, code: 'LLM_OPEN_FAILED', path, message: String(error?.message || error) }
  }
}
