import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { getRuntimeEnv, readRuntimeEnvFile } from '../server/utils/runtimeEnv.js'

test('runtime env reads .env values and lets process variables override them', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'atelier-env-'))
  fs.writeFileSync(path.join(cwd, '.env'), [
    '# comment',
    'WORKSPACE_GIT_ENABLED=1',
    'QUOTED_VALUE="from file"',
    'EMPTY_VALUE=',
  ].join('\n'), 'utf8')

  assert.deepEqual(readRuntimeEnvFile(cwd), {
    WORKSPACE_GIT_ENABLED: '1',
    QUOTED_VALUE: 'from file',
    EMPTY_VALUE: '',
  })
  const runtime = getRuntimeEnv({ WORKSPACE_GIT_ENABLED: '0' }, { cwd })
  assert.equal(runtime.WORKSPACE_GIT_ENABLED, '0')
  assert.equal(runtime.QUOTED_VALUE, 'from file')
})
