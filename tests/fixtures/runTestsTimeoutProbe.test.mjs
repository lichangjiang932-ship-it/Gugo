import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import test from 'node:test'

test('timeout probe', async () => {
  const descendant = spawn(process.execPath, [
    '-e',
    'setInterval(() => {}, 1_000)',
  ], {
    stdio: 'ignore',
    windowsHide: true,
  })
  descendant.unref()

  const pidFile = process.env.RUN_TESTS_TIMEOUT_PROBE_PID_FILE
  if (pidFile) writeFileSync(pidFile, String(descendant.pid), 'utf8')

  await new Promise(() => setInterval(() => {}, 1_000))
})
