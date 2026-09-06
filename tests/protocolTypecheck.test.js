import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import ts from 'typescript'
import {
  PROTOCOL_NEGATIVE_FIXTURES,
  readProtocolPilotConfig,
  verifyProtocolTypeFixtures,
} from '../scripts/check-protocol-type-fixtures.mjs'

const root = path.resolve(import.meta.dirname, '..')
const runtimeFiles = [
  'shared/inlineSkillDefinitions.js',
  'shared/turnActivity.js',
  'shared/turnEvents.js',
  'shared/turnEventTransport.js',
  'shared/turnWebSocketProtocol.js',
  'server/core/turnWebSocketFrameCodec.js',
]
const relative = (file) => path.relative(root, file).split(path.sep).join('/')
const diagnosticsText = (diagnostics) => diagnostics.map((diagnostic) =>
  `${diagnostic.file?.fileName || 'config'} TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`,
).join('\n')

test('the strict pilot checks real JavaScript modules and a correctly typed production API caller', () => {
  const project = readProtocolPilotConfig()
  const program = ts.createProgram(project.fileNames, project.options)
  const diagnostics = ts.getPreEmitDiagnostics(program)
  assert.equal(project.options.checkJs, true)
  assert.equal(project.options.strict, true)
  assert.equal(project.options.noEmit, true)
  assert.deepEqual(diagnostics, [], diagnosticsText(diagnostics))
  const checked = program.getSourceFiles().filter((file) => !file.isDeclarationFile && file.fileName.endsWith('.js'))
    .map((file) => relative(file.fileName)).sort()
  assert.deepEqual(checked, [...runtimeFiles].sort())
  for (const file of runtimeFiles) {
    const source = fs.readFileSync(path.join(root, file), 'utf8')
    assert.match(source, /^\/\/ @ts-check/u, file)
    assert.doesNotMatch(source, /@ts-(?:nocheck|ignore|expect-error)\b/u, file)
    assert.doesNotMatch(source, /@(?:param|returns|type|typedef)\b[^\n]*\{[^}\n]*\bany\b/u, file)
  }
  const websocket = fs.readFileSync(path.join(root, 'server/services/turnWebSocket.js'), 'utf8')
  assert.match(websocket, /from '\.\.\/core\/turnWebSocketFrameCodec\.js'/u)
  assert.match(websocket, /decodeTurnWebSocketClientFrame\(String\(raw\)\)/u)
  assert.match(websocket, /encodeTurnWebSocketEvent\(value\.event\)/u)
})

test('wrong fields, versions, parameter types and un-narrowed results fail for their intended type errors', () => {
  const result = verifyProtocolTypeFixtures()
  assert.equal(result.fixtureCount, 11)
  assert.equal(result.diagnosticCount, 11)
  for (const name of Object.keys(PROTOCOL_NEGATIVE_FIXTURES)) {
    const source = fs.readFileSync(path.join(root, 'types/fixtures/protocol-invalid', name), 'utf8')
    assert.doesNotMatch(source, /@ts-(?:nocheck|ignore|expect-error)\b/u, name)
  }
})

test('an incorrect version inside the real checked codec implementation is detected without a type fixture', () => {
  const project = readProtocolPilotConfig()
  const target = path.join(root, 'server/core/turnWebSocketFrameCodec.js')
  const original = fs.readFileSync(target, 'utf8')
  const changed = original.replace(
    'return encodeTurnWebSocketServerFrame(createTurnEventTransportEnvelope(event))',
    "return encodeTurnWebSocketServerFrame({ v: 2, type: 'ready' })",
  )
  assert.notEqual(changed, original, 'the probe must mutate the actual implementation call')
  const host = ts.createCompilerHost(project.options)
  const readSourceFile = host.getSourceFile.bind(host)
  host.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) => (
    path.resolve(file) === target
      ? ts.createSourceFile(file, changed, languageVersion, true, ts.ScriptKind.JS)
      : readSourceFile(file, languageVersion, onError, shouldCreateNewSourceFile)
  )
  const program = ts.createProgram(project.fileNames, project.options, host)
  const diagnostics = ts.getPreEmitDiagnostics(program)
  assert.equal(diagnostics.some((diagnostic) => diagnostic.code === 2322
    && diagnostic.file && path.resolve(diagnostic.file.fileName) === target), true, diagnosticsText(diagnostics))
  assert.equal(fs.readFileSync(target, 'utf8'), original, 'the compiler-host probe must not edit the implementation')
})

test('typecheck keeps the contract index and requires the implementation pilot and negative cases', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.match(packageJson.scripts.typecheck, /tsc -p tsconfig\.contracts\.json/u)
  assert.match(packageJson.scripts.typecheck, /tsc -p tsconfig\.protocol-pilot\.json/u)
  assert.match(packageJson.scripts.typecheck, /node scripts\/check-protocol-type-fixtures\.mjs/u)
  const debt = fs.readFileSync(path.join(root, 'docs/DEBT.md'), 'utf8')
    .split('## DEBT-TYPE-001')[1]?.split('\n## ')[0] || ''
  assert.match(debt, /\*\*Status:\*\* Open/u)
  assert.match(debt, /tsconfig\.protocol-pilot\.json/u)
})
