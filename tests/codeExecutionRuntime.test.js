import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  buildCodeExecutionEnv,
  codeExecutionFailureHint,
  inferCodeExecutionOutputPaths,
  resolveCodeExecutionPython,
} from '../server/utils/codeExecutionRuntime.js'

function touch(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, '')
  return filePath
}

function winPath(...parts) {
  return path.win32.join(...parts)
}

test('explicit code-execution Python wins when it owns a working pip', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-python-runtime-'))
  try {
    const explicitRoot = path.join(root, 'explicit')
    const fallbackRoot = path.join(root, 'fallback')
    const explicitPython = touch(path.join(explicitRoot, 'python.exe'))
    touch(path.join(explicitRoot, 'Scripts', 'pip.exe'))
    touch(path.join(fallbackRoot, 'python.exe'))
    touch(path.join(fallbackRoot, 'Scripts', 'pip.exe'))

    const probes = []
    const resolved = resolveCodeExecutionPython({
      env: {
        CODE_EXECUTION_PYTHON: explicitPython,
        Path: `${fallbackRoot};${path.join(fallbackRoot, 'Scripts')}`,
      },
      platform: 'win32',
      spawnSyncImpl: (command) => {
        probes.push(command)
        return { status: 0 }
      },
    })

    assert.equal(resolved.pythonPath, explicitPython)
    assert.equal(resolved.pipPath, path.join(explicitRoot, 'Scripts', 'pip.exe'))
    assert.equal(resolved.configured, true)
    assert.deepEqual(probes, [explicitPython])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Windows falls back from a Python without pip to the interpreter owning a PATH Scripts directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-python-runtime-'))
  try {
    const hermesRoot = path.join(root, 'hermes')
    const usableRoot = path.join(root, 'usable')
    touch(path.join(hermesRoot, 'python.exe'))
    const usablePython = touch(path.join(usableRoot, 'python.exe'))
    const usablePip = touch(path.join(usableRoot, 'Scripts', 'pip.exe'))

    const resolved = resolveCodeExecutionPython({
      env: { Path: `${hermesRoot};${path.join(usableRoot, 'Scripts')}` },
      platform: 'win32',
      spawnSyncImpl: (command) => ({ status: command === usablePython ? 0 : 1 }),
    })

    assert.equal(resolved.pythonPath, usablePython)
    assert.equal(resolved.pipPath, usablePip)
    assert.equal(resolved.configured, false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('bash_exec environment puts the selected Python and pip directories first and removes duplicate PATH keys', () => {
  const runtime = {
    pythonPath: winPath('C:\\', 'runtime', 'python.exe'),
    pipPath: winPath('C:\\', 'runtime', 'Scripts', 'pip.exe'),
  }
  const env = buildCodeExecutionEnv({
    PATH: 'C:\\Windows\\System32;C:\\runtime\\Scripts',
    Path: 'C:\\old-python;C:\\Windows\\System32',
    KEEP_ME: 'yes',
  }, { platform: 'win32', runtime })

  assert.equal(env.KEEP_ME, 'yes')
  assert.equal(env.PATH, undefined)
  assert.deepEqual(env.Path.split(';'), [
    'C:\\runtime',
    'C:\\runtime\\Scripts',
    'C:\\old-python',
    'C:\\Windows\\System32',
  ])
})

test('environment stays unchanged when no consistent Python and pip runtime is available', () => {
  const original = { PATH: '/usr/bin:/bin', KEEP_ME: 'yes' }
  const env = buildCodeExecutionEnv(original, { platform: 'linux', runtime: null })
  assert.deepEqual(env, original)
  assert.notEqual(env, original)
})

test('code execution output inference finds relative shell and inline Python writes', () => {
  assert.deepEqual(
    inferCodeExecutionOutputPaths('echo generated>reports/result.txt'),
    ['reports/result.txt'],
  )
  assert.deepEqual(
    inferCodeExecutionOutputPaths(`python -c "from pathlib import Path; Path('inline.txt').write_text('ok')"`),
    ['inline.txt'],
  )
  assert.deepEqual(
    inferCodeExecutionOutputPaths(`python -c "open('binary.dat', 'wb').write(b'ok')"`),
    ['binary.dat'],
  )
})

test('codeExecutionFailureHint redirects fragile Windows commands to portable strategies', () => {
  const longInline = `python -c "${'print(1);'.repeat(90)}"`
  assert.match(
    codeExecutionFailureHint(longInline, { platform: 'win32' }),
    /write_file[\s\S]*\.py[\s\S]*expected_outputs/i,
  )
  assert.match(
    codeExecutionFailureHint('pip list 2>&1 | tail -5', { platform: 'win32' }),
    /cmd\.exe[\s\S]*PowerShell/i,
  )
  assert.equal(codeExecutionFailureHint(longInline, { platform: 'linux' }), '')
})
