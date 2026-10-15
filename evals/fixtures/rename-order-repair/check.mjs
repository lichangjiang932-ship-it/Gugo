import assert from 'node:assert/strict'
import { createRenamer } from './src/rename.js'
assert.equal(await createRenamer(async (_id,title)=>title)('s','Name'),'Name')
