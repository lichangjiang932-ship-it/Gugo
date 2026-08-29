#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, '../..')

export const WEB_RELEASE_ENTRIES = Object.freeze([
  '.env.example',
  'LICENSE',
  'THIRD_PARTY_NOTICES.md',
  'package.json',
  'package-lock.json',
  'bin',
  'dist',
  'docs/CLI.md',
  'server',
  'shared',
  'seed',
  'plugins',
  'resources/licenses',
  'scripts/healthcheck.js',
  'src/data.js',
  'src/data/skillCatalog.js',
  'src/lib/officeExport/documentExport.js',
  'src/lib/officeExport/officeCommon.js',
  'src/lib/officeExport/spreadsheetExport.js',
  'src/lib/pptCore.js',
  'src/lib/presentationExport/presentationParseHelpers.js',
  'src/lib/presentationExport/presentationParser.js',
  'src/lib/presentationPlanner.js',
])

const WEB_README = `# Gugo Web distribution

This archive contains the built browser client, Node.js server, runtime data,
and the locked production dependency manifest required to run Gugo.

## Requirements

- Node.js 20.19+, 22.13+, or 24+
- npm

## Start

1. Copy \`.env.example\` to \`.env\` and adjust the settings you need.
2. Install production dependencies: \`npm ci --omit=dev\`
3. Start Gugo: \`npm run serve\`
4. Open the URL printed by the server (default: http://127.0.0.1:5175).

## CLI

The archive also includes the Gugo CLI. Run it directly from the unpacked
release directory:

    node bin/yma-cli.js --version
    node bin/yma-cli.js --help

See \`docs/CLI.md\` for authentication, service commands, headless Agent runs,
output formats, and exit codes.

Runtime data is created outside the release files according to \`APP_DATA_DIR\`
and \`APP_DB_PATH\`. Do not put credentials into this archive.
`

function parseArgs(argv) {
  const args = { outputDir: path.join(DEFAULT_ROOT, '.artifacts', 'web') }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--output-dir' && argv[i + 1]) {
      args.outputDir = path.resolve(argv[++i])
      continue
    }
    throw new Error(`Unknown or incomplete argument: ${argv[i]}`)
  }
  return args
}

function assertRequiredEntry(rootDir, relativePath) {
  const source = path.join(rootDir, relativePath)
  if (!fs.existsSync(source)) {
    throw new Error(`Web release input is missing: ${relativePath}`)
  }
  if (relativePath === 'dist' && !fs.existsSync(path.join(source, 'index.html'))) {
    throw new Error('Web release input is missing: dist/index.html')
  }
  return source
}

function safeStagePath(outputDir, packageDirectoryName) {
  const resolvedOutput = path.resolve(outputDir)
  const stageDir = path.resolve(resolvedOutput, packageDirectoryName)
  if (stageDir === resolvedOutput || !stageDir.startsWith(`${resolvedOutput}${path.sep}`)) {
    throw new Error('Refusing to stage a web release outside its output directory')
  }
  return stageDir
}

export function stageWebRelease({ rootDir = DEFAULT_ROOT, outputDir } = {}) {
  const resolvedRoot = path.resolve(rootDir)
  const resolvedOutput = path.resolve(outputDir || path.join(resolvedRoot, '.artifacts', 'web'))
  const packageJson = JSON.parse(fs.readFileSync(path.join(resolvedRoot, 'package.json'), 'utf8'))
  if (packageJson.name !== 'gugo' || !packageJson.version) {
    throw new Error('package.json must describe a versioned gugo release')
  }

  const packageDirectoryName = `gugo-${packageJson.version}-web`
  const stageDir = safeStagePath(resolvedOutput, packageDirectoryName)
  fs.rmSync(stageDir, { recursive: true, force: true })
  fs.mkdirSync(stageDir, { recursive: true })

  for (const relativePath of WEB_RELEASE_ENTRIES) {
    const source = assertRequiredEntry(resolvedRoot, relativePath)
    const destination = path.join(stageDir, relativePath)
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.cpSync(source, destination, { recursive: true })
  }

  fs.writeFileSync(path.join(stageDir, 'README-WEB.md'), WEB_README, 'utf8')
  return { packageDirectoryName, stageDir, version: packageJson.version }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = stageWebRelease({ outputDir: parseArgs(process.argv.slice(2)).outputDir })
    process.stdout.write(`${result.stageDir}\n`)
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}
