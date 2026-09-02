import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

const BACKEND_IMPLEMENTATION_LINE_LIMIT = 600
const BACKEND_LARGE_FILE_DEBT_ID = 'DEBT-SIZE-001'
const TRANSLATION_MODULE_LINE_LIMIT = 600
const DEBT_MARKER_CEILING = 168
const LEGACY_EMBER_CEILING = 106
const TINY_TEXT_CEILING = 132
const UI_HEX_PATTERN = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})\b/gi

const DOCUMENT_RENDERING_COLOR_FILES = new Set([
  'src/lib/artifactPreview/htmlDeckEnhancer.js',
  'src/lib/artifactPreview/htmlDocuments.js',
  'src/lib/artifactPreview/visualDocuments.js',
  'src/lib/htmlSlidesToPptx/htmlDeckConversion.js',
  'src/pages/ChatSplit/preview/reactSandboxDocument.js',
])

const UI_HEX_ALLOWLIST = Object.freeze([
  {
    id: 'third-party-brand-svg',
    accepts: ({ file, prefix }) => file === 'src/components/ConnectorBrandIcon.jsx'
      && /(?:fill|stroke|stopColor)=["']$/.test(prefix),
  },
  {
    id: 'third-party-brand-metadata',
    accepts: ({ file, prefix }) => (
      file === 'src/lib/accessCatalog.js'
      && /\bnative\(\s*['"][^'"]+['"]\s*,\s*['"][^'"]+['"]\s*,\s*['"]$/.test(prefix)
    ) || (
      file === 'src/lib/mcpPresets.js'
      && /\bbrandColor:\s*['"]$/.test(prefix)
    ),
  },
  {
    id: 'file-type-identity',
    accepts: ({ file, prefix }) => file === 'src/components/FileExplorer.jsx'
      && (/["']\.[^"']+["']:\s*["']$/.test(prefix) || /return colors\[ext\]\s*\|\|\s*["']$/.test(prefix)),
  },
  {
    id: 'artifact-document-rendering',
    accepts: ({ file }) => DOCUMENT_RENDERING_COLOR_FILES.has(file)
      || file.startsWith('src/lib/presentationExport/'),
  },
  {
    id: 'design-token-source',
    accepts: ({ file, prefix }) => file === 'src/lib/themeAccent.js'
      && /const DEFAULT_HEX\s*=\s*['"]$/.test(prefix),
  },
  {
    id: 'non-ui-skill-prompt-copy',
    accepts: ({ file }) => file === 'src/data/skillCatalog.js',
  },
])

function lineCount(file) {
  const source = readFileSync(file, 'utf8')
  return source.split(/\r?\n/).length - (/\r?\n$/.test(source) ? 1 : 0)
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return walk(full)
    return /\.(?:c|m)?jsx?$/.test(entry.name) ? [full] : []
  })
}

function walkBackendSources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return walkBackendSources(full)
    return /\.(?:[cm]?[jt]s|[jt]sx)$/.test(entry.name) ? [full] : []
  })
}

function repositoryPath(file) {
  return file.split(path.sep).join('/')
}

function walkUiSources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return walkUiSources(full)
    return /\.(?:css|jsx?|tsx?)$/.test(entry.name) ? [full] : []
  })
}

function countMatches(files, pattern) {
  return files.reduce((total, file) => total + (readFileSync(file, 'utf8').match(pattern) || []).length, 0)
}

function inspectUiHexGovernance(sources) {
  const violations = []
  const usedAllowlistIds = new Set()
  for (const { file, source } of sources) {
    source.split(/\r?\n/).forEach((sourceLine, lineIndex) => {
      for (const match of sourceLine.matchAll(UI_HEX_PATTERN)) {
        const occurrence = {
          file,
          sourceLine,
          prefix: sourceLine.slice(0, match.index),
          value: match[0].toLowerCase(),
          line: lineIndex + 1,
          column: match.index + 1,
        }
        const allowance = UI_HEX_ALLOWLIST.find((entry) => entry.accepts(occurrence))
        if (allowance) usedAllowlistIds.add(allowance.id)
        else violations.push(`${file}:${occurrence.line}:${occurrence.column} ${occurrence.value}`)
      }
    })
  }
  return { violations, usedAllowlistIds }
}

function classifyFrozenBackendDebt({ measurements, frozenCeilings, lineLimit }) {
  const files = [...measurements.keys()].sort()
  const oversizedFiles = files.filter((file) => measurements.get(file) > lineLimit)
  const frozenFiles = Object.keys(frozenCeilings)
  const unregistered = oversizedFiles
    .filter((file) => !Object.hasOwn(frozenCeilings, file))
    .map((file) => ({ file, actual: measurements.get(file) }))
  const measuredFrozenFiles = frozenFiles
    .filter((file) => measurements.has(file))
    .map((file) => ({ file, ceiling: frozenCeilings[file], actual: measurements.get(file) }))
  const grew = measuredFrozenFiles.filter(({ actual, ceiling }) => actual > ceiling)
  const needsRatchet = measuredFrozenFiles.filter(
    ({ actual, ceiling }) => actual > lineLimit && actual < ceiling,
  )
  const stale = frozenFiles
    .filter((file) => !measurements.has(file) || measurements.get(file) <= lineLimit)
    .map((file) => ({ file, actual: measurements.get(file) ?? null }))
  const invalidCeilings = frozenFiles.filter((file) => {
    const ceiling = frozenCeilings[file]
    return !Number.isSafeInteger(ceiling) || ceiling <= lineLimit
  })

  return { frozenFiles, unregistered, grew, needsRatchet, stale, invalidCeilings }
}

function findDuplicateValues(values, normalize = (value) => value) {
  const seen = new Set()
  const duplicates = new Set()
  for (const value of values) {
    const normalized = normalize(value)
    if (seen.has(normalized)) duplicates.add(normalized)
    seen.add(normalized)
  }
  return [...duplicates].sort()
}

function parseBackendSizeDebtInventory(debtSection) {
  const blocks = [...debtSection.matchAll(
    /<!-- debt-size-inventory:start -->\s*```json\s*([\s\S]*?)\s*```\s*<!-- debt-size-inventory:end -->/g,
  )]
  assert.equal(blocks.length, 1, `${BACKEND_LARGE_FILE_DEBT_ID} must contain exactly one size inventory`)
  return JSON.parse(blocks[0][1])
}

function inspectBackendSizeDebtInventory(inventory, lineLimit) {
  const groups = Array.isArray(inventory?.groups) ? inventory.groups : []
  const files = Array.isArray(inventory?.files) ? inventory.files : []
  const groupIds = groups.map((group) => group?.id)
  const registeredGroupIds = new Set(groupIds)
  const filePaths = files.map((file) => file?.path)
  const referencedGroupIds = new Set(files.map((file) => file?.group))
  const hasActionableText = (value) => typeof value === 'string' && value.trim().length >= 20

  return {
    duplicateGroupIds: findDuplicateValues(groupIds),
    duplicateFiles: findDuplicateValues(filePaths, (value) => String(value).toLowerCase()),
    invalidGroups: groups
      .filter((group) => (
        !/^[a-z][a-z0-9-]*$/.test(group?.id ?? '')
        || !hasActionableText(group?.reason)
        || !hasActionableText(group?.exitCriteria)
      ))
      .map((group) => group?.id ?? null),
    invalidFiles: files
      .filter((file) => (
        !/^server\/.+\.(?:[cm]?[jt]s|[jt]sx)$/.test(file?.path ?? '')
        || !Number.isSafeInteger(file?.ceiling)
        || file.ceiling <= lineLimit
        || typeof file?.group !== 'string'
      ))
      .map((file) => file?.path ?? null),
    unknownGroupFiles: files
      .filter((file) => !registeredGroupIds.has(file?.group))
      .map((file) => file?.path ?? null),
    unusedGroupIds: groupIds.filter((id) => !referencedGroupIds.has(id)),
    groupsAreSorted: groupIds.every((id, index) => index === 0 || groupIds[index - 1] < id),
    filesAreSorted: filePaths.every((file, index) => index === 0 || filePaths[index - 1] < file),
  }
}

test('backend implementation size policy rejects every ungoverned oversized file', () => {
  const debtSource = readFileSync('docs/DEBT.md', 'utf8')
  const registeredDebtIds = new Set([...debtSource.matchAll(/^## (DEBT-[A-Z]+-\d{3})\b/gm)].map((match) => match[1]))
  const debtSectionStart = debtSource.indexOf(`## ${BACKEND_LARGE_FILE_DEBT_ID}`)
  assert.notEqual(debtSectionStart, -1, `${BACKEND_LARGE_FILE_DEBT_ID} must remain in docs/DEBT.md`)
  const debtSectionEnd = debtSource.indexOf('\n## ', debtSectionStart + 1)
  const debtSection = debtSource.slice(debtSectionStart, debtSectionEnd >= 0 ? debtSectionEnd : undefined)
  const inventory = parseBackendSizeDebtInventory(debtSection)
  const inventoryFindings = inspectBackendSizeDebtInventory(
    inventory,
    BACKEND_IMPLEMENTATION_LINE_LIMIT,
  )
  const frozenCeilings = Object.fromEntries(
    (Array.isArray(inventory.files) ? inventory.files : []).map((entry) => [entry.path, entry.ceiling]),
  )
  const hasFrozenExceptions = Array.isArray(inventory.files) && inventory.files.length > 0
  const files = walkBackendSources('server').map(repositoryPath).sort()
  const measurements = new Map(files.map((file) => [file, lineCount(file)]))
  const findings = classifyFrozenBackendDebt({
    measurements,
    frozenCeilings,
    lineLimit: BACKEND_IMPLEMENTATION_LINE_LIMIT,
  })

  assert.equal(
    registeredDebtIds.has(BACKEND_LARGE_FILE_DEBT_ID),
    true,
    `${BACKEND_LARGE_FILE_DEBT_ID} must remain documented as the executable backend size policy`,
  )
  assert.match(
    debtSection,
    hasFrozenExceptions ? /\*\*Status:\*\* Open\b/ : /\*\*Status:\*\* Closed\b/,
    hasFrozenExceptions
      ? 'Frozen size exceptions require an open debt record'
      : 'A fully repaid size inventory requires a closed debt record',
  )
  assert.equal(inventory.schemaVersion, 1, 'Use the reviewed backend size inventory schema')
  assert.equal(inventory.debtId, BACKEND_LARGE_FILE_DEBT_ID, 'Inventory must belong to its enclosing debt record')
  assert.equal(
    inventory.lineLimit,
    BACKEND_IMPLEMENTATION_LINE_LIMIT,
    'Inventory and executable backend size policy must use the same threshold',
  )
  assert.ok(Array.isArray(inventory.groups), 'Inventory governance groups must be an array')
  assert.ok(Array.isArray(inventory.files), 'Inventory frozen file records must be an array')
  assert.deepEqual(inventoryFindings.duplicateGroupIds, [], 'Governance group identifiers must be unique')
  assert.deepEqual(inventoryFindings.duplicateFiles, [], 'Frozen file paths must be unique, including case aliases')
  assert.deepEqual(
    inventoryFindings.invalidGroups,
    [],
    'Every governance group requires an identifier, reason, and actionable exit criteria',
  )
  assert.deepEqual(
    inventoryFindings.invalidFiles,
    [],
    'Frozen file records require a canonical backend path, exact ceiling, and governance group',
  )
  assert.deepEqual(inventoryFindings.unknownGroupFiles, [], 'Every frozen file must resolve to documented governance')
  assert.deepEqual(inventoryFindings.unusedGroupIds, [], 'Remove governance groups that no longer own frozen files')
  assert.equal(inventoryFindings.groupsAreSorted, true, 'Keep governance groups sorted by identifier')
  assert.equal(inventoryFindings.filesAreSorted, true, 'Keep frozen file records sorted by repository path')
  assert.deepEqual(
    findings.frozenFiles,
    [...findings.frozenFiles].sort(),
    'Keep the frozen backend debt inventory deterministic',
  )
  assert.deepEqual(findings.invalidCeilings, [], 'Frozen ceilings must be exact line counts above the 600-line limit')
  assert.deepEqual(findings.unregistered, [], 'Split every new backend implementation file that exceeds 600 lines')
  assert.deepEqual(findings.grew, [], 'Split a cohesive module instead of increasing frozen backend size debt')
  assert.deepEqual(
    findings.needsRatchet,
    [],
    'Lower the frozen ceiling in the same change when an oversized file shrinks',
  )
  assert.deepEqual(findings.stale, [], 'Remove resolved or deleted files from the frozen backend debt inventory')
})

test('translation entry point and domain modules remain below the size limit', () => {
  const domainFiles = walk('src/i18n/domains').map(repositoryPath).sort()
  const files = ['src/i18n/translations.js', ...domainFiles]
  const oversized = files
    .map((file) => ({ file, lines: lineCount(file) }))
    .filter(({ lines }) => lines > TRANSLATION_MODULE_LINE_LIMIT)

  assert.ok(domainFiles.length > 1, 'Keep translation data split into cohesive domain modules')
  assert.deepEqual(
    oversized,
    [],
    `Split translation modules above ${TRANSLATION_MODULE_LINE_LIMIT} lines by domain`,
  )
})

test('backend size debt classifier reports every gate-evasion category', () => {
  const findings = classifyFrozenBackendDebt({
    measurements: new Map([
      ['server/newRuntime.ts', 601],
      ['server/grew.js', 702],
      ['server/shrank.js', 650],
      ['server/resolved.js', 600],
      ['server/invalid.js', 600],
    ]),
    frozenCeilings: {
      'server/grew.js': 701,
      'server/invalid.js': 600,
      'server/missing.js': 701,
      'server/resolved.js': 701,
      'server/shrank.js': 701,
    },
    lineLimit: 600,
  })

  assert.deepEqual(findings.unregistered, [{ file: 'server/newRuntime.ts', actual: 601 }])
  assert.deepEqual(findings.grew, [{ file: 'server/grew.js', ceiling: 701, actual: 702 }])
  assert.deepEqual(findings.needsRatchet, [{ file: 'server/shrank.js', ceiling: 701, actual: 650 }])
  assert.deepEqual(findings.stale, [
    { file: 'server/invalid.js', actual: 600 },
    { file: 'server/missing.js', actual: null },
    { file: 'server/resolved.js', actual: 600 },
  ])
  assert.deepEqual(findings.invalidCeilings, ['server/invalid.js'])
})

test('backend size inventory reports duplicate and unactionable governance records', () => {
  const findings = inspectBackendSizeDebtInventory({
    groups: [
      {
        id: 'duplicate-group',
        reason: 'This group has a concrete architectural reason.',
        exitCriteria: 'Extract the boundary and verify its focused contract tests.',
      },
      {
        id: 'duplicate-group',
        reason: 'This duplicate must be rejected rather than silently overwritten.',
        exitCriteria: 'Remove the duplicate registration before the gate can pass.',
      },
      {
        id: 'missing-reason',
        reason: '',
        exitCriteria: 'Split the registered implementation below the policy threshold.',
      },
      {
        id: 'unused-group',
        reason: 'An unreferenced governance group is stale documentation.',
        exitCriteria: 'Delete the group when no frozen implementation depends on it.',
      },
    ],
    files: [
      { path: 'server/duplicate.js', ceiling: 701, group: 'duplicate-group' },
      { path: 'server/DUPLICATE.js', ceiling: 702, group: 'duplicate-group' },
      { path: 'server/invalid.js', ceiling: 600, group: 'missing-reason' },
      { path: 'server/orphan.js', ceiling: 701, group: 'unknown-group' },
    ],
  }, 600)

  assert.deepEqual(findings.duplicateGroupIds, ['duplicate-group'])
  assert.deepEqual(findings.duplicateFiles, ['server/duplicate.js'])
  assert.deepEqual(findings.invalidGroups, ['missing-reason'])
  assert.deepEqual(findings.invalidFiles, ['server/invalid.js'])
  assert.deepEqual(findings.unknownGroupFiles, ['server/orphan.js'])
  assert.deepEqual(findings.unusedGroupIds, ['unused-group'])
  assert.equal(findings.groupsAreSorted, false)
  assert.equal(findings.filesAreSorted, false)
})

test('source debt markers cannot increase beyond the cleanup baseline', () => {
  const markers = [new RegExp(['TO', 'DO'].join(''), 'g'), new RegExp(['FIX', 'ME'].join(''), 'g')]
  const count = ['src', 'server', 'tests', 'scripts']
    .flatMap(walk)
    .reduce((total, file) => {
      const source = readFileSync(file, 'utf8')
      return total + markers.reduce((sum, marker) => sum + (source.match(marker) || []).length, 0)
    }, 0)
  assert.ok(count <= DEBT_MARKER_CEILING, `${count} debt markers exceeds ${DEBT_MARKER_CEILING}`)
})

test('legacy ember naming and tiny UI text can only shrink', () => {
  const files = walkUiSources('src')
  const legacyEmber = countMatches(files, /\bember\b/g)
  const tinyText = countMatches(files, /text-\[(?:9|10|11)px\]|font-size:\s*(?:9|10|11)px/g)
  const legacyUtility = /(?:text|bg|border(?:-[trblxy])?|ring|outline|fill|stroke|decoration|shadow|accent|divide|caret)-ember/
  const legacyUtilityFiles = files.filter((file) => legacyUtility.test(readFileSync(file, 'utf8')))

  assert.deepEqual(legacyUtilityFiles, [], 'Use semantic UI tokens instead of ember utility classes')
  assert.ok(legacyEmber <= LEGACY_EMBER_CEILING, `${legacyEmber} legacy ember tokens exceeds ${LEGACY_EMBER_CEILING}`)
  assert.ok(tinyText <= TINY_TEXT_CEILING, `${tinyText} tiny text declarations exceeds ${TINY_TEXT_CEILING}`)
})

test('UI hex governance only exempts reviewed brand and rendered-document semantics', () => {
  const findings = inspectUiHexGovernance([
    { file: 'src/components/NewBadge.jsx', source: 'const style = { color: "#abcdef" }' },
    { file: 'src/components/ConnectorBrandIcon.jsx', source: '<path fill="#4285F4" />' },
    { file: 'src/components/ConnectorBrandIcon.jsx', source: '<span style={{ color: "#123456" }} />' },
    { file: 'src/components/FileExplorer.jsx', source: "'.js': '#8B7B30'," },
    { file: 'src/components/FileExplorer.jsx', source: '<div style={{ background: "#fedcba" }} />' },
    { file: 'src/lib/accessCatalog.js', source: "native('github', 'GitHub', '#24292F', 'description')" },
    { file: 'src/lib/mcpPresets.js', source: "brandColor: '#1A73E8'," },
    { file: 'src/lib/artifactPreview/htmlDocuments.js', source: 'body { color: #26211c; }' },
    { file: 'src/lib/themeAccent.js', source: "const DEFAULT_HEX = '#16A34A'" },
  ])

  assert.deepEqual(
    findings.violations.map((violation) => violation.replace(/:\d+:\d+ /, ' ')),
    [
      'src/components/NewBadge.jsx #abcdef',
      'src/components/ConnectorBrandIcon.jsx #123456',
      'src/components/FileExplorer.jsx #fedcba',
    ],
  )
})

test('ordinary JS and JSX UI colors use design tokens instead of raw hex', () => {
  const files = walkUiSources('src').filter((file) => /\.(?:jsx?|tsx?)$/.test(file))
  const findings = inspectUiHexGovernance(files.map((file) => ({
    file: repositoryPath(file),
    source: readFileSync(file, 'utf8'),
  })))
  const unusedAllowlistIds = UI_HEX_ALLOWLIST
    .map((entry) => entry.id)
    .filter((id) => !findings.usedAllowlistIds.has(id))

  assert.deepEqual(
    findings.violations,
    [],
    'Replace ordinary UI hex with a theme token; extend the narrow allowlist only for reviewed semantic colors',
  )
  assert.deepEqual(unusedAllowlistIds, [], 'Remove stale UI hex allowlist categories')
})

test('engineering debt has a canonical, actionable register', () => {
  const source = readFileSync('docs/DEBT.md', 'utf8')
  const matches = [...source.matchAll(/^## (DEBT-[A-Z]+-\d{3})\b/gm)]
  const ids = matches.map((match) => match[1])

  assert.ok(ids.length >= 6, 'register must cover the known cross-cutting debt areas')
  assert.equal(new Set(ids).size, ids.length, 'debt identifiers must be unique')

  for (let index = 0; index < matches.length; index += 1) {
    const start = matches[index].index
    const end = matches[index + 1]?.index ?? source.indexOf('\n## Maintenance rules')
    const section = source.slice(start, end >= 0 ? end : undefined)
    for (const field of ['Status', 'Priority', 'Evidence / reproduction', 'Exit criteria', 'Verification']) {
      assert.match(section, new RegExp(`\\*\\*${field}:?\\*\\*`), `${ids[index]} is missing ${field}`)
    }
  }
})
