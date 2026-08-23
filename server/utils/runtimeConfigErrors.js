const PUBLIC_RUNTIME_CONFIG_ERRORS = Object.freeze({
  RUNTIME_CONFIG_FILE_INVALID: Object.freeze({
    statusCode: 422,
    message: '运行配置文件 runtime.json 内容无效，请修正后重试',
  }),
  RUNTIME_CONFIG_FILE_TOO_LARGE: Object.freeze({
    statusCode: 413,
    message: '运行配置文件 runtime.json 超过 64 KiB 限制，请缩小后重试',
  }),
  PLUGIN_CONFIG_FILE_INVALID: Object.freeze({
    statusCode: 422,
    message: '运行配置中的 pluginConfig 无效，请修正后重试',
  }),
})

/**
 * Convert only known runtime-config validation failures into a public HTTP
 * response. Filesystem paths, parser details and causes deliberately stay on
 * the server-side error object.
 */
export function toPublicRuntimeConfigHttpError(error) {
  const code = String(error?.code || '')
  const definition = PUBLIC_RUNTIME_CONFIG_ERRORS[code]
  if (!definition) return null
  return Object.freeze({
    statusCode: definition.statusCode,
    body: Object.freeze({
      ok: false,
      error: Object.freeze({
        code,
        message: definition.message,
        action: 'EDIT_RUNTIME_CONFIG',
        filename: 'runtime.json',
      }),
    }),
  })
}
