import { createHash } from 'node:crypto'
import Ajv from 'ajv'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { isPlainObject, toolError } from './toolCallPrimitives.js'
import {
  argumentBudgetError, measureToolJson, schemaPolicyError, TOOL_SCHEMA_LIMITS,
} from './toolSchemaBudget.js'
import { boundedToolRegExp, TOOL_PATTERN_INPUT_LIMIT } from './toolSchemaPatterns.js'
import { prepareToolSchemaPolicy } from './toolSchemaPolicy.js'
import { toolSchemaIssues } from './toolSchemaIssues.js'

const cache = new Map()
const engines = new Map()
const DEFAULT_SCHEMA = Object.freeze({ type: 'object' })
const MAX_VALIDATION_WORK = 4_000_000

function engineFor(dialect) {
  if (engines.has(dialect)) return engines.get(dialect)
  const Constructor = dialect === '2020' ? Ajv2020 : Ajv
  const engine = new Constructor({
    strictSchema: true, strictTypes: false, strictTuples: false, strictRequired: false,
    allowUnionTypes: true, allErrors: true, ownProperties: true, logger: false,
    coerceTypes: false, useDefaults: false, removeAdditional: false, addUsedSchema: false,
    inlineRefs: false, loopRequired: 64, loopEnum: 64, messages: false,
    code: { regExp: boundedToolRegExp },
  })
  addFormats(engine, { mode: 'fast' })
  for (const [name, definition] of Object.entries(engine.formats)) {
    const validate = typeof definition === 'object' && !(definition instanceof RegExp) ? definition.validate : definition
    if (typeof validate !== 'function' && !(validate instanceof RegExp)) continue
    engine.addFormat(name, {
      ...(typeof definition === 'object' && !(definition instanceof RegExp) ? definition : {}),
      validate(value) {
        if (typeof value === 'string' && value.length > TOOL_PATTERN_INPUT_LIMIT) throw argumentBudgetError('format_input')
        return typeof validate === 'function' ? validate(value) : validate.test(value)
      },
    })
  }
  engines.set(dialect, engine)
  return engine
}

function schemaDialect(schema) {
  const dialect = schema?.$schema
  if (dialect === undefined || /^https?:\/\/json-schema\.org\/draft-07\/schema#?$/u.test(dialect)) return '7'
  if (/^https?:\/\/json-schema\.org\/draft\/2020-12\/schema#?$/u.test(dialect)) return '2020'
  throw schemaPolicyError('schema_dialect')
}

function schemaFailure(error) {
  if (error?.code === 'tool_arguments_budget_exceeded') {
    return toolError('tool_schema_budget_exceeded', '工具参数定义超过安全校验预算，工具未执行。', { retryable: false })
  }
  const unsupported = error?.code === 'tool_schema_unsupported'
    || /unknown keyword|unknown format|no schema with key|strict mode/u.test(String(error?.message || ''))
  return toolError(unsupported ? 'tool_schema_unsupported' : 'tool_schema_invalid',
    unsupported ? '工具参数定义包含当前不支持的约束，工具未执行。' : '工具参数定义无效，工具未执行。',
    { retryable: false, schemaReason: error?.reason || (unsupported ? 'unsupported_keyword' : 'invalid_schema') })
}

function compiledToolSchema(schema = DEFAULT_SCHEMA) {
  let key
  let prepared
  let engine
  try {
    if (!isPlainObject(schema) && typeof schema !== 'boolean') throw new TypeError('Invalid schema')
    measureToolJson(schema, TOOL_SCHEMA_LIMITS)
    const serialized = JSON.stringify(schema)
    key = createHash('sha256').update(serialized).digest('hex')
    if (cache.has(key)) {
      const entry = cache.get(key)
      cache.delete(key)
      cache.set(key, entry)
      return entry
    }
    prepared = JSON.parse(serialized)
    const policy = prepareToolSchemaPolicy(prepared)
    const dialect = schemaDialect(prepared)
    // Normalize the accepted aliases to the exact bundled meta-schema identifier.
    if (isPlainObject(prepared) && prepared.$schema) prepared.$schema = dialect === '2020'
      ? 'https://json-schema.org/draft/2020-12/schema' : 'http://json-schema.org/draft-07/schema#'
    engine = engineFor(dialect)
    const entry = { validate: engine.compile(prepared), ...policy }
    cache.set(key, entry)
    if (cache.size > 128) cache.delete(cache.keys().next().value)
    return entry
  } catch (error) {
    return { error: schemaFailure(error) }
  } finally {
    // Keep only the bounded content-keyed cache, not Ajv's unbounded object cache.
    if (engine && prepared) engine.removeSchema(prepared)
  }
}

/** Registration/catalog callers can reject unsupported schemas before advertising them. */
export function validateToolSchemaDefinition(schema) {
  return compiledToolSchema(schema).error || null
}

export function validateToolSchemaArguments(args, schema) {
  if (!isPlainObject(args)) return toolError('invalid_tool_arguments', '工具参数必须是 JSON 对象。')
  let stats
  try { stats = measureToolJson(args) } catch (error) {
    return toolError(error?.code || 'invalid_tool_arguments', '工具参数不是安全预算内的有限 JSON 对象。')
  }
  const compiled = compiledToolSchema(schema)
  if (compiled.error) return compiled.error
  if (stats.nodes * compiled.expandedNodes > MAX_VALIDATION_WORK
    || (compiled.hasUniqueItems && stats.maxArrayLength ** 2 > MAX_VALIDATION_WORK)) {
    return toolError('tool_arguments_budget_exceeded', '工具参数校验工作量超过安全预算，请缩小输入。')
  }
  try {
    if (compiled.validate(args)) return null
    const issues = toolSchemaIssues(compiled.validate.errors || [], { schema: compiled.validate.schema, args })
    return toolError('tool_arguments_validation_failed', `工具参数校验失败：${issues.join('；')}`, {
      issues, hint: '请按工具参数定义修正后重新调用。',
    })
  } catch (error) {
    return toolError(error?.code === 'tool_arguments_budget_exceeded' ? error.code : 'tool_arguments_validation_failed',
      '工具参数未能在安全预算内完成校验，工具未执行。', { retryable: false })
  }
}
