const fs = require('node:fs')
const path = require('node:path')
const { listPackage } = require('@electron/asar')

const REQUIRED_DESKTOP_ASAR_FILES = Object.freeze([
  'server/start.js',
  'server/adapters/builtinSqliteTurnPersistenceBootstrap.js',
  'server/adapters/sqliteTurnPersistenceAdapter.js',
  'server/core/turnPersistenceBootstrap.js',
  'server/services/desktopParentGuard.js',
  'server/services/runtimeServerStartup.js',
  'shared/runtimeConfigRecoveryProtocol.js',
  'src/lib/officeExport/documentExport.js',
  'src/lib/officeExport/officeCommon.js',
  'src/lib/officeExport/spreadsheetExport.js',
  'src/lib/presentationExport/presentationParseHelpers.js',
  'src/lib/presentationExport/presentationParser.js',
])

function normalizeAsarEntry(entry) {
  return String(entry || '').replaceAll('\\', '/').replace(/^\/+/, '')
}

function verifyDesktopAsar(asarPath) {
  const resolvedPath = path.resolve(String(asarPath || ''))
  if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
    throw new Error(`Desktop package verification failed: app.asar was not found at ${resolvedPath}`)
  }

  const packagedFiles = new Set(listPackage(resolvedPath).map(normalizeAsarEntry))
  const missingFiles = REQUIRED_DESKTOP_ASAR_FILES.filter((file) => !packagedFiles.has(file))
  if (missingFiles.length) {
    throw new Error(
      `Desktop package verification failed: app.asar is missing runtime files: ${missingFiles.join(', ')}`,
    )
  }

  console.log(`[desktop-package] verified ${REQUIRED_DESKTOP_ASAR_FILES.length} runtime files in ${resolvedPath}`)
  return { asarPath: resolvedPath, checkedFiles: [...REQUIRED_DESKTOP_ASAR_FILES] }
}

function resolveAsarPath(input) {
  const candidate = path.resolve(String(input || ''))
  if (path.basename(candidate).toLowerCase() === 'app.asar') return candidate
  return path.join(candidate, 'resources', 'app.asar')
}

async function afterPack(context) {
  return verifyDesktopAsar(resolveAsarPath(context?.appOutDir))
}

if (require.main === module) {
  const target = process.argv[2] || path.join('release', 'win-unpacked', 'resources', 'app.asar')
  verifyDesktopAsar(resolveAsarPath(target))
}

module.exports = afterPack
module.exports.REQUIRED_DESKTOP_ASAR_FILES = REQUIRED_DESKTOP_ASAR_FILES
module.exports.normalizeAsarEntry = normalizeAsarEntry
module.exports.resolveAsarPath = resolveAsarPath
module.exports.verifyDesktopAsar = verifyDesktopAsar
