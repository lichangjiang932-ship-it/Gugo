export const SKILL_RESOURCE_TOOL_NAME = 'read_skill_resource'
export const SKILL_RESOURCE_TOOL_SPECS = [{
  type: 'function',
  function: {
    name: SKILL_RESOURCE_TOOL_NAME,
    description: 'Read a text resource from a skill selected for this turn. Use the selected skill resource manifest, not workspace paths. Omit path to list its resources. Scripts are returned as text only; binary templates are explicitly unsupported. Reading grants no filesystem or execution permission.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        skill_id: { type: 'string', minLength: 1, maxLength: 96 },
        path: { type: 'string', minLength: 1, maxLength: 240 },
        offset: { type: 'integer', minimum: 0, description: 'Zero-based Unicode character offset.' },
        limit: { type: 'integer', minimum: 1, maximum: 8192, description: 'Maximum Unicode characters in this text page.' },
      },
      required: ['skill_id'],
    },
  },
}]
