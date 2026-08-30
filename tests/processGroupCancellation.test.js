import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { runProcessWithGroup } from '../server/utils/processGroup.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function cleanupEventually(root) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      fs.rmSync(root, { recursive: true, force: true })
      return
    } catch {
      await sleep(50)
    }
  }
}

test('Windows cancellation waits for a cmd child tree to release its working directory', {
  skip: process.platform !== 'win32',
  // Each iteration may legitimately spend the PowerShell startup budget plus
  // the native tree-kill budget on a heavily loaded Windows runner.
  timeout: 45_000,
}, async () => {
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-process-cancel-'))
    let removed = false
    try {
      const controller = new AbortController()
      const command = 'node -e "setTimeout(() => {}, 10000)"'
      const result = await runProcessWithGroup({
        shellPath: process.env.COMSPEC || 'cmd.exe',
        shellArgs: ['/d', '/s', '/c', command],
        cwd: root,
        env: process.env,
        timeout: 12_000,
        windowsHide: true,
        windowsVerbatimArguments: true,
        signal: controller.signal,
        onSpawn: () => setTimeout(() => controller.abort(), 100),
      })

      assert.equal(result.aborted, true)
      assert.equal(result.killed, true)
      assert.equal(result.processTreeCleanupFailed, false)
      assert.doesNotThrow(() => {
        fs.rmSync(root, { recursive: true, force: true })
        removed = true
      }, `iteration ${iteration + 1} returned before the child process released cwd`)
    } finally {
      if (!removed) await cleanupEventually(root)
    }
  }
})
