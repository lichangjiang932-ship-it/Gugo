const CODE_MODE_TOOLS = ['run_code', 'list_directory', 'read_file', 'write_file', 'edit_file', 'bash_exec', 'git_status', 'git_diff', 'run_project_check', 'manage_todos', 'Agent']

function unwrapToolSpec(entry) {
  const spec = entry?.tool || entry
  return spec?.type === 'function' && typeof spec?.function?.name === 'string'
    ? spec
    : null
}

function sortToolSpecsByName(specs = []) {
  return [...specs].sort((a, b) => {
    const aName = String(a?.function?.name || '')
    const bName = String(b?.function?.name || '')
    return aName < bName ? -1 : aName > bName ? 1 : 0
  })
}

export function resolveToolsForMode(toolsConfig = {}, mode = 'chat', catalog = []) {
  const enabled = Object.entries(toolsConfig || {})
    .filter(([, on]) => !!on)
    .map(([name]) => name)

  // Plan visibility is server-owned. The public catalog has already applied
  // approvalPolicy's canonical allowlist, so the client only intersects names
  // with that response. With no live catalog, fail closed instead of keeping a
  // second browser allowlist that can drift from the execution boundary.
  if (mode === 'plan') {
    const available = new Set(listToolNames(catalog))
    return enabled.filter((name) => available.has(name))
  }

  if (mode === 'code') {
    return [...new Set([...enabled, ...CODE_MODE_TOOLS])]
  }

  return enabled
}

export function buildToolSpecs(enabledNames, catalog = []) {
  // Schema content is supplied by GET /api/tools/specs. This module owns only
  // name selection and stable ordering; it intentionally defines no params.
  const availableByName = new Map()
  for (const entry of Array.isArray(catalog) ? catalog : []) {
    const spec = unwrapToolSpec(entry)
    const name = String(spec?.function?.name || '').trim()
    if (name) availableByName.set(name, spec)
  }

  // Accept Array / Set / any iterable and deduplicate by function name.
  const seen = new Set()
  const list = []
  for (const name of enabledNames || []) {
    if (typeof name !== 'string') continue
    if (seen.has(name)) continue
    seen.add(name)
    const spec = availableByName.get(name)
    if (spec) {
      list.push(spec)
    } else if (typeof console !== 'undefined') {
      console.warn(`[tools] Tool missing from the server catalog was ignored: ${name}`)
    }
  }
  return sortToolSpecsByName(list)
}

export function listToolNames(catalog = []) {
  return sortToolSpecsByName(
    (Array.isArray(catalog) ? catalog : [])
      .map(unwrapToolSpec)
      .filter(Boolean),
  ).map((spec) => spec.function.name)
}

/* \u2500\u2500 \u6267\u884c\u5668 \u2500\u2500 */

