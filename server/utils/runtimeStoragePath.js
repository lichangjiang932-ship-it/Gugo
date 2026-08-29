const INVALID_COERCED_PATH_LITERAL = /^(?:undefined|null|nan|[+-]?infinity|\[object (?:object|array)\])$/i
const WINDOWS_RESERVED_DEVICE_BASENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

function isWindowsReservedDeviceSegment(rawSegment) {
  // Win32 strips trailing dots/spaces and treats a reserved basename followed
  // by an extension or alternate-data-stream suffix as the same device.
  const segment = String(rawSegment).replace(/[ .]+$/u, '')
  if (!segment) return false
  const basename = segment.split(/[.:]/u, 1)[0].replace(/ +$/u, '')
  return WINDOWS_RESERVED_DEVICE_BASENAME.test(basename)
}

function containsWindowsReservedDevicePath(value) {
  const segments = String(value).split(/[\\/]/u)
  // A drive-relative path such as C:NUL has no separator between the drive
  // designator and its first path segment.
  if (/^[a-z]:/iu.test(segments[0] || '')) segments[0] = segments[0].slice(2)
  return segments.some(isWindowsReservedDeviceSegment)
}

function invalidRuntimeStoragePath(key, value) {
  const rendered = String(value).trim()
  const error = new Error(`${key} contains an invalid filesystem path literal: ${rendered || '<blank>'}`)
  error.code = 'RUNTIME_STORAGE_PATH_INVALID'
  error.retryable = false
  error.key = key
  error.value = rendered
  return error
}

/**
 * Reject values commonly produced by accidentally assigning nullish or other
 * non-path JavaScript values to process.env. Node stringifies those values,
 * which would otherwise make SQLite create files such as "undefined".
 */
export function validateRuntimeStoragePath(value, {
  key = 'storage path',
  platform = process.platform,
} = {}) {
  if (value === undefined || value === null || value === '') return null
  const rendered = String(value)
  const normalized = rendered.trim()
  if (
    normalized === ''
    || normalized.includes('\0')
    || INVALID_COERCED_PATH_LITERAL.test(normalized)
    || (platform === 'win32' && containsWindowsReservedDevicePath(rendered))
  ) {
    throw invalidRuntimeStoragePath(key, value)
  }
  return rendered
}
