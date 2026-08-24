import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const componentPaths = [
  '../src/components/settings/SettingsSecondaryPanels.jsx',
  '../src/components/settings/SettingsPluginsPanel.jsx',
  '../src/pages/permissions/PermissionSections.jsx',
  '../src/pages/permissions/WorkspaceTrustSection.jsx',
  '../src/pages/permissions/PermissionSectionPrimitives.jsx',
]

function source(path) {
  return readFileSync(new URL(path, import.meta.url), 'utf8')
}

test('secondary settings and permission sections stay below 300 lines', () => {
  for (const path of componentPaths) {
    const lineCount = source(path).split(/\r?\n/).length
    assert.ok(lineCount <= 300, `${path} has ${lineCount} lines`)
  }
})

test('compatibility entry points delegate focused panel implementations', () => {
  assert.match(
    source(componentPaths[0]),
    /export \{ SettingsPluginsPanel \} from '\.\/SettingsPluginsPanel\.jsx'/,
  )
  assert.match(
    source(componentPaths[2]),
    /export \{ WorkspaceTrustSection \} from '\.\/WorkspaceTrustSection\.jsx'/,
  )
  assert.match(
    source(componentPaths[2]),
    /import \{ PermSwitch, SectionTitle \} from '\.\/PermissionSectionPrimitives\.jsx'/,
  )
})
