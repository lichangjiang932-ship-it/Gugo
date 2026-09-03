export const CODEX_SKILL_COMPATIBILITY = Object.freeze([
  'ready',
  'needs-app',
  'needs-mcp',
  'needs-runtime',
])

export const RECOMMENDED_CODEX_PLUGINS = Object.freeze({
  'build-web-apps': 'https://github.com/openai/plugins',
  coderabbit: 'https://github.com/coderabbitai/codex-plugin',
  'game-studio': 'https://github.com/openai/plugins',
  'plugin-eval': 'https://github.com/openai/plugins',
  remotion: 'https://github.com/remotion-dev/remotion',
  superpowers: 'https://github.com/obra/superpowers',
})

export const MAX_MANIFEST_BYTES = 256 * 1024
export const MAX_SKILL_BYTES = 512 * 1024
export const MAX_SKILL_METADATA_BYTES = 64 * 1024
export const MAX_SCAN_DIRECTORIES = 20_000
export const MAX_MANIFESTS = 2_000
export const MAX_SKILLS = 5_000
export const MAX_MANIFEST_DEPTH = 5
export const MAX_SKILL_DEPTH = 8
export const MANIFEST_SCAN_SKIP = new Set([
  '.git', '.github', '.agents', 'node_modules', 'assets', 'skills', 'scripts',
  'agents', 'commands', 'references', 'tests', 'fixtures', 'examples',
])
export const SKILL_SCAN_SKIP = new Set([
  '.git', '.github', 'node_modules', 'assets', 'scripts', 'agents', 'commands',
  'references', 'reference', 'tests', 'fixtures', 'examples', 'evals', 'evaluations',
])
export const RUNTIME_MARKERS = Object.freeze([
  'scripts', 'commands', 'bin', 'preflight', 'workflows', 'hooks.json',
])
export const RUNTIME_MARKER_SET = new Set(RUNTIME_MARKERS)
export const SKILL_RESOURCE_REFERENCE_RE = /(?:^|[\s("'`<[])(?:\.\.?[\\/])?(references?|assets|templates)[\\/]/gim
