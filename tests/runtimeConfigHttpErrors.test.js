import assert from 'node:assert/strict'
import test from 'node:test'

import { createAppServer } from '../server/appServer.js'

test('dynamic runtime config failures cross the HTTP boundary as actionable 422 errors', async () => {
  let reads = 0
  const sourcePath = 'C:\\private\\runtime.json'
  const server = createAppServer({
    getEnv: () => {
      reads += 1
      if (reads === 1) return { AUTH_MODE: 'local' }
      throw Object.assign(new Error(`invalid JSON at ${sourcePath}`), {
        code: 'RUNTIME_CONFIG_FILE_INVALID',
        statusCode: 422,
        sourcePath,
      })
    },
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/status`)
    assert.equal(response.status, 422)
    const body = await response.text()
    assert.deepEqual(JSON.parse(body), {
      ok: false,
      error: {
        code: 'RUNTIME_CONFIG_FILE_INVALID',
        message: '运行配置文件 runtime.json 内容无效，请修正后重试',
        action: 'EDIT_RUNTIME_CONFIG',
        filename: 'runtime.json',
      },
    })
    assert.doesNotMatch(body, /C:\\private/iu)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
