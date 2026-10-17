import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  createIsolatedWebEnvironment,
  createIsolatedWebViteOptions,
} from '../scripts/verify-isolated-web.mjs'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const helperUrl = pathToFileURL(path.join(projectRoot, 'scripts/verify-isolated-web.mjs')).href
const viteUrl = pathToFileURL(path.join(projectRoot, 'node_modules/vite/dist/node/index.js')).href

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-web-isolation-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

const isolatedPaths = [
  'HOME', 'USERPROFILE', 'GUGO_HOME', 'APPDATA', 'LOCALAPPDATA',
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'APP_DATA_DIR', 'APP_DB_PATH', 'APP_CONFIG_PATH',
  'ARTIFACT_DIR', 'WORKSPACE_ROOT', 'TEMP', 'TMP', 'TMPDIR',
  'npm_config_cache', 'npm_config_userconfig', 'npm_config_globalconfig',
]

function assertContained(root, value) {
  assert.equal(path.isAbsolute(value), true)
  const relative = path.relative(root, value)
  assert.ok(relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), value)
}

test('isolated web environment overrides all user/config roots and drops deployment values', (t) => {
  const runRoot = temporaryRoot(t)
  const sourceEnv = Object.freeze({
    Path: 'fixture-path', SystemRoot: 'fixture-system', HOME: 'real-home',
    USERPROFILE: 'real-profile', GUGO_HOME: 'real-config', app_db_path: 'real.db',
    NODE_OPTIONS: '--require=must-not-run.cjs', NODE_PATH: 'must-not-load',
    MODEL_API_KEY: 'synthetic-secret', VITE_MODEL_API_KEY: 'synthetic-secret',
    OPENAI_API_KEY: 'synthetic-secret', HTTP_PROXY: 'must-not-contact',
    GUGO_LOAD_DOTENV: '1', CODEX_APP_SERVER_ENABLED: '1', MCP_STDIO_ENABLED: '1',
  })
  const env = createIsolatedWebEnvironment({ sourceEnv, runRoot, projectRoot, port: 5179 })
  for (const key of isolatedPaths) assertContained(runRoot, env[key])
  for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'MODEL_API_KEY', 'VITE_MODEL_API_KEY', 'OPENAI_API_KEY', 'HTTP_PROXY', 'app_db_path']) {
    assert.equal(env[key], undefined, key)
  }
  assert.equal(env.GUGO_LOAD_DOTENV, '0')
  assert.equal(env.SERVER_HOST, '127.0.0.1')
  assert.equal(env.CODEX_APP_SERVER_ENABLED, '0')
  assert.equal(env.MCP_STDIO_ENABLED, '0')
  assert.equal(env.PATH, 'fixture-path')
  assert.equal(sourceEnv.HOME, 'real-home')
})

test('isolated web rejects implicit roots and invalid ports instead of falling back', () => {
  const runRoot = path.resolve(os.tmpdir(), 'synthetic-web-root')
  for (const options of [{}, { runRoot: '.', projectRoot }, { runRoot, projectRoot: '.' }]) {
    assert.throws(() => createIsolatedWebEnvironment({ sourceEnv: {}, port: 5179, ...options }), /absolute/)
  }
  for (const port of [0, -1, 65536, 1.5, '5179']) {
    assert.throws(() => createIsolatedWebEnvironment({ sourceEnv: {}, runRoot, projectRoot, port }), /port/)
  }
  assert.throws(() => createIsolatedWebViteOptions({ runRoot: projectRoot, projectRoot, port: 5179 }), /outside/)
})

test('isolated Vite options disable automatic dotenv and anchor temporary outputs', (t) => {
  const runRoot = temporaryRoot(t)
  const options = createIsolatedWebViteOptions({ runRoot, projectRoot, port: 5179 })
  assert.equal(options.envDir, false)
  assert.equal(options.configLoader, 'native')
  assert.equal(options.configFile, path.join(projectRoot, 'vite.config.js'))
  assertContained(runRoot, options.build.outDir)
  assert.equal(options.preview.host, '127.0.0.1')
  assert.equal(options.preview.port, 5179)
  assert.equal(options.preview.strictPort, true)
})

test('direct internal worker invocation fails before importing Vite or clearing an existing output', (t) => {
  const runRoot = temporaryRoot(t)
  const dist = path.join(runRoot, 'dist')
  fs.mkdirSync(dist)
  const marker = path.join(dist, 'keep.txt')
  fs.writeFileSync(marker, 'must remain')
  const env = createIsolatedWebEnvironment({ runRoot, projectRoot, port: 5179 })
  env.VITE_ISOLATION_SENTINEL = 'synthetic-worker-must-not-build'
  const child = spawnSync(process.execPath, [
    fileURLToPath(helperUrl), '--internal-worker', 'build', runRoot, '5179',
  ], { cwd: projectRoot, env, encoding: 'utf8', timeout: 30_000, windowsHide: true })
  assert.equal(child.status, 1, child.error?.message || child.stderr || child.stdout)
  assert.match(child.stderr, /worker requires parent IPC/)
  assert.ok(!child.stdout.includes('build ready'))
  assert.equal(fs.readFileSync(marker, 'utf8'), 'must remain')
})

test('worker rejects a polluted IPC environment before importing production Vite', async (t) => {
  const runRoot = temporaryRoot(t)
  const env = createIsolatedWebEnvironment({ runRoot, projectRoot, port: 5179 })
  if (process.platform === 'win32') env.VITE_ISOLATION_SENTINEL = 'synthetic-must-be-rejected'
  else {
    env.GUGO_LOAD_DOTENV = '1'
    env.gugo_load_dotenv = '0'
  }
  const { spawn } = await import('node:child_process')
  const child = spawn(process.execPath, [fileURLToPath(helperUrl), '--internal-worker'], {
    cwd: projectRoot, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true,
  })
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  child.stdout.resume()
  const status = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('worker rejection timed out')) }, 15_000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); resolve(code) })
    child.once('spawn', () => child.send({ mode: 'build', runRoot, port: 5179 }))
  })
  assert.equal(status, 1, stderr)
  assert.match(stderr, /environment or cwd is not isolated/)
  assert.equal(fs.existsSync(path.join(runRoot, 'dist')), false)
})

test('public CLI rejects malformed flags without creating a build', (t) => {
  const runRoot = temporaryRoot(t)
  const env = createIsolatedWebEnvironment({ runRoot, projectRoot, port: 5179 })
  for (const args of [['--build', '--preview'], ['--port'], ['--port', '0'], ['--build', '--build']]) {
    const child = spawnSync(process.execPath, [fileURLToPath(helperUrl), ...args], {
      cwd: projectRoot, env, encoding: 'utf8', timeout: 15_000, windowsHide: true,
    })
    assert.equal(child.status, 1, child.error?.message || child.stderr)
    assert.ok(!child.stdout.includes('temporary roots'))
  }
})

test('public CLI builds production config from an unrelated cwd and strips inherited frontend values', (t) => {
  const runRoot = temporaryRoot(t)
  const env = createIsolatedWebEnvironment({ runRoot, projectRoot, port: 5179 })
  env.VITE_ISOLATION_SENTINEL = 'synthetic-public-cli-must-not-leak'
  env.GUGO_LOAD_DOTENV = '1'
  env.APP_DB_PATH = path.join(runRoot, 'must-not-create.db')
  fs.mkdirSync(env.TEMP, { recursive: true })
  const child = spawnSync(process.execPath, [fileURLToPath(helperUrl), '--build'], {
    cwd: runRoot, env, encoding: 'utf8', timeout: 90_000, windowsHide: true,
  })
  const outputRoot = child.stdout.match(/\[isolated-web\] temporary roots: (.+)/)?.[1]?.trim()
  if (outputRoot) t.after(() => fs.rmSync(outputRoot, { recursive: true, force: true }))
  assert.equal(child.status, 0, child.error?.message || child.stderr || child.stdout)
  assert.ok(outputRoot)
  assert.ok(child.stdout.includes('[isolated-web] build ready:'))
  assert.doesNotMatch(child.stderr, /content.*missing or empty/)
  assert.equal(fs.existsSync(env.APP_DB_PATH), false)
  const assetsDir = path.join(outputRoot, 'dist', 'assets')
  const assets = fs.readdirSync(assetsDir).filter(name => /\.(js|css)$/.test(name))
  const output = assets.map(name => fs.readFileSync(path.join(assetsDir, name), 'utf8')).join('')
  assert.ok(!output.includes(env.VITE_ISOLATION_SENTINEL))
  assert.ok(assets.some(name => name.startsWith('index-') && name.endsWith('.css')))
})

test('real Vite build and preview resolution ignore synthetic dotenv while normal Vite still loads it', async (t) => {
  const runRoot = temporaryRoot(t)
  const fixture = path.join(runRoot, 'fixture')
  fs.mkdirSync(fixture)
  const sentinel = 'synthetic-dotenv-value-must-not-load'
  fs.writeFileSync(path.join(fixture, '.env'), `VITE_ISOLATION_SENTINEL=${sentinel}\n`)
  fs.writeFileSync(path.join(fixture, '.env.production.local'), `VITE_LOCAL_SENTINEL=${sentinel}\n`)
  fs.writeFileSync(path.join(fixture, 'index.html'), '<script type="module" src="/entry.js"></script>')
  fs.writeFileSync(path.join(fixture, 'entry.js'), 'document.body.textContent = JSON.stringify(import.meta.env);')
  fs.writeFileSync(path.join(fixture, 'vite.config.js'), `export default () => {
    if (process.env.GUGO_LOAD_DOTENV !== '0') throw new Error('manual dotenv gate missing');
    return { root: ${JSON.stringify(fixture)} };
  }`)
  const env = createIsolatedWebEnvironment({ runRoot, projectRoot, port: 5179 })
  for (const key of isolatedPaths) {
    const target = ['APP_DB_PATH', 'APP_CONFIG_PATH', 'npm_config_userconfig', 'npm_config_globalconfig'].includes(key)
      ? path.dirname(env[key]) : env[key]
    fs.mkdirSync(target, { recursive: true })
  }
  const probe = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import path from 'node:path';
    const { build, resolveConfig } = await import(${JSON.stringify(viteUrl)});
    const { createIsolatedWebViteOptions } = await import(${JSON.stringify(helperUrl)});
    const options = createIsolatedWebViteOptions(${JSON.stringify({ runRoot, projectRoot: fixture, port: 5179 })});
    const report = {};
    for (const command of ['build', 'serve']) {
      const config = await resolveConfig(options, command, 'production', 'production', command === 'serve');
      assert.equal(config.env.VITE_ISOLATION_SENTINEL, undefined);
      assert.equal(config.env.VITE_LOCAL_SENTINEL, undefined);
      report[command] = config.envDir;
    }
    await build({ ...options, logLevel: 'silent' });
    const assets = fs.readdirSync(path.join(options.build.outDir, 'assets'));
    const output = assets.map(name => fs.readFileSync(path.join(options.build.outDir, 'assets', name), 'utf8')).join('');
    assert.ok(!output.includes(${JSON.stringify(sentinel)}));
    const normal = await resolveConfig({ root: ${JSON.stringify(fixture)}, configFile: false }, 'build');
    assert.equal(normal.env.VITE_ISOLATION_SENTINEL, ${JSON.stringify(sentinel)});
    process.stdout.write(JSON.stringify({ ...report, outputContainsSentinel: false, ordinaryEnvLoads: true }));
  `
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', probe], {
    cwd: runRoot, env, encoding: 'utf8', timeout: 90_000, windowsHide: true,
  })
  assert.equal(child.status, 0, child.error?.message || child.stderr || child.stdout)
  assert.deepEqual(JSON.parse(child.stdout), {
    build: false, serve: false, outputContainsSentinel: false, ordinaryEnvLoads: true,
  })
  assert.equal(fs.readFileSync(path.join(fixture, '.env'), 'utf8'), `VITE_ISOLATION_SENTINEL=${sentinel}\n`)
})
