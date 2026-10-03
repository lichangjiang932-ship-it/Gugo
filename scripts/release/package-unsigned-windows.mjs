import { spawn } from 'node:child_process'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(import.meta.url)

export function unsignedWindowsBuildEnvironment(source = process.env) {
  const result = Object.fromEntries(Object.entries(source).filter(([key]) => (
    !/^(?:CSC_|WIN_CSC_|WINDOWS_CSC_)/iu.test(key) && key.toUpperCase() !== 'WINDOWS_PUBLISHER_NAME'
  )))
  result.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
  return result
}

export function unsignedWindowsBuildArgs(outputDir) {
  return [
    require.resolve('electron-builder/out/cli/cli.js'),
    '--win', 'nsis', '--publish', 'never',
    '--config', path.join(ROOT, 'scripts/release/electron-builder-unsigned.cjs'),
    ...(outputDir ? [`--config.directories.output=${path.resolve(outputDir)}`] : []),
  ]
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length && (args.length !== 2 || args[0] !== '--output-dir' || !args[1])) {
    throw new Error('Usage: node scripts/release/package-unsigned-windows.mjs [--output-dir DIRECTORY]')
  }
  if (process.platform !== 'win32') throw new Error('Windows installer packaging requires Windows')
  const child = spawn(process.execPath, unsignedWindowsBuildArgs(args[1]), {
    cwd: ROOT, env: unsignedWindowsBuildEnvironment(), stdio: 'inherit', windowsHide: true,
  })
  child.once('error', error => { console.error(error.message); process.exitCode = 1 })
  child.once('exit', code => { process.exitCode = code ?? 1 })
}
