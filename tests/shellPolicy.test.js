import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyShellNetworkUse,
  checkShellNetworkPolicy,
  describeShellPolicy,
  resolveShellNetworkMode,
} from '../server/utils/shellPolicy.js'

test('classify finds direct network commands including env-assignment prefixes', () => {
  assert.deepEqual(classifyShellNetworkUse('curl https://example.com'), [{ kind: 'command', name: 'curl' }])
  assert.deepEqual(classifyShellNetworkUse('FOO=bar wget -qO- https://x'), [{ kind: 'command', name: 'wget' }])
  assert.deepEqual(classifyShellNetworkUse('curl.exe https://example.com'), [{ kind: 'command', name: 'curl' }])
})

test('classify covers git/npm/pip network subcommands and powershell cmdlets', () => {
  assert.deepEqual(classifyShellNetworkUse('git clone https://github.com/x/y'), [{ kind: 'git', name: 'git clone' }])
  assert.deepEqual(classifyShellNetworkUse('npm install left-pad'), [{ kind: 'npm', name: 'npm install' }])
  assert.deepEqual(classifyShellNetworkUse('pip3 install requests'), [{ kind: 'pip3', name: 'pip3 install' }])
  assert.deepEqual(classifyShellNetworkUse('python -m pip install requests'), [{ kind: 'python', name: 'python -m pip install' }])
  assert.ok(classifyShellNetworkUse('iwr https://x').some((use) => use.kind === 'powershell'))
})

test('local-only workflows stay unclassified', () => {
  for (const cmd of [
    'ls -la',
    'cat package.json | grep name',
    'git status && git diff --stat',
    'git log --oneline | head',
    'npm run build',
    'npm test',
    'pip list',
    'python script.py --local',
    'echo "curl https://inside-a-string" > note.txt',
  ]) {
    assert.deepEqual(classifyShellNetworkUse(cmd), [], `should not classify: ${cmd}`)
  }
})

test('segments split on shell operators but not inside quotes', () => {
  const uses = classifyShellNetworkUse('npm run build && curl https://x | tar xz')
  assert.deepEqual(uses, [{ kind: 'command', name: 'curl' }])
})

test('default mode is allow and policy passes everything', () => {
  assert.equal(resolveShellNetworkMode(), 'allow')
  assert.equal(checkShellNetworkPolicy('curl https://example.com'), null)
  assert.deepEqual(describeShellPolicy({}), { networkMode: 'allow' })
})

test('deny mode blocks classified uses with a readable reason and code', () => {
  const env = { GUGO_SHELL_NETWORK_MODE: 'deny' }
  assert.equal(resolveShellNetworkMode(env), 'deny')
  const denial = checkShellNetworkPolicy('npm install && curl https://x', env)
  assert.ok(denial)
  assert.equal(denial.code, 'SHELL_NETWORK_DENIED')
  assert.match(denial.reason, /npm install/)
  assert.match(denial.reason, /curl/)
  // 本地命令不受影响
  assert.equal(checkShellNetworkPolicy('ls -la && npm run build', env), null)
})

test('unknown mode values fall back to allow', () => {
  assert.equal(resolveShellNetworkMode({ GUGO_SHELL_NETWORK_MODE: 'YOLO' }), 'allow')
})
