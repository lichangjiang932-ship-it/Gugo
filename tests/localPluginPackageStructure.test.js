import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const componentPaths = [
  '../src/components/settings/LocalPluginPackageSettings.jsx',
  '../src/components/settings/localPluginPackage/LocalPluginPackageFeedback.jsx',
  '../src/components/settings/localPluginPackage/LocalPluginPackageRows.jsx',
  '../src/components/settings/localPluginPackage/LocalPluginPackageSourcePanels.jsx',
]

function source(path) {
  return readFileSync(new URL(path, import.meta.url), 'utf8')
}

test('local plugin package components keep focused boundaries below 300 lines', () => {
  for (const path of componentPaths) {
    const lineCount = source(path).split(/\r?\n/).length
    assert.ok(lineCount <= 300, `${path} has ${lineCount} lines`)
  }

  const managerSource = source(componentPaths[0])
  assert.match(managerSource, /import \{ PackageActionError, PackageNotice \} from/)
  assert.match(managerSource, /import LocalPluginPackageRows from/)
  assert.match(managerSource, /import LocalPluginPackageSourcePanels from/)
  assert.match(managerSource, /import \{ REVISION_CONFLICT \} from/)
})
