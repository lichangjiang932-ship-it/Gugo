import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_OUTPUT = 'SHA256SUMS.txt'
const MAX_RELEASE_FILES = 128

function compareUtf8(left, right) {
  return Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'))
}

function assertManifestName(name) {
  if (!name || /[\0\r\n\\]/.test(name)) {
    throw new Error(`release filename cannot be represented safely in SHA256SUMS: ${JSON.stringify(name)}`)
  }
}

export async function sha256File(filePath) {
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

export async function createChecksumManifest({
  files,
  outputPath = DEFAULT_OUTPUT,
  cwd = process.cwd(),
} = {}) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('at least one release artifact is required')
  }
  if (files.length > MAX_RELEASE_FILES) {
    throw new Error(`release artifact count exceeds ${MAX_RELEASE_FILES}`)
  }
  if (typeof outputPath !== 'string' || !outputPath.trim()) {
    throw new Error('checksum output path is required')
  }

  const resolvedCwd = path.resolve(cwd)
  const resolvedOutput = path.resolve(resolvedCwd, outputPath)
  const outputIdentity = process.platform === 'win32' ? resolvedOutput.toLowerCase() : resolvedOutput
  const names = new Set()
  const inputs = []

  for (const candidate of files) {
    if (typeof candidate !== 'string' || !candidate.trim()) {
      throw new Error('release artifact path must be a non-empty string')
    }
    const resolvedPath = path.resolve(resolvedCwd, candidate)
    const inputIdentity = process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath
    if (inputIdentity === outputIdentity) {
      throw new Error('checksum manifest cannot hash itself')
    }

    const stat = await fs.promises.lstat(resolvedPath)
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`release artifact must be a regular file: ${candidate}`)
    }

    const name = path.basename(resolvedPath)
    assertManifestName(name)
    const nameIdentity = name.toLowerCase()
    if (names.has(nameIdentity)) {
      throw new Error(`duplicate release filename: ${name}`)
    }
    names.add(nameIdentity)
    inputs.push({ name, path: resolvedPath, size: stat.size })
  }

  inputs.sort((left, right) => compareUtf8(left.name, right.name))
  const entries = []
  for (const input of inputs) {
    entries.push({
      name: input.name,
      sha256: await sha256File(input.path),
      size: input.size,
    })
  }

  const manifest = `${entries.map(({ name, sha256 }) => `${sha256}  ${name}`).join('\n')}\n`
  await fs.promises.mkdir(path.dirname(resolvedOutput), { recursive: true })
  await fs.promises.writeFile(resolvedOutput, manifest, 'utf8')
  return { outputPath: resolvedOutput, entries }
}

function parseArgs(argv) {
  const files = []
  let outputPath = DEFAULT_OUTPUT
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--output') {
      outputPath = argv[index + 1]
      index += 1
      if (!outputPath) throw new Error('--output requires a path')
    } else if (value.startsWith('--')) {
      throw new Error(`unknown option: ${value}`)
    } else {
      files.push(value)
    }
  }
  return { files, outputPath }
}

async function main() {
  const result = await createChecksumManifest(parseArgs(process.argv.slice(2)))
  process.stdout.write(`wrote ${result.entries.length} checksums to ${result.outputPath}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error?.message || error}\n`)
    process.exitCode = 1
  })
}
