import { scanVerificationArguments } from './taskVerificationArgumentScanner.js'
import { isRuntimeInjectionEnvKey } from '../../utils/sensitiveEnv.js'
import { isCommandExecutionTool } from './heuristics/commandCapabilities.js'
import {
  CARGO_ARGUMENTS,
  DOTNET_ARGUMENTS,
  ESLINT_ARGUMENTS,
  GO_PROJECT_ARGUMENTS,
  GO_TEST_ARGUMENTS,
  GRADLE_ARGUMENTS,
  JEST_ARGUMENTS,
  MAKE_ARGUMENTS,
  MAKE_NON_VERDICT_OR_MUTATING_ARGUMENT,
  MAVEN_ARGUMENTS,
  MYPY_ARGUMENTS,
  NODE_TEST_ARGUMENTS,
  NON_VERDICT_OR_MUTATING_ARGUMENT,
  PACKAGE_SCRIPT_ARGUMENTS,
  PYTEST_ARGUMENTS,
  RUFF_ARGUMENTS,
  TSC_ARGUMENTS,
  VITEST_ARGUMENTS,
} from './taskVerificationCliProfiles.js'

const TASK_CHECK_KINDS = new Set(['test', 'lint', 'build', 'check', 'typecheck'])
const MAX_TARGET_PATHS = 16
const TRUSTED_VERIFICATION_ENV_VALUES = new Map([
  ['CI', new Set(['1', 'true'])],
  ['NODE_ENV', new Set(['test'])],
])

function isTaskVerificationTool(name) {
  return name === 'run_project_check'
    || name === 'run_test'
    || isCommandExecutionTool(name)
}

export function normalizeCheckKind(value) {
  const kind = String(value || '').trim().toLowerCase()
  return TASK_CHECK_KINDS.has(kind) ? kind : ''
}

function stripInlineEnvironmentPrefix(segment) {
  let value = String(segment || '').trim()
  let prefixed = false
  let assignmentCount = 0
  const runner = value.match(/^(?:env|cross-env)\s+/iu)
  if (runner) {
    prefixed = true
    value = value.slice(runner[0].length).trim()
  }
  while (value) {
    const assignment = value.match(
      /^([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s]+))\s+/u,
    )
    if (!assignment) break
    const assignmentValue = assignment[2] ?? assignment[3] ?? assignment[4] ?? ''
    if (!isTrustedVerificationEnvironmentAssignment(assignment[1], assignmentValue)) {
      return { value: '', prefixed: true, trusted: false }
    }
    prefixed = true
    assignmentCount += 1
    value = value.slice(assignment[0].length).trim()
  }
  return {
    value,
    prefixed,
    trusted: !runner || assignmentCount > 0,
  }
}

function stripToolRunnerPrefix(segment) {
  const value = String(segment || '').trim()
  const prefix = value.match(
    /^(?:npx\s+--no-install|pnpm\s+exec|yarn\s+exec)\s+/iu,
  )
  return prefix
    ? { value: value.slice(prefix[0].length).trim(), prefixed: true }
    : { value, prefixed: false }
}

function isTrustedVerificationEnvironmentAssignment(key, value) {
  const normalized = String(key || '').trim().toUpperCase()
  const normalizedValue = String(value || '').trim().toLowerCase()
  return TRUSTED_VERIFICATION_ENV_VALUES.get(normalized)?.has(normalizedValue) === true
    && !isRuntimeInjectionEnvKey(normalized)
}

function normalizeTargetPath(value) {
  const normalized = String(value || '').trim().replace(/\\/gu, '/').replace(/^\.\//u, '')
  if (!normalized
    || ['.', './...'].includes(normalized)
    || /[*?{}[\]$]/u.test(normalized)
    || normalized.split('/').includes('..')) return ''
  const withoutRecursiveSuffix = normalized.replace(/\/\.\.\.$/u, '')
  const segments = withoutRecursiveSuffix.split('/').filter(Boolean)
  if (segments.length === 0) return ''
  if (segments.length >= 2 && ['apps', 'modules', 'packages', 'services'].includes(segments[0])) {
    return segments.slice(0, 2).join('/')
  }
  const last = segments.at(-1)
  return /\.[a-z0-9_-]{1,12}$/iu.test(last) && segments.length > 1
    ? segments.slice(0, -1).join('/')
    : withoutRecursiveSuffix
}

function normalizedTargetPaths(values) {
  const paths = new Set()
  for (const value of values) {
    const normalized = normalizeTargetPath(value)
    if (!normalized) continue
    paths.add(normalized)
    // An empty targeted-path list is interpreted conservatively by the
    // attribution layer as "any mutation in this cwd may invalidate it".
    // Prefer that fail-closed meaning over retaining only the first paths and
    // silently treating later selected targets as unrelated.
    if (paths.size > MAX_TARGET_PATHS) return []
  }
  return [...paths]
}

function buildToolGoal(value, executablePattern, options = {}) {
  const match = value.match(executablePattern)
  if (!match) return null
  const { positional, selectorValues, targeted } = scanVerificationArguments(match[1], options)
  if (positional.length !== 1) return ''
  const goal = positional[0].toLowerCase()
  const coverage = targeted ? 'targeted' : 'cwd'
  const targetPaths = normalizedTargetPaths(selectorValues)
  if (goal === 'test') return { kind: 'test', coverage, targetPaths }
  if (['lint', 'checkstyle:check'].includes(goal)) return { kind: 'lint', coverage, targetPaths }
  if (goal === 'typecheck') return { kind: 'typecheck', coverage, targetPaths }
  if (['build', 'package', 'assemble', 'compile'].includes(goal)) {
    return { kind: 'build', coverage, targetPaths }
  }
  if (['check', 'verify'].includes(goal)) return { kind: 'check', coverage, targetPaths }
  return null
}

function commandArgumentAnalysis(argumentText, { cwdMarkers = [], ...options } = {}) {
  const { positional, selectorValues, targeted } = scanVerificationArguments(
    argumentText,
    options,
  )
  const nonCwdPositionals = positional.filter((token) => !cwdMarkers.includes(token))
  return {
    coverage: targeted || nonCwdPositionals.length > 0 ? 'targeted' : 'cwd',
    targetPaths: normalizedTargetPaths([...selectorValues, ...nonCwdPositionals]),
  }
}

function commandCheckDescriptor(segment) {
  const environment = stripInlineEnvironmentPrefix(segment)
  if (!environment.trusted) return null
  const runner = stripToolRunnerPrefix(environment.value)
  const value = runner.value
    .replace(/--watch(?:all)?=(?:false|0)\b/giu, '')
    .replace(/\s+/gu, ' ')
    .trim()
  if (/(?:^|\s)CARGO_TARGET_DIR=/iu.test(segment)
    || (/^go\s+test\b/iu.test(value)
      && /(?:^|\s)-(?:coverprofile|cpuprofile|memprofile|trace)(?:=|\s|$)/iu.test(value))
    || (/^(?:mypy|(?:python(?:3)?|py)(?:\.exe)?\s+-m\s+mypy)\b/iu.test(value)
      && /(?:^|\s)--cache-dir(?:=|\s|$)/iu.test(value))
    || (/^tsc\b/iu.test(value)
      && /(?:^|\s)(?:--incremental|--tsbuildinfofile)(?:=|\s|$)/iu.test(value))
    || (/^cargo\s+(?:test|check|clippy|build)\b/iu.test(value)
      && /(?:^|\s)--target-dir(?:=|\s|$)/iu.test(value))
    || (/^(?:\.?[\\/])?(?:gradlew|gradle)(?:\.cmd|\.bat)?\b/iu.test(value)
      && /(?:^|\s)(?:--gradle-user-home|-g|--project-cache-dir)(?:=|\s|$)/iu.test(value))
    || (/^(?:\.?[\\/])?(?:mvnw|mvn)(?:\.cmd|\.bat)?\b/iu.test(value)
      && /(?:^|\s)-D(?:surefire|failsafe)\.reportsDirectory=/iu.test(value))) return null
  if (NON_VERDICT_OR_MUTATING_ARGUMENT.test(value)
    || /(?:^|\s)(?:--watch(?:all)?)(?:[=\s]|$)/iu.test(value)
    || (/^vitest\b/iu.test(value) && /(?:^|\s)-w(?:[=\s]|$)/iu.test(value))
    || (/^go\s+(?:build|vet)\b/iu.test(value) && /(?:^|\s)-n(?:\s|$)/iu.test(value))
    || (/^(?:mvn|mvnw|dotnet\s+test)\b/iu.test(value)
      && /(?:^|\s)-l(?:[=\s]|$)/u.test(value))
    || /(?:^|\s)(?:clean|deploy|install|publish)(?:\s|$)/iu.test(value)) return null
  const packageScript = value.match(
    /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(test|lint|build|check|typecheck)((?:\s+[^\r\n]*)?)$/iu,
  )
  if (packageScript) {
    if (/(?:^|\s)-v(?:\s|$)/iu.test(packageScript[2])) return null
    return {
      kind: normalizeCheckKind(packageScript[1]),
      ...commandArgumentAnalysis(packageScript[2], PACKAGE_SCRIPT_ARGUMENTS),
    }
  }
  const testCommand = value.match(/^(?:pytest|vitest|jest)((?:\s+[^\r\n]*)?)$/iu)
    || value.match(/^(?:python(?:3)?|py)(?:\.exe)?\s+-m\s+(?:pytest|unittest)((?:\s+[^\r\n]*)?)$/iu)
    || value.match(/^node(?:\.exe)?\s+--test((?:\s+[^\r\n]*)?)$/iu)
    || value.match(/^cargo\s+test((?:\s+[^\r\n]*)?)$/iu)
    || value.match(/^go\s+test((?:\s+[^\r\n]*)?)$/iu)
    || value.match(/^dotnet\s+test((?:\s+[^\r\n]*)?)$/iu)
  if (testCommand) {
    let argumentProfile = {}
    if (/^(?:pytest|(?:python(?:3)?|py)(?:\.exe)?\s+-m\s+pytest)\b/iu.test(value)) {
      argumentProfile = PYTEST_ARGUMENTS
    } else if (/^jest\b/iu.test(value)) {
      argumentProfile = JEST_ARGUMENTS
    } else if (/^vitest\b/iu.test(value)) {
      argumentProfile = VITEST_ARGUMENTS
    } else if (/^node(?:\.exe)?\s+--test\b/iu.test(value)) {
      argumentProfile = NODE_TEST_ARGUMENTS
    } else if (/^cargo\s+test\b/iu.test(value)) {
      argumentProfile = CARGO_ARGUMENTS
    } else if (/^go\s+test\b/iu.test(value)) {
      argumentProfile = GO_TEST_ARGUMENTS
    } else if (/^dotnet\s+test\b/iu.test(value)) {
      argumentProfile = DOTNET_ARGUMENTS
    }
    return {
      kind: 'test',
      ...commandArgumentAnalysis(testCommand[1], {
        cwdMarkers: ['.', './...'],
        ...argumentProfile,
      }),
    }
  }
  const lintCommand = value.match(/^(?:eslint|flake8|pylint)((?:\s+[^\r\n]*)?)$/iu)
    || value.match(/^ruff\s+(?:check|format\s+--check)((?:\s+[^\r\n]*)?)$/iu)
    || value.match(/^(?:python(?:3)?|py)(?:\.exe)?\s+-m\s+(?:ruff\s+check|flake8|pylint)((?:\s+[^\r\n]*)?)$/iu)
    || value.match(/^cargo\s+clippy((?:\s+[^\r\n]*)?)$/iu)
    || value.match(/^go\s+vet((?:\s+[^\r\n]*)?)$/iu)
  if (lintCommand) {
    if (/^eslint\b/iu.test(value) && /(?:^|\s)-v(?:\s|$)/iu.test(lintCommand[1])) return null
    const argumentProfile = /^eslint\b/iu.test(value)
      ? ESLINT_ARGUMENTS
      : /^(?:(?:python(?:3)?|py)(?:\.exe)?\s+-m\s+)?ruff\b/iu.test(value)
        ? RUFF_ARGUMENTS
        : /^cargo\s+clippy\b/iu.test(value)
          ? CARGO_ARGUMENTS
          : /^go\s+vet\b/iu.test(value) ? GO_PROJECT_ARGUMENTS : {}
    return {
      kind: 'lint',
      ...commandArgumentAnalysis(lintCommand[1], {
        cwdMarkers: ['.', './...'],
        ...argumentProfile,
      }),
    }
  }
  const typecheckCommand = value.match(/^tsc((?:\s+[^\r\n]*)?)$/iu)
    || value.match(/^(?:mypy|pyright)((?:\s+[^\r\n]*)?)$/iu)
    || value.match(/^(?:python(?:3)?|py)(?:\.exe)?\s+-m\s+mypy((?:\s+[^\r\n]*)?)$/iu)
    || value.match(/^cargo\s+check((?:\s+[^\r\n]*)?)$/iu)
  if (typecheckCommand && (!/^tsc/iu.test(value) || /(?:^|\s)--noemit(?:\s|$)/iu.test(value))) {
    const argumentProfile = /^tsc\b/iu.test(value)
      ? TSC_ARGUMENTS
      : /^(?:(?:python(?:3)?|py)(?:\.exe)?\s+-m\s+)?mypy\b/iu.test(value)
        ? MYPY_ARGUMENTS
        : /^cargo\s+check\b/iu.test(value) ? CARGO_ARGUMENTS : {}
    return {
      kind: 'typecheck',
      ...commandArgumentAnalysis(typecheckCommand[1], {
        cwdMarkers: ['.'],
        ...argumentProfile,
      }),
    }
  }
  const buildCommand = value.match(/^(?:cargo|go|dotnet)\s+build((?:\s+[^\r\n]*)?)$/iu)
  if (buildCommand) {
    const argumentProfile = /^cargo\s+build\b/iu.test(value)
      ? CARGO_ARGUMENTS
      : /^go\s+build\b/iu.test(value)
        ? GO_PROJECT_ARGUMENTS
        : DOTNET_ARGUMENTS
    return {
      kind: 'build',
      ...commandArgumentAnalysis(buildCommand[1], {
        cwdMarkers: ['.', './...'],
        ...argumentProfile,
      }),
    }
  }
  const delegated = buildToolGoal(
    value,
    /^(?:\.?[\\/])?(?:mvnw|mvn)(?:\.cmd|\.bat)?((?:\s+[^\r\n]+)*)$/iu,
    MAVEN_ARGUMENTS,
  ) || buildToolGoal(
    value,
    /^(?:\.?[\\/])?(?:gradlew|gradle)(?:\.cmd|\.bat)?((?:\s+[^\r\n]+)*)$/iu,
    GRADLE_ARGUMENTS,
  ) || (MAKE_NON_VERDICT_OR_MUTATING_ARGUMENT.test(value) ? null : buildToolGoal(
    value,
    /^(?:\.?[\\/])?(?:g?make)(?:\.exe)?((?:\s+[^\r\n]+)*)$/iu,
    MAKE_ARGUMENTS,
  ))
  return delegated
}

function normalizeCommand(value) {
  return String(value || '').trim().replace(/\s+/gu, ' ')
}

function verifierFamilyForCommand(segment, kind) {
  const environment = stripInlineEnvironmentPrefix(segment)
  if (!environment.trusted) return ''
  const value = stripToolRunnerPrefix(environment.value).value.toLowerCase()
  if (/^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|lint|build|check|typecheck)\b/u.test(value)) {
    return `package-script:${kind}`
  }
  if (/^(?:pytest|python(?:3)?\s+-m\s+pytest|py(?:\.exe)?\s+-m\s+pytest)\b/u.test(value)) return 'pytest'
  if (/^(?:python(?:3)?|py)(?:\.exe)?\s+-m\s+unittest\b/u.test(value)) return 'python-unittest'
  if (/^jest\b/u.test(value)) return 'jest'
  if (/^vitest\b/u.test(value)) return 'vitest'
  if (/^node(?:\.exe)?\s+--test\b/u.test(value)) return 'node-test'
  if (/^cargo\s+test\b/u.test(value)) return 'cargo-test'
  if (/^go\s+test\b/u.test(value)) return 'go-test'
  if (/^dotnet\s+test\b/u.test(value)) return 'dotnet-test'
  if (/^eslint\b/u.test(value)) return 'eslint'
  if (/^(?:python(?:3)?|py)(?:\.exe)?\s+-m\s+ruff\s+check\b|^ruff\s+check\b/u.test(value)) return 'ruff-check'
  if (/^ruff\s+format\s+--check\b/u.test(value)) return 'ruff-format-check'
  if (/^(?:python(?:3)?|py)(?:\.exe)?\s+-m\s+flake8\b|^flake8\b/u.test(value)) return 'flake8'
  if (/^(?:python(?:3)?|py)(?:\.exe)?\s+-m\s+pylint\b|^pylint\b/u.test(value)) return 'pylint'
  if (/^cargo\s+clippy\b/u.test(value)) return 'cargo-clippy'
  if (/^go\s+vet\b/u.test(value)) return 'go-vet'
  if (/^tsc\b/u.test(value)) return 'tsc'
  if (/^(?:python(?:3)?|py)(?:\.exe)?\s+-m\s+mypy\b|^mypy\b/u.test(value)) return 'mypy'
  if (/^pyright\b/u.test(value)) return 'pyright'
  if (/^cargo\s+check\b/u.test(value)) return 'cargo-check'
  if (/^cargo\s+build\b/u.test(value)) return 'cargo-build'
  if (/^go\s+build\b/u.test(value)) return 'go-build'
  if (/^dotnet\s+build\b/u.test(value)) return 'dotnet-build'
  if (/^(?:\.?[\\/])?(?:mvnw|mvn)(?:\.cmd|\.bat)?\b/u.test(value)) return `maven:${kind}`
  if (/^(?:\.?[\\/])?(?:gradlew|gradle)(?:\.cmd|\.bat)?\b/u.test(value)) return `gradle:${kind}`
  if (/^(?:\.?[\\/])?(?:g?make)(?:\.exe)?\b/u.test(value)) return `make:${kind}`
  return `exact:${normalizeCommand(value)}`
}

function commandPrelude(segment) {
  const value = String(segment || '').trim()
  const cwdMatch = value.match(/^(?:cd|pushd)(?:\s+\/d)?\s+(?!$)([^&|;<>`\r\n]+)$/iu)
  if (cwdMatch) {
    const rawPath = String(cwdMatch[1] || '').trim().replace(/^(["'])(.*)\1$/u, '$2')
    const normalized = rawPath.replace(/\\/gu, '/').replace(/^\.\//u, '').replace(/\/+$/u, '')
    if (normalized
      && !/^(?:~|\$|%)/u.test(normalized)
      && !normalized.split('/').includes('..')) {
      return { kind: 'cwd', cwdSuffix: normalized }
    }
    return null
  }
  // Accept one complete assignment only. A trailing assignment such as
  // `CI=1 NODE_OPTIONS=...` must not be partially parsed as trusted.
  const environmentMatch = value.match(
    /^(?:export|set)\s+(?:(["'])([A-Za-z_][A-Za-z0-9_]*)=([^\r\n]*?)\1|([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s]+)))$/iu,
  )
  const environmentKey = environmentMatch?.[2] || environmentMatch?.[4] || ''
  const environmentValue = environmentMatch
    ? (environmentMatch[3] ?? environmentMatch[5] ?? environmentMatch[6] ?? environmentMatch[7] ?? '')
    : ''
  if (environmentMatch
    && isTrustedVerificationEnvironmentAssignment(environmentKey, environmentValue)) {
    return { kind: 'environment', cwdSuffix: '' }
  }
  return null
}

export function commandCheckDescriptors(command) {
  const value = String(command || '').trim()
  if (!value || /[|;<>`\r\n]/u.test(value) || /\|\||\$\(/u.test(value)) return []
  const segments = value.split(/\s*&&\s*/u).map((segment) => segment.trim()).filter(Boolean)
  if (segments.length === 0
    || segments.length > 2
    || segments.some((segment) => /&/u.test(segment))) return []
  const descriptors = new Map()
  const preludes = []
  let cwdSuffix = ''
  let environmentPrelude = false
  for (const [index, segment] of segments.entries()) {
    const prelude = commandPrelude(segment)
    if (prelude && descriptors.size === 0 && index === 0 && segments.length === 2) {
      preludes.push(segment)
      cwdSuffix = prelude.cwdSuffix
      environmentPrelude = prelude.kind === 'environment'
      continue
    }
    if (index !== segments.length - 1 || descriptors.size > 0) return []
    const descriptor = commandCheckDescriptor(segment)
    if (!descriptor) return []
    const { kind, coverage, targetPaths = [] } = descriptor
    const verifierFamily = verifierFamilyForCommand(segment, kind)
    if (!verifierFamily) return []
    const packageScript = segment.match(
      /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(test|lint|build|check|typecheck)\s*$/iu,
    )
    const commandScope = packageScript && !environmentPrelude
      ? `package-script:${kind}`
      : normalizeCommand([...preludes, segment].join(' && '))
    descriptors.set(`${kind}\u0000${commandScope}`, {
      kind,
      commandScope,
      verifierFamily,
      cwdSuffix,
      coverage,
      targetPaths,
    })
  }
  return [...descriptors.values()]
}

export function isTaskVerificationCommand(command) {
  return commandCheckDescriptors(command).length > 0
}

export function taskVerificationKinds(call, result = null) {
  const name = String(call?.name || '').trim()
  if (!isTaskVerificationTool(name)) return []
  if (name === 'run_project_check') {
    const kind = normalizeCheckKind(result?.check || call?.args?.check)
    return kind ? [kind] : []
  }
  if (name === 'run_test') {
    const command = String(call?.args?.command || result?.command || '').trim()
    const kinds = [...new Set(commandCheckDescriptors(command).map(({ kind }) => kind))]
    return kinds.length > 0 ? kinds : ['test']
  }
  return [...new Set(commandCheckDescriptors(call?.args?.command).map(({ kind }) => kind))]
}

export function normalizeScopePath(value) {
  const scopePath = String(value || '.').trim().replace(/\\/gu, '/').replace(/\/+$/u, '') || '.'
  return process.platform === 'win32' ? scopePath.toLowerCase() : scopePath
}

function scopePathWithSuffix(base, suffix) {
  const normalizedBase = normalizeScopePath(base)
  const normalizedSuffix = String(suffix || '').replace(/\\/gu, '/').replace(/^\.\//u, '')
  if (!normalizedSuffix) return normalizedBase
  if (/^(?:[A-Za-z]:\/|\/)/u.test(normalizedSuffix)) return normalizeScopePath(normalizedSuffix)
  return normalizeScopePath(normalizedBase === '.'
    ? normalizedSuffix
    : `${normalizedBase}/${normalizedSuffix}`)
}

export function taskVerificationScopes(call, result) {
  const name = String(call?.name || '').trim()
  if (!isTaskVerificationTool(name)) return []
  const cwd = normalizeScopePath(result?.cwd || call?.args?.cwd)
  let descriptors = []
  if (name === 'run_project_check') {
    const kind = normalizeCheckKind(result?.check || call?.args?.check)
    if (kind) descriptors = [{
      kind,
      commandScope: `package-script:${kind}`,
      verifierFamily: `package-script:${kind}`,
      coverage: 'cwd',
    }]
  } else if (name === 'run_test') {
    const command = normalizeCommand(call?.args?.command || result?.command)
    descriptors = commandCheckDescriptors(command)
    if (descriptors.length === 0) {
      const fallbackScope = command
        || normalizeCommand(call?.args?.framework || result?.framework || 'auto')
      descriptors = [{
        kind: 'test',
        commandScope: `run-test:${fallbackScope}`,
        verifierFamily: `run-test:${fallbackScope}`,
        coverage: 'targeted',
      }]
    }
  } else {
    descriptors = commandCheckDescriptors(call?.args?.command)
  }
  const persistentResultCwd = result?.session === 'reuse' && String(result?.cwd || '').trim()
  return descriptors.map(({
    kind,
    commandScope,
    verifierFamily = commandScope,
    cwdSuffix,
    coverage,
    targetPaths = [],
  }) => {
    const scopedCwd = scopePathWithSuffix(cwd, persistentResultCwd ? '' : cwdSuffix)
    return {
      kind,
      cwd: scopedCwd,
      commandScope,
      verifierFamily,
      coverage,
      targetPaths,
      scope: `${kind}\u0000${scopedCwd}\u0000${commandScope}`,
      scopeLabel: `${kind}@${scopedCwd}`,
    }
  })
}
