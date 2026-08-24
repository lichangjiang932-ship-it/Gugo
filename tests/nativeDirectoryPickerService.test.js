import assert from 'node:assert/strict'
import test from 'node:test'

import { selectNativeDirectory } from '../server/services/nativeDirectoryPickerService.js'

test('non-Windows native directory picker is explicitly unsupported without spawning', async () => {
  let calls = 0
  const result = await selectNativeDirectory({}, {
    platform: 'linux',
    execFileImpl() { calls += 1 },
  })

  assert.deepEqual(result, { supported: false, canceled: false, path: '' })
  assert.equal(calls, 0)
})

test('Windows native directory picker uses a fixed encoded script and keeps paths out of argv', async () => {
  const calls = []
  const dangerousDefaultPath = "C:\\项目 & tools\\$(calc); 'quoted'"
  const selectedPath = 'C:\\Users\\Alice\\Selected Project'
  const result = await selectNativeDirectory({ defaultPath: dangerousDefaultPath }, {
    platform: 'win32',
    env: {
      SystemRoot: 'C:\\Windows',
      OPENAI_API_KEY: 'must-not-reach-powershell',
      NODE_OPTIONS: '--require attacker.js',
    },
    canonicalizeDirectory(value) { return value },
    execFileImpl(command, args, options, callback) {
      calls.push({ command, args, options })
      callback(null, JSON.stringify({ canceled: false, path: selectedPath }), '')
    },
  })

  assert.deepEqual(result, { supported: true, canceled: false, path: selectedPath })
  assert.equal(calls.length, 1)
  const [{ command, args, options }] = calls
  assert.equal(command, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  assert.deepEqual(args.slice(0, -1), [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Sta',
    '-EncodedCommand',
  ])
  const script = Buffer.from(args.at(-1), 'base64').toString('utf16le')
  assert.match(script, /interface IFileOpenDialog/)
  assert.match(script, /FOS_PICKFOLDERS/)
  assert.match(script, /FOS_FORCEFILESYSTEM/)
  assert.match(script, /SHCreateItemFromParsingName/)
  assert.match(script, /SIGDN_FILESYSPATH/)
  assert.match(script, /dialog\.Show\(ownerHandle\)/)
  assert.match(script, /GugoExplorerFolderPicker\]::PickFolder/)
  assert.doesNotMatch(script, /FolderBrowserDialog/)
  assert.match(script, /TopMost = \$true/)
  assert.match(script, /\$owner\.Handle/)
  assert.match(script, /if \(\$owner\.Visible\) \{ \$owner\.Close\(\) \}/)
  assert.match(script, /\$owner\.Dispose\(\)/)
  assert.match(script, /GUGO_NATIVE_DIRECTORY_PICKER_DEFAULT/)
  assert.doesNotMatch(script, /项目 & tools|calc|quoted|Selected Project/)
  assert.equal(options.env.GUGO_NATIVE_DIRECTORY_PICKER_DEFAULT, dangerousDefaultPath)
  assert.equal(options.env.OPENAI_API_KEY, undefined)
  assert.equal(options.env.NODE_OPTIONS, undefined)
  assert.equal(options.shell, false)
  assert.equal(options.windowsHide, true)
  assert.equal(options.maxBuffer, 64 * 1024)
  assert.equal(options.timeout, 10 * 60_000)
  assert.equal(options.killSignal, 'SIGKILL')
})

test('Windows native directory picker distinguishes cancel, unavailable runtime, and failures', async () => {
  const canceled = await selectNativeDirectory({}, {
    platform: 'win32',
    canonicalizeDirectory(value) { return value },
    execFileImpl(_command, _args, _options, callback) {
      callback(null, JSON.stringify({ canceled: true, path: '' }), '')
    },
  })
  assert.deepEqual(canceled, { supported: true, canceled: true, path: '' })

  const unavailable = await selectNativeDirectory({}, {
    platform: 'win32',
    execFileImpl(_command, _args, _options, callback) {
      callback(Object.assign(new Error('PowerShell unavailable'), { code: 'ENOENT' }), '', '')
    },
  })
  assert.deepEqual(unavailable, { supported: false, canceled: false, path: '' })

  await assert.rejects(
    () => selectNativeDirectory({}, {
      platform: 'win32',
      execFileImpl(_command, _args, _options, callback) {
        callback(null, 'not-json', '')
      },
    }),
    (error) => error?.code === 'NATIVE_DIRECTORY_PICKER_FAILED' && error?.statusCode === 500,
  )

  await assert.rejects(
    () => selectNativeDirectory({}, {
      platform: 'win32',
      execFileImpl(_command, _args, _options, callback) {
        callback(new Error('dialog failed'), '', '')
      },
    }),
    (error) => error?.code === 'NATIVE_DIRECTORY_PICKER_FAILED',
  )
})

test('Windows native directory picker times out safely and allows only one active dialog', async () => {
  await assert.rejects(
    () => selectNativeDirectory({}, {
      platform: 'win32',
      execFileImpl(_command, _args, _options, callback) {
        callback(Object.assign(new Error('timed out'), { killed: true, signal: 'SIGKILL' }), '', '')
      },
    }),
    (error) => error?.code === 'NATIVE_DIRECTORY_PICKER_TIMEOUT' && error?.statusCode === 504,
  )

  let finishFirst
  const first = selectNativeDirectory({}, {
    platform: 'win32',
    canonicalizeDirectory(value) { return value },
    execFileImpl(_command, _args, _options, callback) {
      finishFirst = callback
    },
  })
  await Promise.resolve()
  await assert.rejects(
    () => selectNativeDirectory({}, { platform: 'win32' }),
    (error) => error?.code === 'NATIVE_DIRECTORY_PICKER_BUSY' && error?.statusCode === 409,
  )
  finishFirst(null, JSON.stringify({ canceled: true, path: '' }), '')
  assert.deepEqual(await first, { supported: true, canceled: true, path: '' })
})

test('Windows native directory picker reports an invalid selected directory instead of falling back', async () => {
  await assert.rejects(
    () => selectNativeDirectory({}, {
      platform: 'win32',
      canonicalizeDirectory() { throw new Error('missing') },
      execFileImpl(_command, _args, _options, callback) {
        callback(null, JSON.stringify({ canceled: false, path: 'C:\\missing' }), '')
      },
    }),
    (error) => error?.code === 'NATIVE_DIRECTORY_PICKER_SELECTED_PATH_INVALID'
      && error?.statusCode === 422,
  )
})

test('Windows native directory picker rejects unsafe default path shapes before spawning', async () => {
  let calls = 0
  const options = {
    platform: 'win32',
    execFileImpl() { calls += 1 },
  }
  await assert.rejects(
    () => selectNativeDirectory({ defaultPath: 'relative\\project' }, options),
    (error) => error?.code === 'NATIVE_DIRECTORY_PICKER_DEFAULT_PATH_ABSOLUTE_REQUIRED'
      && error?.statusCode === 400,
  )
  await assert.rejects(
    () => selectNativeDirectory({ defaultPath: `C:\\${'a'.repeat(2050)}` }, options),
    (error) => error?.code === 'NATIVE_DIRECTORY_PICKER_DEFAULT_PATH_TOO_LONG'
      && error?.statusCode === 400,
  )
  assert.equal(calls, 0)
})
