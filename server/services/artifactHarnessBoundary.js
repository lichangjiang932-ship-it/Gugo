/**
 * Tool names whose externally visible artifact lifecycle is owned by the
 * host. Plugins may eventually contribute generators behind a dedicated
 * candidate contract, but they must never replace these authorization,
 * validation, persistence, publication, or receipt boundaries directly.
 */
export const HOST_MANAGED_ARTIFACT_TOOL_NAMES = Object.freeze([
  'read_artifact_source',
  'generate_image',
  'render_pdf_pages',
  'create_pptx',
  'create_docx',
  'create_xlsx',
  'create_pdf',
  'create_html_app',
])

const HOST_MANAGED_ARTIFACT_TOOL_NAME_SET = new Set(HOST_MANAGED_ARTIFACT_TOOL_NAMES)

export function isHostManagedArtifactTool(name) {
  return HOST_MANAGED_ARTIFACT_TOOL_NAME_SET.has(String(name || '').trim())
}

export function assertHostManagedArtifactToolNotReplaced(name, builtinCapabilityId) {
  if (!builtinCapabilityId || !isHostManagedArtifactTool(name)) return
  const error = new Error(
    `plugin tool cannot replace the host-managed artifact harness: ${name}`,
  )
  error.code = 'PLUGIN_ARTIFACT_HARNESS_REPLACEMENT_FORBIDDEN'
  error.retryable = false
  throw error
}
