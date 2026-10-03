function cleanKey(value) {
  return String(value ?? '').replace(/[\p{Cc}\p{Cf}]/gu, '?').slice(0, 100)
}

function instancePath(pointer) {
  return '$' + String(pointer || '').split('/').slice(1).map((part) => {
    const key = cleanKey(part.replace(/~1/gu, '/').replace(/~0/gu, '~'))
    return /^\d+$/u.test(key) ? `[${key}]` : `.${key}`
  }).join('')
}

function atPointer(value, pointer) {
  const parts = String(pointer || '').replace(/^#/u, '').split('/').slice(1)
  let current = value
  for (const part of parts) {
    const key = part.replace(/~1/gu, '/').replace(/~0/gu, '~')
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, key)) return undefined
    current = current[key]
  }
  return current
}

function discriminatedBranch(error, schema, args) {
  if (!['oneOf', 'anyOf'].includes(error.keyword)) return null
  const branches = atPointer(schema, error.schemaPath)
  const data = atPointer(args, error.instancePath)
  if (!Array.isArray(branches) || !data || typeof data !== 'object') return null
  for (const key of Object.keys(branches[0]?.properties || {})) {
    const definitions = branches.map((branch) => branch?.properties?.[key])
    if (!definitions.every((entry) => entry && Object.hasOwn(entry, 'const')
      && ['string', 'number', 'boolean'].includes(typeof entry.const))) continue
    const values = definitions.map((entry) => entry.const)
    if (new Set(values).size !== values.length || !Object.hasOwn(data, key)) continue
    const index = values.indexOf(data[key])
    if (index >= 0) return { summary: error, prefix: `${error.schemaPath}/`, selected: `${error.schemaPath}/${index}/` }
  }
  return null
}

/** Only trim diagnostic noise after full validation failed; never choose a branch to validate. */
function relevantErrors(errors, schema, args) {
  const selections = errors.map((error) => discriminatedBranch(error, schema, args)).filter(Boolean)
  return errors.filter((error) => !selections.some((selection) => {
    const root = selection.summary.instancePath
    const sameInput = error.instancePath === root || error.instancePath.startsWith(`${root}/`)
    if (!sameInput) return false
    if (error === selection.summary) return true
    return error.schemaPath.startsWith(selection.prefix) && !error.schemaPath.startsWith(selection.selected)
  }))
}

function enumIssue(path, values) {
  if (Array.isArray(values) && values.length > 0 && values.length <= 20
    && values.every((value) => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,31}$/u.test(value))) {
    return `${path} 必须是 ${values.join(' / ')} 之一`
  }
  return `${path} 必须是允许的枚举值之一`
}

/** Show only short schema enum identifiers, never argument values, consts, URLs or patterns. */
export function toolSchemaIssues(errors = [], { schema, args } = {}) {
  const relevant = relevantErrors(errors, schema, args)
  return (relevant.length ? relevant : errors).slice(0, 8).map((entry) => {
    const path = instancePath(entry.instancePath)
    const params = entry.params || {}
    switch (entry.keyword) {
      case 'type': return `${path} 应为 ${params.type}`
      case 'required': return `${path}.${cleanKey(params.missingProperty)} 为必填参数`
      case 'additionalProperties': return `${path}.${cleanKey(params.additionalProperty)} 是未允许的额外参数`
      case 'unevaluatedProperties': return `${path}.${cleanKey(params.unevaluatedProperty)} 是未允许的额外参数`
      case 'minimum': return `${path} 不能小于 ${params.limit}`
      case 'maximum': return `${path} 不能大于 ${params.limit}`
      case 'exclusiveMinimum': return `${path} 必须大于 ${params.limit}`
      case 'exclusiveMaximum': return `${path} 必须小于 ${params.limit}`
      case 'minLength': return `${path} 长度不能小于 ${params.limit}`
      case 'maxLength': return `${path} 长度不能大于 ${params.limit}`
      case 'minItems': return `${path} 至少需要 ${params.limit} 项`
      case 'maxItems': return `${path} 最多允许 ${params.limit} 项`
      case 'pattern': case 'format': return `${path} 不符合要求的格式`
      case 'anyOf': return `${path} 不符合任一允许的参数形状`
      case 'oneOf': return `${path} 必须恰好符合一种允许的参数形状`
      case 'const': return `${path} 必须符合指定的固定值`
      case 'enum': return enumIssue(path, params.allowedValues)
      case 'uniqueItems': return `${path} 不允许重复项`
      default: return `${path} 不符合工具参数约束 (${cleanKey(entry.keyword)})`
    }
  })
}
