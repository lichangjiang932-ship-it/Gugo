import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import { resolveMcpStdioCommand } from '../server/mcp/mcpStdioCommand.js'

const normalize = (file) => path.win32.normalize(file).toLowerCase()

function resolverOptions({ files = [], aliases = {}, npm = [], ...overrides } = {}) {
  const available = new Set(files.map(normalize))
  const symlinks = new Map(Object.entries(aliases).map(([file, target]) => [normalize(file), target]))
  const npmPackages = new Set(npm.map(normalize))
  return {
    platform: 'win32', executablePath: 'C:\\Trusted Node\\node.exe', cwd: 'C:\\Workspace',
    sourceEnv: { Path: ';relative;C:\\Workspace;C:\\Workspace\\bin;C:\\Tools;C:\\Trusted & Tools' },
    isFileFn: (file) => available.has(normalize(file)),
    realpathFn: (file) => symlinks.get(normalize(file)) || path.win32.normalize(file),
    packageNameFn: (file) => npmPackages.has(normalize(file)) ? 'npm' : null,
    ...overrides,
  }
}

test('node resolves to the running native executable rather than PATH or a .cmd shim', () => {
  const options = resolverOptions({ files: ['C:\\Trusted Node\\node.exe', 'C:\\Tools\\node.exe', 'C:\\Workspace\\node.cmd'] })
  for (const command of ['node', 'node.exe', 'NODE.EXE']) {
    assert.deepEqual(resolveMcpStdioCommand({ command, args: ['--version'] }, options), {
      command: 'C:\\Trusted Node\\node.exe', args: ['--version'],
    })
  }
})

test('python/python3/uvx resolve only native exe files from absolute host PATH entries', () => {
  for (const name of ['python', 'python3', 'uvx']) {
    const options = resolverOptions({ files: [`C:\\Tools\\${name}.exe`, `C:\\Workspace\\bin\\${name}.exe`] })
    const result = resolveMcpStdioCommand({ command: name, args: ['-V'] }, options)
    assert.equal(result.command, `C:\\Tools\\${name}.exe`)
    assert.deepEqual(result.args, ['-V'])
  }
})

test('desktop Electron executable is not mistaken for Node or relaunched with injection flags', () => {
  const options = resolverOptions({ executablePath: 'C:\\Desktop\\Gugo.exe',
    files: ['C:\\Desktop\\Gugo.exe', 'C:\\Tools\\node.exe', 'C:\\Tools\\node_modules\\npm\\bin\\npx-cli.js'],
    npm: ['C:\\Tools\\node_modules\\npm\\package.json'],
  })
  assert.equal(resolveMcpStdioCommand({ command: 'node' }, options).command, 'C:\\Tools\\node.exe')
  assert.deepEqual(resolveMcpStdioCommand({ command: 'npx', args: ['--version'] }, options), {
    command: 'C:\\Tools\\node.exe', args: ['C:\\Tools\\node_modules\\npm\\bin\\npx-cli.js', '--version'],
  })
  assert.throws(() => resolveMcpStdioCommand({ command: 'node' }, resolverOptions({
    executablePath: 'C:\\Desktop\\Gugo.exe', files: ['C:\\Desktop\\Gugo.exe'],
  })), { code: 'MCP_STDIO_EXECUTABLE_NOT_FOUND' })
})

test('cwd, relative PATH and a PATH symlink into the workspace cannot supply a bare executable', () => {
  const options = resolverOptions({
    files: ['C:\\Workspace\\python.exe', 'C:\\Tools\\python.exe'],
    aliases: { 'C:\\Tools\\python.exe': 'C:\\Workspace\\payload.exe' },
  })
  assert.throws(() => resolveMcpStdioCommand({ command: 'python' }, options), { code: 'MCP_STDIO_EXECUTABLE_NOT_FOUND' })
})

test('explicit absolute executables remain possible only for bootstrap to authorize', () => {
  const command = 'C:\\approved 中文 &%\\custom.exe'
  const options = resolverOptions({ files: [command] })
  assert.deepEqual(resolveMcpStdioCommand({ command, args: ['a|b', '%PATH%', '^c', '"quoted"'] }, options), {
    command, args: ['a|b', '%PATH%', '^c', '"quoted"'],
  })
})

test('npm/npx use native Node plus the locally installed CLI and literal arguments', () => {
  for (const name of ['npm', 'npx']) {
    const cli = `C:\\Trusted Node\\node_modules\\npm\\bin\\${name}-cli.js`
    const options = resolverOptions({
      files: ['C:\\Trusted Node\\node.exe', cli],
      npm: ['C:\\Trusted Node\\node_modules\\npm\\package.json'],
      sourceEnv: { PATH: 'C:\\Tools', npm_execpath: 'C:\\Workspace\\evil.js' },
    })
    for (const command of [name, `${name}.cmd`]) {
      const args = ['a&b', 'x|y', '%PATH%', '^caret', '中文 空格']
      assert.deepEqual(resolveMcpStdioCommand({ command, args }, options), {
        command: 'C:\\Trusted Node\\node.exe', args: [cli, ...args],
      })
    }
  }
})

test('an explicit npm shim keeps its own installation binding', () => {
  const command = 'C:\\Installed npm 中文\\npx.cmd'
  const cli = 'C:\\Installed npm 中文\\node_modules\\npm\\bin\\npx-cli.js'
  const options = resolverOptions({
    files: [command, cli, 'C:\\Trusted Node\\node.exe'],
    npm: ['C:\\Installed npm 中文\\node_modules\\npm\\package.json'],
  })
  assert.deepEqual(resolveMcpStdioCommand({ command, args: ['--version'] }, options), {
    command: 'C:\\Trusted Node\\node.exe', args: [cli, '--version'],
  })
})

test('npm lookup refuses a CLI escaping its package root or a forged package identity', () => {
  const cli = 'C:\\Trusted Node\\node_modules\\npm\\bin\\npx-cli.js'
  const files = ['C:\\Trusted Node\\node.exe', cli]
  const escaped = resolverOptions({ files,
    npm: ['C:\\Trusted Node\\node_modules\\npm\\package.json'],
    aliases: { [cli]: 'C:\\Workspace\\evil.js' },
  })
  assert.throws(() => resolveMcpStdioCommand({ command: 'npx' }, escaped), { code: 'MCP_STDIO_NPM_CLI_NOT_FOUND' })
  assert.throws(() => resolveMcpStdioCommand({ command: 'npx' }, resolverOptions({ files })), { code: 'MCP_STDIO_NPM_CLI_NOT_FOUND' })
})

test('Windows never falls back to arbitrary cmd/bat/ps1 shims or relative paths', () => {
  const options = resolverOptions()
  for (const command of ['python.cmd', 'uvx.bat', 'anything.ps1']) {
    assert.throws(() => resolveMcpStdioCommand({ command }, options), { code: 'MCP_STDIO_COMMAND_UNSUPPORTED' })
  }
  for (const command of ['.\\node.exe', '..\\npx.cmd']) {
    assert.throws(() => resolveMcpStdioCommand({ command }, options), { code: 'MCP_STDIO_COMMAND_INVALID' })
  }
})

test('invalid commands and non-string/NUL args fail before process creation', () => {
  for (const command of ['', ' node', '"C:\\Node\\node.exe"', 'node\n']) {
    assert.throws(() => resolveMcpStdioCommand({ command }), { code: 'MCP_STDIO_COMMAND_INVALID' })
  }
  for (const args of ['--version', [42], ['a\0b']]) {
    assert.throws(() => resolveMcpStdioCommand({ command: 'node', args }), { code: 'MCP_STDIO_ARGUMENTS_INVALID' })
  }
})

test('non-Windows launch retains normal executable semantics and copies the argument array', () => {
  const args = ['--version', '&literal']
  const result = resolveMcpStdioCommand({ command: 'python3', args }, { platform: 'linux' })
  assert.deepEqual(result, { command: 'python3', args })
  assert.notEqual(result.args, args)
})
