/**
 * Canonical model-facing schemas for managed artifacts.
 * Both the public tool catalog and the server turn runtime consume this map.
 */
const REPLACE_ARTIFACT_ID_PROPERTY = Object.freeze({
  type: 'string',
  minLength: 1,
  description: 'Set only when the runtime explicitly instructs an in-place revision of an adjacent delivered artifact. Use that exact artifact ID; omit this field when creating a new file or version.',
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
      description: 'Create a real downloadable PDF artifact from Markdown. The server handles pagination, line wrapping, page numbers, and embedded Unicode/Chinese fonts.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          markdown: { type: 'string' },
          replace_artifact_id: REPLACE_ARTIFACT_ID_PROPERTY,
        },
        required: ['title', 'markdown'],
      },
    },
  },
  create_html_app: {
    type: 'function',
    function: {
      name: 'create_html_app',
      description: 'Create a polished, self-contained managed HTML artifact that opens in Gugo preview. Use it for a standalone Gugo deliverable or an explicitly referenced managed artifact. Do not use it when the user names a local/workspace file target; edit or write that exact file instead. External scripts, styles, frames, and network requests are rejected.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          html: { type: 'string', description: 'Complete single-file HTML document with inline CSS and optional inline JavaScript.' },
          replace_artifact_id: REPLACE_ARTIFACT_ID_PROPERTY,
        },
        required: ['title', 'html'],
      },
    },
  },
})
