import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const componentPaths = [
  '../src/pages/ChatSplit/ModelPicker.jsx',
  '../src/pages/ChatSplit/modelPicker/ModelPickerPanel.jsx',
  '../src/pages/ChatSplit/modelPicker/ModelPickerOption.jsx',
]

function source(path) {
  return readFileSync(new URL(path, import.meta.url), 'utf8')
}

test('model picker components keep their natural boundaries below 300 lines', () => {
  for (const path of componentPaths) {
    const lineCount = source(path).split(/\r?\n/).length
    assert.ok(lineCount <= 300, `${path} has ${lineCount} lines`)
  }

  assert.match(source(componentPaths[0]), /import ModelPickerPanel from/)
  assert.match(source(componentPaths[0]), /import useModelPickerView from/)
  assert.match(source(componentPaths[1]), /import ModelPickerOption from/)
})

test('desktop model picker stays out of composer flow', () => {
  const pickerSource = source(componentPaths[0])
  const panelSource = source(componentPaths[1])

  assert.match(pickerSource, /className="relative /)
  assert.match(panelSource, /lg:absolute/)
  assert.match(panelSource, /lg:bottom-\[calc\(100%\+0\.5rem\)\]/)
  assert.match(panelSource, /lg:right-0/)
  assert.doesNotMatch(panelSource, /lg:static/)
})
