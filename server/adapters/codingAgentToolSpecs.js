import {
  HARD_DOWNLOAD_MAX_BYTES,
  MAX_DOCKER_TIMEOUT_MS,
  MAX_DOWNLOAD_TIMEOUT_MS,
  MAX_TEST_TIMEOUT_MS,
} from './codingAgentToolSupport.js'

export const CODING_AGENT_TOOL_SPECS = [
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Execute a shell command in the authorized workspace with timeout, cancellation, process-tree cleanup, stdout, stderr, and exit code. Use this for Python, Node, npm, PowerShell, builds, and arbitrary project commands. Pass cwd explicitly when working in an authorized directory outside the default workspace. Declare files that should change in expected_outputs. env_keys can forward named host credentials only after high-risk approval; credential values are never accepted in arguments or added to structured results.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          cmd: { type: 'string', description: 'Compatibility alias for command.' },
          cwd: { type: 'string', description: 'Workspace-relative or authorized absolute working directory.' },
          timeout_ms: { type: 'integer', minimum: 1000 },
          expected_outputs: { type: 'array', items: { type: 'string' }, description: 'Files expected to be created or modified; omit for read-only commands.' },
          env_keys: { type: 'array', items: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*$' }, uniqueItems: true, maxItems: 32, description: 'Host environment variable names to forward after high-risk approval. Pass names only; values are neither accepted here nor added to structured results. Gugo service/model credentials are always prohibited.' },
        },
        anyOf: [{ required: ['command'] }, { required: ['cmd'] }],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'patch_file',
      description: 'Safely patch files either with a Codex-style atomic patch string or by replacing an exact inclusive line range. Supports dry-run and an optional SHA-256 precondition to prevent stale writes.',
      parameters: {
        type: 'object',
        properties: {
          patch: { type: 'string', description: 'Codex patch text beginning with *** Begin Patch.' },
          path: { type: 'string' },
          start_line: { type: 'integer', minimum: 1 },
          end_line: { type: 'integer', minimum: 0 },
          replacement: { type: 'string' },
          expected_sha256: { type: 'string' },
          dry_run: { type: 'boolean', default: false },
        },
        anyOf: [
          { required: ['patch'] },
          { required: ['path', 'start_line', 'end_line', 'replacement'] },
        ],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_test',
      description: 'Run project tests in the authorized workspace and return pass/fail, exit code, stdout/stderr, and a parsed summary. Auto-detects npm, pytest, Cargo, Go, Maven, or Gradle; a custom command is allowed when needed. env_keys can forward named host credentials only after high-risk approval; credential values are never accepted in arguments or added to structured results.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Optional custom test command. Omit to auto-detect.' },
          framework: { type: 'string', enum: ['auto', 'npm', 'pytest', 'cargo', 'go', 'maven', 'gradle', 'custom'], default: 'auto' },
          cwd: { type: 'string', description: 'Workspace-relative or authorized absolute project directory.' },
          timeout_ms: { type: 'integer', minimum: 1000, maximum: MAX_TEST_TIMEOUT_MS },
          env_keys: { type: 'array', items: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*$' }, uniqueItems: true, maxItems: 32, description: 'Host environment variable names to forward after high-risk approval. Pass names only; values are neither accepted here nor added to structured results. Gugo service/model credentials are always prohibited.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'docker_exec',
      description: 'Execute a command in an existing Docker container through the system Docker CLI. Returns stdout, stderr, exit code, timeout, and cancellation state. Requires shell authorization and per-call approval. env configures explicit variables inside the container; env_keys separately forwards named host credentials to the Docker CLI only after high-risk approval, without accepting or adding their values to structured results.',
      parameters: {
        type: 'object',
        properties: {
          container: { type: 'string', description: 'Docker container name or ID.' },
          command: {
            oneOf: [
              { type: 'string', description: 'Command interpreted by /bin/sh -lc (cmd.exe /c for Windows containers).' },
              { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Exact executable and argument array.' },
            ],
          },
          workdir: { type: 'string', description: 'Optional working directory inside the container.' },
          env: { type: 'object', additionalProperties: { type: ['string', 'number', 'boolean'] } },
          container_os: { type: 'string', enum: ['linux', 'windows'], default: 'linux', description: 'Container OS used only for string commands; arrays remain exact argv.' },
          env_keys: { type: 'array', items: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*$' }, uniqueItems: true, maxItems: 32, description: 'Host environment variable names for the Docker CLI after high-risk approval. This is separate from container env; pass names only and values are never added to structured results. Gugo service/model credentials are always prohibited.' },
          cwd: { type: 'string', description: 'Authorized host directory used only to launch docker.' },
          timeout_ms: { type: 'integer', minimum: 1000, maximum: MAX_DOCKER_TIMEOUT_MS },
          expected_outputs: { type: 'array', items: { type: 'string' }, description: 'Optional authorized host files expected to change through mounted volumes.' },
        },
        required: ['container', 'command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'file_download',
      description: 'Download an HTTP/HTTPS binary file directly into an authorized local path with streaming, redirect/SSRF protection, an atomic write, size limit, and optional SHA-256 verification. Unlike fetch_url, this preserves binary data and supports large files.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          path: { type: 'string', description: 'Workspace-relative or authorized absolute destination file.' },
          overwrite: { type: 'boolean', default: false },
          sha256: { type: 'string', description: 'Optional expected lowercase/uppercase SHA-256 hex digest.' },
          headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'Optional non-sensitive request headers.' },
          timeout_ms: { type: 'integer', minimum: 1000, maximum: MAX_DOWNLOAD_TIMEOUT_MS },
          max_bytes: { type: 'integer', minimum: 1, maximum: HARD_DOWNLOAD_MAX_BYTES },
        },
        required: ['url', 'path'],
      },
    },
  },
]
