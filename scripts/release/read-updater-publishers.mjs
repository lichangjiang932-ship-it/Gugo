import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

// Use the updater's own declared YAML dependency, not an undeclared runtime
// package or an ad-hoc parser which could confuse comments with publisher data.
const require = createRequire(import.meta.url)
const updaterRequire = createRequire(require.resolve('electron-updater/package.json'))
const yaml = updaterRequire('js-yaml')

export function readUpdaterPublishers(filePath) {
  const stat = fs.statSync(filePath)
  if (!stat.isFile() || stat.size > 64 * 1024) throw new Error('Invalid updater metadata file')
  const metadata = yaml.load(fs.readFileSync(filePath, 'utf8'), { schema: yaml.JSON_SCHEMA })
  if (!metadata || Array.isArray(metadata) || typeof metadata !== 'object') throw new Error('Invalid updater metadata')
  if (metadata.publisherName == null) return []
  const names = Array.isArray(metadata.publisherName) ? metadata.publisherName : [metadata.publisherName]
  if (names.length < 1 || names.length > 16 || names.some(name => typeof name !== 'string' || !name.trim() || name.length > 500)) {
    throw new Error('Invalid updater publisher names')
  }
  return names
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: read-updater-publishers.mjs app-update.yml')
    console.log(JSON.stringify(readUpdaterPublishers(process.argv[2])))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
