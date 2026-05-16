import test from 'node:test'
import assert from 'node:assert/strict'

import { executeToolCall } from '../src/lib/tools/index.js'

test('create_react_component returns artifact with type=react and forwards code', async () => {
  const code = `function Hello(){return React.createElement('h1',null,'hi')}\nexport default Hello`
  const result = await executeToolCall({
    name: 'create_react_component',
    arguments: JSON.stringify({ title: '问候组件', code, description: '一个简单 h1' }),
  })
  assert.equal(result.ok, true)
  assert.equal(result.artifact?.type, 'react')
  assert.equal(result.artifact?.title, '问候组件')
  assert.equal(result.artifact?.source, code)
  assert.equal(result.artifact?.description, '一个简单 h1')
})

test('create_react_component rejects code containing fetch / network access', async () => {
  const code = `function Bad(){fetch('/x');return null}\nexport default Bad`
  const result = await executeToolCall({
    name: 'create_react_component',
    arguments: JSON.stringify({ title: 'bad', code }),
  })
  assert.equal(result.ok, false)
  const payload = JSON.parse(result.content)
  assert.match(String(payload.error || ''), /沙箱禁用网络请求/)
})

test('create_react_component rejects import statements', async () => {
  const code = `import lodash from 'lodash'\nfunction X(){return null}\nexport default X`
  const result = await executeToolCall({
    name: 'create_react_component',
    arguments: JSON.stringify({ title: 'imp', code }),
  })
  assert.equal(result.ok, false)
  const payload = JSON.parse(result.content)
  assert.match(String(payload.error || ''), /沙箱不允许 import/)
})
