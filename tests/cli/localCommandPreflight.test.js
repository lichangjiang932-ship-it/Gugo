import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const cli = fileURLToPath(new URL('../../bin/yma-cli.js', import.meta.url))

function fixture(t, { badConfig = true } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'gugo-command-preflight-'))
  const cwd = path.join(root, 'workspace')
  const profile = path.join(root, 'profile')
  const temporary = path.join(root, 'temporary')
  for (const directory of [cwd, profile, temporary]) mkdirSync(directory)
  const config = path.join(root, 'runtime.json')
  if (badConfig) writeFileSync(config, '{not valid runtime configuration')
  const data = path.join(root, 'must-not-be-created')
  const inherited = Object.fromEntries(['SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT'].flatMap((name) => {
    const key = Object.keys(process.env).find((item) => item.toLowerCase() === name.toLowerCase())
    return key ? [[name, process.env[key]]] : []
  }))
  const env = { ...inherited, PATH: path.dirname(process.execPath), HOME: profile, USERPROFILE: profile,
    APPDATA: profile, LOCALAPPDATA: profile, TEMP: temporary, TMP: temporary, TMPDIR: temporary,
    APP_DATA_DIR: data, APP_DB_PATH: path.join(data, 'app.db'), ARTIFACT_DIR: path.join(root, 'artifacts'),
    APP_CONFIG_PATH: config, AUTH_MODE: 'local', MEMORY_EMBEDDINGS_ENABLED: '0' }
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep))
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })
  return { root, cwd, data, run: (args) => spawnSync(process.execPath, [cli, ...args], {
    cwd, env, windowsHide: true, encoding: 'utf8', timeout: 15_000,
  }) }
}

function rejectedBeforeStartup(f, args, code) {
  const result = f.run(args)
  assert.equal(result.error, undefined)
  assert.equal(result.status, 2, result.stdout + result.stderr)
  assert.ok((result.stdout + result.stderr).includes(code), `${code}: ${result.stdout}${result.stderr}`)
  assert.doesNotMatch(result.stdout + result.stderr, /\[env\]|RUNTIME_CONFIG_FILE_INVALID/u)
  assert.equal(existsSync(f.data), false, 'usage errors must not initialize local storage or identity')
}

test('missing goal arguments precede configuration parsing and never initialize local state', (t) => {
  const f = fixture(t)
  for (const [args, code] of [
    [['goal', 'create'], 'CLI_GOAL_OBJECTIVE_REQUIRED'],
    [['goal', 'create', 'objective'], 'CLI_GOAL_STEPS_REQUIRED'],
    [['goal', 'show'], 'CLI_GOAL_PLAN_ID_REQUIRED'],
    [['goal', 'approve'], 'CLI_GOAL_PLAN_ID_REQUIRED'],
    [['goal', 'rewrite', 'plan'], 'CLI_GOAL_STEPS_REQUIRED'],
    [['goal', 'step', 'plan'], 'CLI_GOAL_STEP_ID_REQUIRED'],
    [['goal', 'step', 'plan', 'step'], 'CLI_GOAL_STEP_STATUS_REQUIRED'],
  ]) rejectedBeforeStartup(f, args, code)
})

test('invalid goal JSON and bounded explicit steps files fail before configuration or database I/O', (t) => {
  const f = fixture(t)
  const huge = path.join(f.cwd, 'too-large.json')
  writeFileSync(huge, ' '.repeat(1024 * 1024 + 1))
  const invalid = path.join(f.cwd, 'invalid.json')
  writeFileSync(invalid, '{not steps JSON')
  for (const [args, code] of [
    [['--steps', '{}'], 'CLI_GOAL_STEPS_INVALID'],
    [['--steps', '[]'], 'CLI_GOAL_STEPS_INVALID'],
    [['--steps', '[{}]'], 'GOAL_PLAN_INVALID_INPUT'],
    [['--steps', JSON.stringify(Array.from({ length: 65 }, () => ({ title: 'item' })))], 'GOAL_PLAN_INVALID_INPUT'],
    [['--steps', '[{"title":"item","acceptance":[{"kind":"unknown"}]}]'], 'GOAL_PLAN_INVALID_INPUT'],
    [['--steps-file', 'missing.json'], 'CLI_GOAL_STEPS_UNREADABLE'],
    [['--steps-file', '.'], 'CLI_GOAL_STEPS_UNREADABLE'],
    [['--steps-file', invalid], 'CLI_GOAL_STEPS_INVALID'],
    [['--steps-file', huge], 'CLI_GOAL_STEPS_TOO_LARGE'],
    [['--steps', '[{"title":"inline"}]', '--steps-file', 'missing.json'], 'CLI_GOAL_STEPS_CONFLICT'],
  ]) rejectedBeforeStartup(f, ['goal', 'create', 'objective', ...args], code)
})

test('goal, memory and trace reject unsupported options, duplicates, conflicts and unsafe bounds before startup', (t) => {
  const f = fixture(t)
  for (const [args, code] of [
    [['goal', 'list', '--steps-file', 'missing'], 'CLI_OPTION_UNKNOWN'],
    [['goal', 'show', 'one', 'two'], 'CLI_ARGUMENT_UNEXPECTED'],
    [['goal', 'list', '--limit', '0'], 'CLI_GOAL_LIMIT_INVALID'],
    [['goal', 'approve', 'plan', '--expect-version', '9007199254740992'], 'CLI_GOAL_VERSION_INVALID'],
    [['goal', 'create', 'objective', '--steps', '--bogus'], 'CLI_OPTION_VALUE_REQUIRED'],
    [['memory', 'reindex', '--agent', 'one', '--all-agents'], 'CLI_MEMORY_SCOPE_CONFLICT'],
    [['memory', 'reindex', '--limit', '0'], 'CLI_MEMORY_LIMIT_INVALID'],
    [['memory', 'reindex', '--batch', '33'], 'CLI_MEMORY_BATCH_INVALID'],
    [['memory', 'reindex', '--limit', '1', '--limit', '2'], 'CLI_OPTION_DUPLICATE'],
    [['memory', 'reindex', '--agent', '--bogus'], 'CLI_OPTION_VALUE_REQUIRED'],
    [['trace', 'turn', '--limit', 'not-a-number'], 'CLI_TRACE_LIMIT_INVALID'],
    [['trace', 'turn', '--limit', '10001'], 'CLI_TRACE_LIMIT_INVALID'],
    [['trace', 'turn', '--session-id', '--json'], 'CLI_OPTION_VALUE_REQUIRED'],
    [['trace', 'turn', '--json', '--export', 'yaml'], 'CLI_TRACE_EXPORT_INVALID'],
  ]) rejectedBeforeStartup(f, args, code)
})

test('plain missing goal input does not create a database even when runtime configuration is otherwise valid', (t) => {
  const f = fixture(t, { badConfig: false })
  rejectedBeforeStartup(f, ['goal', 'create'], 'CLI_GOAL_OBJECTIVE_REQUIRED')
})

test('valid relative steps files use the explicit cwd and goal list honors its session scope without env warnings', (t) => {
  const f = fixture(t, { badConfig: false })
  writeFileSync(path.join(f.cwd, 'steps.json'), '[{"title":"Bounded local file"}]')
  for (const sessionId of ['one-session', 'another-session']) {
    const created = f.run(['goal', 'create', 'fixture objective', '--steps-file', 'steps.json', '--session-id', sessionId])
    assert.equal(created.status, 0, created.stdout + created.stderr)
    assert.doesNotMatch(created.stderr, /\[env\]/u)
    assert.equal(JSON.parse(created.stdout).steps[0].title, 'Bounded local file')
  }
  const listed = f.run(['goal', 'list', '--session-id', 'one-session'])
  assert.equal(listed.status, 0, listed.stdout + listed.stderr)
  assert.doesNotMatch(listed.stderr, /\[env\]/u)
  const plans = JSON.parse(listed.stdout).plans
  assert.equal(plans.length, 1)
  assert.equal(plans[0].sessionId, 'one-session')
})
