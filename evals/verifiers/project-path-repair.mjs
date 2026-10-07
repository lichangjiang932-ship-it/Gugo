import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const { resolveTarget } = await import(pathToFileURL(path.resolve('src/paths.js')).href)
assert.equal(resolveTarget('/projects/a', 'src/./main.js'), '/projects/a/src/main.js')
assert.equal(resolveTarget('/projects/b', 'src/main.js'), '/projects/b/src/main.js')
assert.equal(resolveTarget('/projects/a', '/projects/a/src/main.js'), '/projects/a/src/main.js')
assert.equal(resolveTarget('C:\\projects\\a', 'src\\main.js').toLowerCase(), 'c:\\projects\\a\\src\\main.js')
for (const target of ['../b/main.js', '/projects/b/main.js', '', null, 42]) {
  assert.throws(() => resolveTarget('/projects/a', target))
}
assert.throws(() => resolveTarget('C:\\projects\\a', 'C:relative.js'))
