import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
const root = fileURLToPath(new URL('../', import.meta.url))
function sources(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? sources(path.join(dir, entry.name)) : /\.[jt]sx?$/.test(entry.name) ? [path.join(dir, entry.name)] : [])
}
test('host animation code cannot bypass the user/system motion policy', () => {
  const allowed = new Set(['src/lib/hostMotion.js', 'src/lib/motionPreference.js', 'src/components/ui/HostMotionElement.jsx'])
  const violations = []
  for (const file of sources(path.join(root, 'src'))) {
    const name = path.relative(root, file).replaceAll('\\', '/')
    const ast = ts.createSourceFile(name, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX)
    for (const statement of ast.statements) {
      if ((ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement))
        && statement.moduleSpecifier?.text === 'framer-motion' && !allowed.has(name)) violations.push(name)
    }
  }
  assert.deepEqual(violations, [])
})
test('new host JSX cannot reintroduce non-scaling pixel font utilities', () => {
  const violations = sources(path.join(root, 'src')).filter(file => file.endsWith('.jsx'))
    .filter(file => /text-\[[\d.]+px\]/u.test(fs.readFileSync(file, 'utf8'))).map(file => path.relative(root, file))
  assert.deepEqual(violations, [])
})
