export const BATCH_FILE_TOOL_SPECS = [
  {
    type: 'function',
    function: {
      name: 'archive_create',
      description: 'Create a ZIP archive with streaming compression. Inputs may assign safe archive paths. ZIP64 and RAR creation are unsupported; outputs never overwrite by default.',
      parameters: {
        type: 'object',
        properties: {
          inputs: {
            type: 'array',
            items: {
              anyOf: [
                { type: 'string' },
                {
                  type: 'object',
                  properties: { path: { type: 'string' }, archivePath: { type: 'string' } },
                  required: ['path'],
                },
              ],
            },
          },
          output: { type: 'string' },
          format: { type: 'string', enum: ['zip'] },
          compressionLevel: { type: 'integer', minimum: 0, maximum: 9 },
          overwrite: { type: 'boolean' },
        },
        required: ['inputs', 'output'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'archive_list',
      description: 'List ZIP or RAR entries without extracting or writing files. Validates safe paths, entry count, total expanded size, compression ratio, encryption, unsafe entry types, and file/directory conflicts. ZIP64, encrypted archives, and multi-volume archives are unsupported.',
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string' },
          format: { type: 'string', enum: ['zip', 'rar'] },
        },
        required: ['input'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'archive_extract',
      description: 'Safely extract ZIP or RAR archives through a private staging directory with size checks, path traversal and link rejection, zip-bomb limits, atomic publication, whole-batch rollback, cancellation, and no overwrite by default. Encrypted and multi-volume archives are unsupported.',
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string' },
          outputDir: { type: 'string' },
          format: { type: 'string', enum: ['zip', 'rar'] },
          overwrite: { type: 'boolean' },
        },
        required: ['input', 'outputDir'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'batch_rename',
      description: 'Rename regular files or whole directories as one two-stage operation, including swaps and cycles. A selected directory moves recursively; do not separately select any descendant in the same batch. Rejects source/destination tree overlaps and cross-device moves, rolls back failures when possible, and never overwrites unrelated paths by default.',
      parameters: {
        type: 'object',
        properties: {
          operations: {
            type: 'array',
            items: {
              type: 'object',
              properties: { from: { type: 'string' }, to: { type: 'string' } },
              required: ['from', 'to'],
            },
          },
          overwrite: { type: 'boolean' },
        },
        required: ['operations'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'file_hash_manifest',
      description: 'Stream files through SHA-256 to produce a manifest and exact duplicate groups without loading large files into memory.',
      parameters: {
        type: 'object',
        properties: {
          inputs: { type: 'array', items: { type: 'string' } },
          recursive: { type: 'boolean', description: 'Recurse into input directories. Defaults true.' },
        },
        required: ['inputs'],
      },
    },
  },
]
