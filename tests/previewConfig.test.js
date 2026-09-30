import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  DEFAULT_PREVIEW_PORT,
  previewConfigurationSummaries,
  previewConfigPath,
  readPreviewConfig,
  resolveConfigurationCwd,
  writePreviewAutoVerify,
} from '../server/services/previewConfig.js'

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-preview-config-'))
const configDir = path.join(workspace, '.gugo')
fs.mkdirSync(configDir)
fs.mkdirSync(path.join(workspace, 'app'))
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'yma-preview-outside-'))

function writeConfig(value) {
  fs.writeFileSync(previewConfigPath(workspace), typeof value === 'string' ? value : JSON.stringify(value, null, 2), 'utf8')
}

test.after(() => {
  fs.rmSync(workspace, { recursive: true, force: true })
  fs.rmSync(outside, { recursive: true, force: true })
})

test('a workspace with no launch.json is a first state, not a failure', () => {
  fs.rmSync(previewConfigPath(workspace), { force: true })
  const read = readPreviewConfig({ workspaceRoot: workspace })
  assert.equal(read.ok, true)
  assert.equal(read.missing, true)
  assert.deepEqual(read.problems, [])
  assert.equal(read.config, null)
  assert.equal(read.path, previewConfigPath(workspace))
})

test('an unparseable or structurally wrong file reports every problem it can name', () => {
  writeConfig('{ "version": "0.0.1",')
  const broken = readPreviewConfig({ workspaceRoot: workspace })
  assert.equal(broken.ok, false)
  assert.match(broken.problems[0], /不是合法 JSON/)

  writeConfig({ version: '0.0.1' })
  const noConfigurations = readPreviewConfig({ workspaceRoot: workspace })
  assert.equal(noConfigurations.ok, false)
  assert.match(noConfigurations.problems.join(' '), /configurations 至少需要一个条目/)
})

test('a valid configuration is normalized with the documented defaults', () => {
  writeConfig({
    version: '0.0.1',
    autoVerify: true,
    configurations: [{ name: 'dev-server', runtimeExecutable: 'npm', runtimeArgs: ['run', 'dev'] }],
  })
  const read = readPreviewConfig({ workspaceRoot: workspace })
  assert.equal(read.ok, true)
  const [configuration] = read.config.configurations
  assert.equal(read.config.autoVerify, true)
  assert.equal(configuration.executable, 'npm')
  assert.deepEqual(configuration.args, ['run', 'dev'])
  assert.equal(configuration.port, DEFAULT_PREVIEW_PORT)
  assert.equal(configuration.portExplicit, false)
  // An absent autoPort is not a silent "find a port": the spec asks the reader.
  assert.equal(configuration.autoPort, null)
  assert.equal(configuration.cwd, '${workspaceFolder}')
  assert.equal(configuration.url, '')
  assert.equal(configuration.readyPattern, '')
  assert.deepEqual(read.config.configurations[0].env, {})

  assert.deepEqual(previewConfigurationSummaries(read.config), [{
    name: 'dev-server',
    command: 'npm run dev',
    port: DEFAULT_PREVIEW_PORT,
    url: `http://localhost:${DEFAULT_PREVIEW_PORT}`,
    autoPort: false,
  }])
})

test('the environment block refuses anything that looks like a credential', () => {
  writeConfig({
    configurations: [{
      name: 'dev',
      program: 'node',
      args: ['server.js'],
      env: {
        NODE_ENV: 'development',
        API_KEY: 'whatever',
        SESSION_TOKEN: 'x',
        DB_PASSWORD: 'x',
        // A name that merely contains the letters is not a credential name.
        MONKEY: 'banana',
        // A value that is clearly a key is refused whatever it is called.
        GITHUB_PAT: 'ghp_0123456789abcdefghijklmnopqrstuvwxyz',
        OPAQUE: 'aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3xY5zA7b',
      },
    }],
  })
  const read = readPreviewConfig({ workspaceRoot: workspace })
  assert.equal(read.ok, false)
  const joined = read.problems.join('\n')
  assert.match(joined, /env\.API_KEY/)
  assert.match(joined, /env\.SESSION_TOKEN/)
  assert.match(joined, /env\.DB_PASSWORD/)
  assert.match(joined, /env\.GITHUB_PAT/)
  assert.match(joined, /env\.OPAQUE/)
  assert.doesNotMatch(joined, /MONKEY/)
  // The refusal is per entry: the settings beside the secrets survive.
  const [configuration] = read.config.configurations
  assert.deepEqual(configuration.env, { MONKEY: 'banana', NODE_ENV: 'development' })
})

test('a configuration must name exactly one way to start', () => {
  writeConfig({ configurations: [{ name: 'both', runtimeExecutable: 'npm', program: 'node' }] })
  assert.match(readPreviewConfig({ workspaceRoot: workspace }).problems.join(' '), /只能声明 runtimeExecutable 或 program 之一/)

  writeConfig({ configurations: [{ name: 'neither', args: [] }] })
  assert.match(readPreviewConfig({ workspaceRoot: workspace }).problems.join(' '), /只能声明 runtimeExecutable 或 program 之一/)
})

test('ports, urls and arguments are validated against what can actually run', () => {
  writeConfig({
    configurations: [
      { name: 'bad-port', program: 'node', port: 70_000 },
      { name: 'bad-url', program: 'node', url: 'https://example.invalid/preview' },
      { name: 'path-url', program: 'node', url: 'http://localhost:3000/deep/link' },
      { name: 'quoted', program: 'node', args: ['--define=A="b c"'] },
      { name: 'duplicate', program: 'node' },
      { name: 'duplicate', program: 'node' },
    ],
  })
  const read = readPreviewConfig({ workspaceRoot: workspace })
  assert.equal(read.ok, false)
  const joined = read.problems.join('\n')
  assert.match(joined, /configurations\[0\]\.port/)
  assert.match(joined, /预览不打开外部站点/)
  assert.match(joined, /不能带路径或查询参数/)
  assert.match(joined, /不能包含引号或控制字符/)
  assert.match(joined, /配置名重复：duplicate/)
  // A localhost origin is accepted as written.
  writeConfig({ configurations: [{ name: 'local', program: 'node', url: 'http://127.0.0.1:5173' }] })
  const local = readPreviewConfig({ workspaceRoot: workspace })
  assert.equal(local.ok, true)
  assert.equal(local.config.configurations[0].url, 'http://127.0.0.1:5173')
})

test('the working directory resolves inside the workspace and must exist', () => {
  const configuration = { cwd: '${workspaceFolder}/app' }
  const inside = resolveConfigurationCwd(configuration, workspace)
  assert.equal(inside.ok, true)
  assert.equal(inside.path, path.join(workspace, 'app'))

  const missing = resolveConfigurationCwd({ cwd: '${workspaceFolder}/nope' }, workspace)
  assert.equal(missing.ok, false)
  assert.match(missing.reason, /不是已存在的目录/)

  const escaped = resolveConfigurationCwd({ cwd: outside }, workspace)
  assert.equal(escaped.ok, false)
  assert.match(escaped.reason, /必须位于工作区内/)

  const traversed = resolveConfigurationCwd({ cwd: '../..' }, workspace)
  assert.equal(traversed.ok, false)
})

test('the autoVerify switch rewrites one field and leaves the rest of the file alone', () => {
  writeConfig({
    version: '0.0.1',
    autoVerify: true,
    // A field this app knows nothing about must survive a write.
    comment: 'keep me',
    configurations: [{ name: 'dev', program: 'node', args: ['server.js'], port: 4321 }],
  })
  const written = writePreviewAutoVerify({ workspaceRoot: workspace, autoVerify: false })
  assert.equal(written.ok, true)
  const raw = JSON.parse(fs.readFileSync(previewConfigPath(workspace), 'utf8'))
  assert.equal(raw.autoVerify, false)
  assert.equal(raw.comment, 'keep me')
  assert.equal(raw.configurations[0].port, 4321)

  assert.equal(writePreviewAutoVerify({ workspaceRoot: workspace, autoVerify: 'yes' }).ok, false)
  // No stray temporary files: the write either happens or does not.
  assert.deepEqual(fs.readdirSync(configDir), ['launch.json'])
})
