import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const read = (relativePath) => fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8')

test('desktop package keeps Electron isolated from renderer content', () => {
  const main = read('desktop/main.js')
  const appServer = read('server/appServer.js')
  const preload = read('desktop/preload.cjs')
  assert.match(main, /contextIsolation:\s*true/)
  assert.match(main, /nodeIntegration:\s*false/)
  assert.match(main, /sandbox:\s*true/)
  assert.match(main, /webviewTag:\s*false/)
  assert.match(main, /assertTrustedIpc/)
  assert.match(appServer, /process\.argv\[1\]\s*&&/)
  assert.doesNotMatch(preload, /exposeInMainWorld\([^)]*ipcRenderer/)
})

test('NSIS package includes server runtime dependencies and updater metadata', () => {
  const config = read('electron-builder.yml')
  const main = read('desktop/main.js')
  assert.match(config, /target:\s*nsis/)
  assert.match(config, /src\/data\.js/)
  assert.match(config, /src\/lib\/pptCore\.js/)
  assert.match(config, /src\/lib\/presentationPlanner\.js/)
  assert.match(config, /npmRebuild:\s*false/)
  assert.match(main, /GUGO_SQLITE_DRIVER\s*=\s*'node'/)
  assert.match(config, /provider:\s*github/)
  assert.match(config, /channel:\s*latest/)
})

test('version tags publish a Windows installer and updater metadata through GitHub Releases', () => {
  const workflow = read('.github/workflows/release.yml')
  assert.match(workflow, /runs-on:\s*windows-latest/)
  assert.match(workflow, /tags:\s*\n\s*- 'v\*\.\*\.\*'/)
  assert.match(workflow, /\.Extension -eq '\.exe'/)
  assert.match(workflow, /\.Name -eq 'latest\.yml'/)
  assert.match(workflow, /contents:\s*write/)
})
