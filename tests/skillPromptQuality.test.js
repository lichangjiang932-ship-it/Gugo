
import fs from 'node:fs'
import test from 'node:test'
import assert from 'node:assert/strict'

test('htmlppt prompt asks for varied visual systems rather than one fixed dark style', () => {
  const source = fs.readFileSync(new URL('../src/data.js', import.meta.url), 'utf8')
  assert.match(source, /视觉系统/)
  assert.match(source, /至少 4 类视觉元素/)
  assert.match(source, /连续页面不能长得一样/)
})
