import {
  getBoundRuntimeTool,
  getRuntimeCapabilitySnapshot,
} from '../core/runtimeCapabilityState.js'
import { isReadOnlyShellCommand } from './bashGuard.js'
import { getDynamicTool } from './toolSchemaDynamicRegistry.js'
import { normalizeToolRiskMetadata } from './toolRiskMetadata.js'

const RISK_LEVEL_BY_CATEGORY = Object.freeze({
  read: 'low',
  write_local: 'medium',
  exec: 'high',
  external: 'high',
})

function builtinMetadata(category, isConcurrencySafe, overrides = {}) {
  const requiredApproval = overrides.requiredApproval ?? category !== 'read'
  const executionMode = category === 'read' && isConcurrencySafe ? 'parallel' : 'exclusive'
  return Object.freeze({
    riskLevel: RISK_LEVEL_BY_CATEGORY[category],
    requiredApproval,
    requiresApproval: requiredApproval,
    category,
    isConcurrencySafe,
    executionMode,
    isDestructive: category !== 'read',
    ...overrides,
  })
}

function buildBuiltinToolMetadata(codexModelsToolName) {
  return Object.freeze({
    list_directory: builtinMetadata('read', true),
    web_search: builtinMetadata('read', true),
    fetch_url: builtinMetadata('read', true),
    read_file: builtinMetadata('read', true),
    write_file: builtinMetadata('write_local', false),
    edit_file: builtinMetadata('write_local', false),
    bash_exec: builtinMetadata('exec', false),
    run_code: builtinMetadata('exec', false, {
      interruptBehavior: 'cancel',
      isDestructive: false,
      isIdempotent: false,
    }),
    [codexModelsToolName]: builtinMetadata('external', false, {
      interruptBehavior: 'cancel',
      isDestructive: false,
      isIdempotent: true,
    }),
    git_status: builtinMetadata('read', true),
    git_diff: builtinMetadata('read', true),
    run_project_check: builtinMetadata('exec', false),
    create_pptx: builtinMetadata('external', false),
    create_docx: builtinMetadata('external', false),
    create_xlsx: builtinMetadata('external', false),
    Agent: builtinMetadata('read', false),
    remember: builtinMetadata('external', false),
    manage_todos: builtinMetadata('external', false),
    set_deliverables: builtinMetadata('write_local', false, {
      requiredApproval: false,
      requiresApproval: false,
      isIdempotent: true,
      interruptBehavior: 'block',
      isDestructive: false,
    }),
    rewind_files: builtinMetadata('write_local', false),
    bash_background: builtinMetadata('exec', false),
    process_list: builtinMetadata('read', true),
    process_kill: builtinMetadata('exec', false),
    grep_code: builtinMetadata('read', true),
    find_symbol: builtinMetadata('read', true),
    list_imports: builtinMetadata('read', true),
    lsp: builtinMetadata('read', true),
    apply_patch: builtinMetadata('write_local', false),
    reflect: builtinMetadata('read', false),
    request_clarification: builtinMetadata('read', false),
    read_artifact_source: builtinMetadata('read', true),
    generate_image: builtinMetadata('external', false),
    create_pdf: builtinMetadata('external', false),
    create_html_app: builtinMetadata('external', false),
    image_info: builtinMetadata('read', true),
    image_transform: builtinMetadata('write_local', false),
    media_probe: builtinMetadata('read', true),
    media_transform: builtinMetadata('exec', false),
    pdf_info: builtinMetadata('read', true),
    pdf_text: builtinMetadata('read', true),
    render_pdf_pages: builtinMetadata('external', false),
    pdf_transform: builtinMetadata('write_local', false),
    archive_create: builtinMetadata('write_local', false),
    archive_list: builtinMetadata('read', true),
    archive_extract: builtinMetadata('write_local', false),
    batch_rename: builtinMetadata('write_local', false),
    file_hash_manifest: builtinMetadata('read', true),
    git_write: builtinMetadata('external', false),
    git_commit: builtinMetadata('external', false),
    git_push: builtinMetadata('external', false),
    git_rollback: builtinMetadata('external', false),
    run_command: builtinMetadata('exec', false),
    patch_file: builtinMetadata('write_local', false),
    run_test: builtinMetadata('exec', false),
    docker_exec: builtinMetadata('exec', false),
    file_download: builtinMetadata('write_local', false),
    request_directory: builtinMetadata('external', false),
    sleep_until: builtinMetadata('external', false),
  })
}

const READ_ONLY_MODE_TOOLS = new Set([
  'read_artifact_source',
  'list_directory',
  'web_search',
  'fetch_url',
  'read_file',
  'grep_code',
  'find_symbol',
  'list_imports',
  'lsp',
  'git_status',
  'git_diff',
  'image_info',
  'media_probe',
  'pdf_info',
  'pdf_text',
  'archive_list',
  'file_hash_manifest',
  'process_list',
  'reflect',
  'request_clarification',
  'Agent',
])

const BUILTIN_CONCURRENCY_SAFE_TOOLS = new Set([
  'read_artifact_source',
  'web_search',
  'fetch_url',
  'list_directory',
  'read_file',
  'grep_code',
  'find_symbol',
  'list_imports',
  'lsp',
  'git_status',
  'git_diff',
  'image_info',
  'media_probe',
  'pdf_info',
  'pdf_text',
  'archive_list',
  'file_hash_manifest',
  'process_list',
  'connected_app_list',
])

const BUILTIN_WRITE_LOCAL_TOOLS = new Set([
  'write_file',
  'edit_file',
  'patch_file',
  'apply_patch',
  'multi_edit',
  'image_transform',
  'pdf_transform',
  'archive_create',
  'archive_extract',
  'batch_rename',
  'file_download',
  'rewind_files',
  'set_deliverables',
])

const BUILTIN_EXEC_TOOLS = new Set([
  'bash_exec',
  'run_code',
  'run_command',
  'run_project_check',
  'media_transform',
  'run_test',
  'docker_exec',
  'bash_background',
  'process_kill',
])

/** Attach canonical metadata and return stable catalog accessors. */
export function createToolSchemaMetadataCatalog(
  builtinCatalog,
  { codexModelsToolName } = {},
) {
  const builtinToolMetadata = buildBuiltinToolMetadata(codexModelsToolName)
  const missingMetadata = Object.keys(builtinCatalog)
    .filter((name) => !builtinToolMetadata[name])
  const unknownMetadata = Object.keys(builtinToolMetadata)
    .filter((name) => !builtinCatalog[name])
  if (missingMetadata.length || unknownMetadata.length) {
    throw new Error(`Built-in tool metadata mismatch (missing: ${missingMetadata.join(', ') || 'none'}; unknown: ${unknownMetadata.join(', ') || 'none'})`)
  }
  for (const [name, spec] of Object.entries(builtinCatalog)) {
    Object.defineProperty(spec, 'metadata', {
      value: builtinToolMetadata[name],
      enumerable: false,
      configurable: false,
      writable: false,
    })
  }

  function getBuiltinSpec(name) {
    return builtinCatalog[name] || null
  }

  function getToolMetadata(name, { args = {}, userId = null } = {}) {
    const dynamic = getDynamicTool(name, { userId })
    const capabilitySnapshot = getRuntimeCapabilitySnapshot()
    const dynamicIsSelected = !capabilitySnapshot
      || dynamic?.origin !== 'plugin'
      || getBoundRuntimeTool(name)?.exec === dynamic.exec
    if (dynamicIsSelected && dynamic?.metadata) return dynamic.metadata
    const builtin = getBuiltinSpec(name)
    if (!builtin) {
      return normalizeToolRiskMetadata(null, { origin: 'unknown', source: 'fallback' })
    }

    if (builtin.metadata) {
      // bash_exec retains its exact argv classifier. Other command runners
      // remain exec/high until they have dedicated safety parsers.
      if (name === 'bash_exec' && isReadOnlyShellCommand(args?.command)) {
        return normalizeToolRiskMetadata({
          ...builtin.metadata,
          riskLevel: 'low',
          category: 'read',
          requiredApproval: false,
          requiresApproval: false,
          isReadOnly: true,
          isConcurrencySafe: true,
          isIdempotent: true,
          interruptBehavior: 'cancel',
          isDestructive: false,
        }, { origin: 'builtin', source: 'declared' })
      }
      return normalizeToolRiskMetadata(
        builtin.metadata,
        { origin: 'builtin', source: 'declared' },
      )
    }

    const isReadOnly = name === 'bash_exec'
      ? isReadOnlyShellCommand(args?.command)
      : READ_ONLY_MODE_TOOLS.has(name)
    const riskClass = isReadOnly
      ? 'read'
      : (BUILTIN_WRITE_LOCAL_TOOLS.has(name) ? 'write_local'
          : BUILTIN_EXEC_TOOLS.has(name) ? 'exec' : 'external')
    return normalizeToolRiskMetadata({
      riskClass,
      isReadOnly,
      isConcurrencySafe: (name === 'bash_exec' && isReadOnly)
        || BUILTIN_CONCURRENCY_SAFE_TOOLS.has(name),
      interruptBehavior: isReadOnly ? 'cancel' : 'block',
      isDestructive: !isReadOnly,
    }, { origin: 'builtin', source: 'fallback' })
  }

  return { getBuiltinSpec, getToolMetadata }
}
