import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const PROTOCOL_PILOT_CONFIG = path.join(ROOT, 'tsconfig.protocol-pilot.json')
export const PROTOCOL_NEGATIVE_FIXTURES = Object.freeze({
  'activity-field.ts': 2322,
  'approval-decision.ts': 2322,
  'codec-input.ts': 2345,
  'event-kind.ts': 2322,
  'event-payload.ts': 2322,
  'frame-version.ts': 2322,
  'ready-field.ts': 2353,
  'server-direction.ts': 2345,
  'subscribe-cursor.ts': 2322,
  'typed-field.ts': 2322,
  'validation-narrowing.ts': 2339,
})

export function readProtocolPilotConfig(configPath = PROTOCOL_PILOT_CONFIG) {
  const source = ts.readConfigFile(configPath, ts.sys.readFile)
  if (source.error) throw new Error(ts.flattenDiagnosticMessageText(source.error.messageText, '\n'))
  const project = ts.parseJsonConfigFileContent(source.config, ts.sys, path.dirname(configPath))
  if (project.errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(project.errors, diagnosticHost))
  if (project.options.checkJs !== true || project.options.strict !== true || project.options.noEmit !== true) {
    throw new Error('The protocol pilot must check its JavaScript implementations strictly without emitting files.')
  }
  return project
}

const diagnosticHost = {
  getCanonicalFileName: (file) => file,
  getCurrentDirectory: () => ROOT,
  getNewLine: () => '\n',
}

export function verifyProtocolTypeFixtures() {
  const project = readProtocolPilotConfig()
  const fixtureDirectory = path.join(ROOT, 'types', 'fixtures', 'protocol-invalid')
  const names = fs.readdirSync(fixtureDirectory).filter((name) => name.endsWith('.ts')).sort()
  if (JSON.stringify(names) !== JSON.stringify(Object.keys(PROTOCOL_NEGATIVE_FIXTURES).sort())) {
    throw new Error('Negative fixture files must exactly match the registered type-error cases.')
  }
  const fixtures = names
    .map((name) => path.join(fixtureDirectory, name))
  if (!fixtures.length) throw new Error('The protocol pilot requires negative type fixtures.')
  const expected = new Set(fixtures.map((file) => path.resolve(file)))
  const program = ts.createProgram([...project.fileNames, ...fixtures], project.options)
  const diagnostics = ts.getPreEmitDiagnostics(program)
  const outsideFixtures = diagnostics.filter((diagnostic) => !diagnostic.file
    || !expected.has(path.resolve(diagnostic.file.fileName)))
  if (outsideFixtures.length) {
    throw new Error(ts.formatDiagnosticsWithColorAndContext(outsideFixtures, diagnosticHost))
  }
  const rejected = new Set(diagnostics.map((diagnostic) => path.resolve(diagnostic.file.fileName)))
  const accepted = fixtures.filter((file) => !rejected.has(path.resolve(file)))
  if (accepted.length) {
    throw new Error(`Invalid protocol calls unexpectedly typechecked: ${accepted.map((file) => path.basename(file)).join(', ')}`)
  }
  for (const diagnostic of diagnostics) {
    const name = path.basename(diagnostic.file.fileName)
    if (diagnostic.code !== PROTOCOL_NEGATIVE_FIXTURES[name]) {
      throw new Error(`Fixture ${name} failed for TS${diagnostic.code}, not its intended TS${PROTOCOL_NEGATIVE_FIXTURES[name]} type error.`)
    }
  }
  return Object.freeze({ fixtureCount: fixtures.length, diagnosticCount: diagnostics.length })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = verifyProtocolTypeFixtures()
    process.stdout.write(`[typecheck] protocol pilot rejected all ${result.fixtureCount} invalid-call fixtures\n`)
  } catch (error) {
    process.stderr.write(`${error?.message || error}\n`)
    process.exitCode = 1
  }
}
