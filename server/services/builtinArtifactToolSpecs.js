/**
 * Canonical model-facing schemas for managed artifacts.
 * Both the public tool catalog and the server turn runtime consume this map.
 */
const REPLACE_ARTIFACT_ID_PROPERTY = Object.freeze({
  type: 'string',
  minLength: 1,
  description: 'Set only when the runtime explicitly instructs an in-place revision of an adjacent delivered artifact. Use that exact artifact ID; omit this field when creating a new file or version.',
})

const OUTPUT_DIRECTORY_PROPERTY = Object.freeze({
  type: 'string',
  minLength: 2,
  description: 'Optional explicitly requested absolute output directory. Use this when the user names a destination directory or drive but not an exact filename. Omit it to use the configured default output directory.',
})

const OFFICE_IMAGES_PROPERTY = Object.freeze({
  type: 'array',
  maxItems: 50,
  description: 'Existing authorized raster images to embed as real media in the generated Office file. This never generates a new image. target_index is 1-based (slide for PPTX, paragraph position for DOCX, sheet for XLSX). x/y/width/height are optional inches; anchor is an XLSX cell such as D2.',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      path: { type: 'string', minLength: 1, description: 'Existing workspace/local file path or attachment:// URI.' },
      alt: { type: 'string', maxLength: 500 },
      target_index: { type: 'integer', minimum: 1 },
      anchor: { type: 'string', pattern: '^[A-Za-z]{1,3}[1-9][0-9]{0,6}$' },
      x: { type: 'number', minimum: 0 },
      y: { type: 'number', minimum: 0 },
      width: { type: 'number', exclusiveMinimum: 0 },
      height: { type: 'number', exclusiveMinimum: 0 },
    },
    required: ['path'],
  },
})

export const BUILTIN_ARTIFACT_TOOL_SPECS = Object.freeze({
  read_artifact_source: {
    type: 'function',
    function: {
      name: 'read_artifact_source',
      description: 'Read the current editable source for a managed artifact owned by this chat session. Artifact creation history contains only a lightweight reference; call this before revising an existing HTML/PDF/Word/PowerPoint/Excel artifact. Read every page until complete=true, then apply the user change and call the matching create_* tool.',
      parameters: {
        type: 'object',
        properties: {
          artifact_id: {
            type: 'string',
            minLength: 1,
            description: 'Exact artifactId from the adjacent artifact reference or tool result.',
          },
          offset: {
            type: 'integer',
            minimum: 0,
            default: 0,
            description: 'Character offset. Start at 0, then use nextOffset until complete=true.',
          },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: 20000,
            default: 16000,
            description: 'Maximum source characters returned in this page.',
          },
        },
        required: ['artifact_id'],
      },
    },
  },
  generate_image: {
    type: 'function',
    function: {
      name: 'generate_image',
      description: 'Generate a raster image with the user-configured OpenAI-compatible image model and save it as an artifact.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          title: { type: 'string' },
          model: { type: 'string' },
          providerKey: { type: 'string' },
          size: { type: 'string', enum: ['1024x1024', '1024x1536', '1536x1024'] },
          output_directory: OUTPUT_DIRECTORY_PROPERTY,
          replace_artifact_id: REPLACE_ARTIFACT_ID_PROPERTY,
        },
        required: ['prompt'],
      },
    },
  },
  create_pptx: {
    type: 'function',
    function: {
      name: 'create_pptx',
      description: 'Create a polished PowerPoint (.pptx) artifact from structured slides. Use concise conclusion-style titles and choose a layout for each slide.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          subtitle: { type: 'string' },
          theme: { type: 'string', enum: ['noir', 'paper', 'ocean', 'forest'] },
          brand: { type: 'string' },
          output_directory: OUTPUT_DIRECTORY_PROPERTY,
          images: OFFICE_IMAGES_PROPERTY,
          replace_artifact_id: REPLACE_ARTIFACT_ID_PROPERTY,
          slides: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                layout: { type: 'string', enum: ['cover', 'section', 'kpi', 'chart', 'statement', 'split', 'process', 'quote', 'bullets', 'end'] },
                eyebrow: { type: 'string' },
                bullets: { type: 'array', items: { type: 'string' } },
                body: { type: 'string' },
                subtitle: { type: 'string' },
                kpi: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      value: { type: 'string' },
                      label: { type: 'string' },
                      unit: { type: 'string' },
                      delta: { type: 'string' },
                    },
                    required: ['value'],
                  },
                },
                chart: {
                  type: 'object',
                  properties: {
                    type: { type: 'string', enum: ['bar', 'line', 'pie'] },
                    categories: { type: 'array', items: { type: 'string' } },
                    series: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          name: { type: 'string' },
                          values: { type: 'array', items: { type: 'number' } },
                        },
                        required: ['values'],
                      },
                    },
                  },
                  required: ['type', 'series'],
                },
                quote: {
                  oneOf: [
                    { type: 'string' },
                    {
                      type: 'object',
                      properties: { text: { type: 'string' }, source: { type: 'string' } },
                      required: ['text'],
                    },
                  ],
                },
              },
              required: ['title'],
            },
          },
        },
        required: ['title', 'slides'],
      },
    },
  },
  create_docx: {
    type: 'function',
    function: {
      name: 'create_docx',
      description: 'Create a Word (.docx) artifact from structured paragraphs and headings.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          paragraphs: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                heading: { type: 'integer', minimum: 1, maximum: 3 },
                text: { type: 'string' },
              },
              required: ['text'],
            },
          },
          images: OFFICE_IMAGES_PROPERTY,
          output_directory: OUTPUT_DIRECTORY_PROPERTY,
          replace_artifact_id: REPLACE_ARTIFACT_ID_PROPERTY,
        },
        required: ['title', 'paragraphs'],
      },
    },
  },
  create_xlsx: {
    type: 'function',
    function: {
      name: 'create_xlsx',
      description: 'Create an Excel (.xlsx) artifact from named sheets containing two-dimensional row arrays.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          sheets: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                rows: { type: 'array', items: { type: 'array', items: {} } },
              },
              required: ['name', 'rows'],
            },
          },
          images: OFFICE_IMAGES_PROPERTY,
          output_directory: OUTPUT_DIRECTORY_PROPERTY,
          replace_artifact_id: REPLACE_ARTIFACT_ID_PROPERTY,
        },
        required: ['title', 'sheets'],
      },
    },
  },
  create_pdf: {
    type: 'function',
    function: {
      name: 'create_pdf',
      description: 'Create a real downloadable PDF artifact from Markdown and/or existing authorized raster images. Images are embedded as real PDF image objects; this never calls image generation. The server handles pagination, line wrapping, page numbers, and embedded Unicode/Chinese fonts.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          markdown: { type: 'string' },
          images: OFFICE_IMAGES_PROPERTY,
          output_directory: OUTPUT_DIRECTORY_PROPERTY,
          replace_artifact_id: REPLACE_ARTIFACT_ID_PROPERTY,
        },
        required: ['title'],
        anyOf: [
          { required: ['markdown'] },
          { required: ['images'] },
        ],
      },
    },
  },
  create_html_app: {
    type: 'function',
    function: {
      name: 'create_html_app',
      description: 'Create a polished managed HTML artifact that opens in Gugo preview. Use it for a standalone deliverable, an explicitly referenced managed artifact, or when the user names only an output directory/drive (set output_directory). Existing authorized local images/audio/video are input assets, not requests to generate new media: declare every one in assets and reference it from HTML as gugo-asset://<id>. When the user asks for every image in a directory, set asset_collection and include every matching file. Gugo bundles those files without exposing local paths. Only bypass this tool when the user names an exact local/workspace .html filename; edit or write that exact file instead. External scripts, styles, frames, file:// URLs, and network requests are rejected.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          output_directory: OUTPUT_DIRECTORY_PROPERTY,
          html: { type: 'string', description: 'Complete HTML document with inline CSS and optional inline JavaScript. For every declared local asset, use its exact gugo-asset://<id> URI in a real browser resource slot such as src, poster, srcset, or CSS url(); comments and JavaScript strings do not count as asset references. Never write file:// or a drive path into HTML.' },
          asset_collection: {
            type: 'object',
            additionalProperties: false,
            description: 'Directory completeness contract. Required when the user asks to use every image in a folder. The server independently scans the directory and rejects the artifact unless every matching file is declared in assets and referenced in the HTML.',
            properties: {
              directory: { type: 'string', minLength: 1, description: 'Authorized absolute source directory containing the existing media.' },
              extensions: { type: 'array', maxItems: 8, items: { type: 'string', enum: ['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif', 'bmp'] } },
              recursive: { type: 'boolean', description: 'Include matching files in subdirectories. Defaults to true.' },
            },
            required: ['directory'],
          },
          assets: {
            type: 'array',
            maxItems: 500,
            description: 'Authorized existing local image/audio/video inputs to bundle with the HTML. This does not generate media. Every id must be unique and referenced by gugo-asset://<id>. During an in-place revision, omit path only to retain an existing asset with the same id.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' },
                path: { type: 'string', description: 'Existing workspace/local file path or attachment:// URI.' },
              },
              required: ['id'],
            },
          },
          replace_artifact_id: REPLACE_ARTIFACT_ID_PROPERTY,
        },
        required: ['title', 'html'],
      },
    },
  },
})
