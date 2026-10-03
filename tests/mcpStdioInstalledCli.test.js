import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import test from 'node:test'

import { resolveMcpStdioCommand } from '../server/mcp/mcpStdioCommand.js'
import { sanitizeChildEnv } from '../server/utils/sensitiveEnv.js'

const run = promisify(execFile)

for (const name of ['npm', 'npx']) {
  test(`installed Windows ${name} CLI runs --version without a shell or package download`, {
    skip: process.platform !== 'win32', timeout: 20000,
  }, async (t) => {
    let resolved
    try { resolved = resolveMcpStdioCommand({ command: `${name}.cmd`, args: ['--version'] }) } catch (error) {
      assert.equal(error.code, 'MCP_STDIO_NPM_CLI_NOT_FOUND')
      t.diagnostic('Local npm is absent: validated explicit missing-installation failure only; no installation attempted.')
      return
    }
    assert.match(resolved.command, /\.exe$/iu)
    assert.match(resolved.args[0], new RegExp(`${name}-cli\\.js$`, 'u'))
    const result = await run(resolved.command, resolved.args, {
      env: sanitizeChildEnv({ npm_config_offline: 'true', npm_config_update_notifier: 'false' }),
      shell: false, windowsHide: true, timeout: 15000, maxBuffer: 64 * 1024,
    })
    assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/u)
    t.diagnostic(`Executed the existing local ${name} CLI: ${result.stdout.trim()}; offline, --version only.`)
  })
}
