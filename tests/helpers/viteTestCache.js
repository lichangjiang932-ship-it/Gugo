import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function resolveViteTestCacheDir() {
  const workerTempDir = process.env.TMPDIR
    || process.env.TEMP
    || process.env.TMP
    || tmpdir()

  return join(workerTempDir, `yma-vite-cache-${process.pid}`)
}
