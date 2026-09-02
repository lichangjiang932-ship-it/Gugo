import {
  DEFAULT_RENDER_DPI,
  MAX_RENDER_DPI,
  MAX_RENDER_PAGES,
  MIN_RENDER_DPI,
  SUPPORTED_OPERATIONS,
} from './pdfToolSupport.js'

const pageSelectionProperties = {
  pages: {
    type: 'array',
    items: { type: 'integer', minimum: 1 },
    description: 'Optional 1-based page numbers. Defaults to all pages for rotate/watermark.',
  },
  ranges: {
    type: 'array',
    items: {
      anyOf: [
        { type: 'string', description: 'Inclusive 1-based range such as "2-5".' },
        {
          type: 'object',
          properties: {
            start: { type: 'integer', minimum: 1 },
            end: { type: 'integer', minimum: 1 },
          },
          required: ['start'],
        },
      ],
    },
  },
}

export const PDF_TOOL_SPECS = [
  {
    type: 'function',
    function: {
      name: 'pdf_info',
      description: 'Inspect a PDF without the 5 MB text-file limit. Reports pages, metadata, AcroForm fields, encryption, XFA, and digital-signature limitations.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative or user-authorized PDF path.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pdf_text',
      description: 'Extract selectable PDF text page by page, including Unicode/Chinese text and optional text-item coordinates. Coordinates are axis-aligned PDF-point bounds with a bottom-left origin, suitable as a starting point for overlay_text. Does not OCR scanned/image-only pages. Enforces server page, character, and item limits; use pages/ranges to read large PDFs in batches.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative or user-authorized PDF path.' },
          ...pageSelectionProperties,
          includeItems: { type: 'boolean', description: 'Defaults true. Set false to omit coordinate items and return page text only.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'render_pdf_pages',
      description: 'Render real PDF pages to downloadable PNG or JPEG images. This is deterministic conversion of the source PDF, never AI image generation. Omitting pages renders every page (up to the safety limit); an explicit pages list preserves its order.',
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string', description: 'Workspace-relative, attachment://, or authorized local PDF path.' },
          title: { type: 'string', description: 'Base title for generated page image artifacts.' },
          pages: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_RENDER_PAGES,
            items: { type: 'integer', minimum: 1 },
            description: 'Optional 1-based page numbers in desired output order. Omit to render every page.',
          },
          format: { type: 'string', enum: ['png', 'jpeg'], default: 'png' },
          dpi: { type: 'number', minimum: MIN_RENDER_DPI, maximum: MAX_RENDER_DPI, default: DEFAULT_RENDER_DPI },
          replace_artifact_id: {
            type: 'string',
            minLength: 1,
            description: 'For a one-page in-place revision only, exact authorized image artifact ID to replace.',
          },
        },
        required: ['input'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pdf_transform',
      description: 'Merge, split, rotate, add Unicode/Chinese watermarks, cover-and-redraw one-line Unicode text by coordinates, or fill PDF forms with Unicode/Chinese values. overlay_text paints an axis-aligned rectangle and a new line; it does not edit/reflow the original text stream. Writes atomically, never overwrites by default, rejects encrypted/XFA/signed PDFs, and preserves AcroForms unless fill_form flatten=true.',
      parameters: {
        type: 'object',
        properties: {
          operation: { type: 'string', enum: [...SUPPORTED_OPERATIONS] },
          input: { type: 'string', description: 'Input PDF for every operation except merge.' },
          inputs: {
            type: 'array',
            items: { type: 'string' },
            description: 'Input PDFs in merge order.',
          },
          output: { type: 'string', description: 'Output path for merge/rotate/watermark/fill_form or a single split selection.' },
          outputs: {
            type: 'array',
            description: 'For split, one output per independent page selection.',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                ...pageSelectionProperties,
              },
              required: ['path'],
            },
          },
          ...pageSelectionProperties,
          degrees: { type: 'integer', description: 'Clockwise relative rotation, in multiples of 90.' },
          text: { type: 'string', description: 'Watermark text.' },
          opacity: { type: 'number', exclusiveMinimum: 0, maximum: 1 },
          fontSize: { type: 'number', exclusiveMinimum: 0 },
          rotation: { type: 'number', description: 'Watermark text rotation in degrees.' },
          patches: {
            type: 'array',
            minItems: 1,
            maxItems: 200,
            description: 'For overlay_text, rectangles in PDF points using a bottom-left origin. Existing content is covered with white by default, then one line of Unicode text (including Chinese) is drawn. pdf_text item bounds can be used as a starting point but should be visually verified.',
            items: {
              type: 'object',
              properties: {
                page: { type: 'integer', minimum: 1 },
                x: { type: 'number', minimum: 0 },
                y: { type: 'number', minimum: 0 },
                width: { type: 'number', exclusiveMinimum: 0 },
                height: { type: 'number', exclusiveMinimum: 0 },
                text: { type: 'string', minLength: 1 },
                fontSize: { type: 'number', exclusiveMinimum: 0 },
                padding: { type: 'number', minimum: 0 },
                color: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' },
                backgroundColor: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' },
                opacity: { type: 'number', exclusiveMinimum: 0, maximum: 1 },
                backgroundOpacity: { type: 'number', exclusiveMinimum: 0, maximum: 1 },
                cover: { type: 'boolean', description: 'Defaults true. Set false to add text without covering the rectangle.' },
              },
              required: ['page', 'x', 'y', 'width', 'height', 'text'],
              additionalProperties: false,
            },
          },
          fields: {
            type: 'object',
            description: 'fill_form map of fully-qualified field names to text, boolean, option, or option-array values.',
            additionalProperties: true,
          },
          flatten: { type: 'boolean', description: 'Only for fill_form. Defaults false so fields remain interactive.' },
          overwrite: { type: 'boolean', description: 'Defaults false. Set true explicitly to replace an existing output.' },
        },
        required: ['operation'],
      },
    },
  },
]
