import assert from 'node:assert/strict'
import { resolveTarget } from './src/paths.js'
assert.equal(resolveTarget('/projects/a', 'src/main.js'), '/projects/a/src/main.js')
assert.throws(() => resolveTarget('/projects/a', '../b/main.js'))
