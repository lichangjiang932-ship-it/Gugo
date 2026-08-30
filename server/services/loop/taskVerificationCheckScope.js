const TASK_CHECK_KINDS = new Set(['test', 'lint', 'build', 'check', 'typecheck'])

export function normalizeCheckKind(value) {
  const kind = String(value || '').trim().toLowerCase()
  return TASK_CHECK_KINDS.has(kind) ? kind : ''
}

function commandCheckKind(segment) {
  const value = String(segment || '').trim()
  const packageScript = value.match(
    /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(test|lint|build|check|typecheck)(?:\s+[^\r\n]*)?$/iu,
  )
  if (packageScript) return normalizeCheckKind(packageScript[1])
  if (/^(?:pytest|vitest|jest)(?:\s+[^\r\n]*)?$/iu.test(value)
    || /^cargo\s+test(?:\s+[^\r\n]*)?$/iu.test(value)
    || /^go\s+test(?:\s+[^\r\n]*)?$/iu.test(value)
    || /^dotnet\s+test(?:\s+[^\r\n]*)?$/iu.test(value)) return 'test'
  if (/^eslint(?:\s+[^\r\n]*)?$/iu.test(value)) return 'lint'
  if (/^tsc(?:\s+[^\r\n]*)?$/iu.test(value)
    || /^cargo\s+check(?:\s+[^\r\n]*)?$/iu.test(value)) return 'typecheck'
  return ''
}

function normalizeCommand(value) {
  return String(value || '').trim().replace(/\s+/gu, ' ')
}

function commandCheckDescriptors(command) {
  const value = String(command || '').trim()
  if (!value || /[|;\r\n]/u.test(value)) return []
  const segments = value.split(/\s*&&\s*/u).map((segment) => segment.trim()).filter(Boolean)
  if (segments.length === 0) return []
  const descriptors = new Map()
  for (const segment of segments) {
    const kind = commandCheckKind(segment)
    if (!kind) return []
    const packageScript = segment.match(
      /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(test|lint|build|check|typecheck)\s*$/iu,
    )
    const commandScope = packageScript ? `package-script:${kind}` : normalizeCommand(segment)
    descriptors.set(`${kind}\u0000${commandScope}`, { kind, commandScope })
  }
  return [...descriptors.values()]
}

export function taskVerificationKinds(call, result = null) {
  const name = String(call?.name || '').trim()
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

export function taskVerificationScopes(call, result) {
  const name = String(call?.name || '').trim()
  if (!name) return []
  const cwd = normalizeScopePath(result?.cwd || call?.args?.cwd)
  let descriptors = []
  if (name === 'run_project_check') {
    const kind = normalizeCheckKind(result?.check || call?.args?.check)
    if (kind) descriptors = [{ kind, commandScope: `package-script:${kind}` }]
  } else if (name === 'run_test') {
    const command = normalizeCommand(call?.args?.command || result?.command)
    descriptors = commandCheckDescriptors(command)
    if (descriptors.length === 0) {
      const fallbackScope = command
        || normalizeCommand(call?.args?.framework || result?.framework || 'auto')
      descriptors = [{ kind: 'test', commandScope: `run-test:${fallbackScope}` }]
    }
  } else {
    descriptors = commandCheckDescriptors(call?.args?.command)
  }
  return descriptors.map(({ kind, commandScope }) => ({
    kind,
    cwd,
    commandScope,
    scope: `${kind}\u0000${cwd}\u0000${commandScope}`,
    scopeLabel: `${kind}@${cwd}`,
  }))
}
