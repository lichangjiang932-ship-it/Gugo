export const WORKSPACE_TOOL_SPECS = {
  list_directory: {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List files and folders inside the workspace or a user-authorized local directory. Use absolute paths for additional local grants.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative path or an authorized absolute folder path.' },
          limit: { type: 'integer', description: 'Maximum entries to return, from 1 to 500.' },
        },
        required: ['path'],
      },
    },
  },
  web_search: {
    type: 'function',
    function: {
      name: 'web_search',
      description: '\u4f7f\u7528\u641c\u7d22\u5f15\u64ce\u67e5\u8be2\u4e92\u8054\u7f51\u6700\u65b0\u4fe1\u606f\u3002\u8fd4\u56de title\u3001url\u3001snippet \u5217\u8868\u3002\u5f53\u7528\u6237\u95ee\u5230\u65f6\u4e8b\u3001\u6700\u65b0\u53d1\u5e03\u3001\u9700\u8981\u5916\u90e8\u8d44\u6599\u65f6\u8c03\u7528\u3002',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '\u641c\u7d22\u5173\u952e\u8bcd,\u4f7f\u7528\u7528\u6237\u95ee\u9898\u4e2d\u7684\u6838\u5fc3\u5b9e\u4f53' },
          max_results: { type: 'integer', description: '\u8fd4\u56de\u7ed3\u679c\u4e0a\u9650,\u9ed8\u8ba4 6,\u6700\u5927 10', minimum: 1, maximum: 10 },
        },
        required: ['query'],
      },
    },
  },
  fetch_url: {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: '\u6293\u53d6\u6307\u5b9a URL \u7684\u9875\u9762\u6b63\u6587,\u8fd4\u56de markdown \u5f62\u5f0f\u7684\u4e3b\u8981\u5185\u5bb9\u3002\u7528\u4e8e\u8bfb\u53d6 web_search \u7ed9\u51fa\u7684\u94fe\u63a5\u7ec6\u8282\u3002',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '\u5b8c\u6574\u7684 http/https URL' },
        },
        required: ['url'],
      },
    },
  },
  read_file: {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a UTF-8 file inside the workspace or a user-authorized local path, optionally by line offset/limit. Use absolute paths for additional local grants.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative path or an authorized absolute file path.' },
          offset: { type: 'integer', description: 'Zero-based starting line. Optional.' },
          limit: { type: 'integer', description: 'Number of lines to return. 0 or omitted reads to the end.' },
        },
        required: ['path'],
      },
    },
  },
  write_file: {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or overwrite a UTF-8 file inside the workspace or a user-authorized read/write local path. Prefer edit_file for small changes.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string', description: 'Complete file content.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  edit_file: {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Precise string replacement inside a workspace or user-authorized read/write file. old_string must be unique unless replace_all is true.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_string: { type: 'string', description: 'Exact existing text, including whitespace.' },
          new_string: { type: 'string', description: 'Replacement text.' },
          replace_all: { type: 'boolean', description: 'Replace all occurrences instead of requiring uniqueness.' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  multi_edit: {
    type: 'function',
    function: {
      name: 'multi_edit',
      description: 'Atomic batch edit across multiple files. Pre-validates all SEARCH texts exist and are unique, then applies all edits. Rollbacks on any failure. Use for cross-file refactoring and bulk pattern replacements.',
      parameters: {
        type: 'object',
        properties: {
          edits: {
            type: 'array',
            description: 'List of SEARCH/REPLACE edits (max 20)',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string', description: 'File path relative to workspace' },
                oldText: { type: 'string', description: 'Exact text to replace \u2014 must be unique in file' },
                newText: { type: 'string', description: 'Replacement text' },
              },
              required: ['path', 'oldText', 'newText'],
            },
          },
        },
        required: ['edits'],
      },
    },
  },
  grep_code: {
    type: 'function',
    function: {
      name: 'grep_code',
      description: 'Search file contents with ripgrep inside the workspace or a user-authorized local directory. Supports regex, glob, file-type, case, and whole-word filtering and returns structured matches with locations and context.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Search pattern. Regular expressions are supported.' },
          path: { type: 'string', description: 'Optional workspace-relative path or authorized absolute directory. Defaults to the workspace root.' },
          glob: { type: 'string', description: 'Optional glob filter, for example "*.tsx" or "src/**/*.js".' },
          file_type: { type: 'string', description: 'Optional ripgrep file type, for example "ts", "py", or "go".' },
          case_sensitive: { type: 'boolean', description: 'Use case-sensitive matching. Defaults to smart-case matching.' },
          word: { type: 'boolean', description: 'Match whole words only.' },
          max_results: { type: 'integer', minimum: 1, maximum: 500, description: 'Maximum matches to return. Defaults to 50.' },
        },
        required: ['pattern'],
      },
    },
  },
  find_symbol: {
    type: 'function',
    function: {
      name: 'find_symbol',
      description: 'Locate function, class, or constant definitions in the workspace or a user-authorized local directory. Supports JavaScript, TypeScript, Python, Go, Rust, and Java and returns declarations rather than references.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Symbol name. Must be a valid identifier.' },
          kind: { type: 'string', enum: ['all', 'function', 'class', 'const'], description: 'Definition kind. Defaults to all.' },
          language: { type: 'string', description: 'Optional ripgrep file type used to restrict the search.' },
          path: { type: 'string', description: 'Optional workspace-relative path or authorized absolute directory. Defaults to the workspace root.' },
          max_results: { type: 'integer', minimum: 1, maximum: 100, description: 'Maximum definitions to return. Defaults to 20.' },
        },
        required: ['name'],
      },
    },
  },
  list_imports: {
    type: 'function',
    function: {
      name: 'list_imports',
      description: 'Read the beginning of one workspace or user-authorized file and extract import, require, and use statements as structured dependency records.',
      parameters: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'Workspace-relative or authorized absolute file path.' },
        },
        required: ['file'],
      },
    },
  },
  apply_patch: {
    type: 'function',
    function: {
      name: 'apply_patch',
      description: 'Codex-style atomic multi-file patch. Supports Add/Update/Delete File with unified-diff hunks. Cheaper than edit_file for large changes, safer than write_file (refuses to overwrite existing). All-or-nothing: any failure rolls back. Set dry_run=true to preview diff without writing.',
      parameters: {
        type: 'object',
        properties: {
          patch: { type: 'string', description: 'Codex-format patch text starting with "*** Begin Patch" and ending with "*** End Patch".' },
          dry_run: { type: 'boolean', description: 'Default false. true returns diff preview without writing.' },
        },
        required: ['patch'],
      },
    },
  },
  bash_exec: {
    type: 'function',
    function: {
      name: 'bash_exec',
      description: 'Run a shell command inside the configured workspace or a user-authorized local directory. In Windows commands, always wrap every absolute path in double quotes, even when it contains no spaces. Use for tests/builds/inspection; output is capped and secrets are masked server-side. When it creates or changes files, list every intended path in expected_outputs so the runtime can verify them.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Command string, e.g. npm test or git diff --stat.' },
          cwd: { type: 'string', description: 'Optional workspace-relative or authorized absolute working directory.' },
          timeout_ms: { type: 'integer', description: 'Timeout in milliseconds, 1000-300000.' },
          expected_outputs: { type: 'array', items: { type: 'string' }, description: 'Files this command is expected to create or modify; omit for read-only commands.' },
        },
        required: ['command'],
      },
    },
  },
  git_status: {
    type: 'function',
    function: {
      name: 'git_status',
      description: 'Read git branch and changed files for the configured workspace or a user-authorized repository. Read-only. Use before and after code edits.',
      parameters: {
        type: 'object',
        properties: { cwd: { type: 'string', description: 'Optional workspace-relative or authorized absolute repository path.' } },
      },
    },
  },
  git_diff: {
    type: 'function',
    function: {
      name: 'git_diff',
      description: 'Read unified git diff for the workspace or a user-authorized repository. Read-only.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Optional repository-relative changed file path.' },
          cwd: { type: 'string', description: 'Optional workspace-relative or authorized absolute repository path.' },
        },
      },
    },
  },
  run_project_check: {
    type: 'function',
    function: {
      name: 'run_project_check',
      description: 'Run exactly one allowed project check: lint, test, or build. Does not execute arbitrary shell commands.',
      parameters: {
        type: 'object',
        properties: {
          check: { type: 'string', enum: ['lint', 'test', 'build'], description: 'Allowed verification command.' },
          cwd: { type: 'string', description: 'Optional workspace-relative or authorized absolute repository path.' },
        },
        required: ['check'],
      },
    },
  },
}

