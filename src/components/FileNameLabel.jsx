/** Keep the extension visible while only the stem yields to a narrow tab or path. */
export default function FileNameLabel({ value = '', className = '' }) {
  const name = String(value)
  const suffix = name.match(/\.(?:(?:test|spec|d)\.)?[^.\\/]{1,12}$/u)?.[0] || ''
  const extension = suffix.length < name.length ? suffix : ''
  return <span data-file-name className={`inline-flex min-w-0 max-w-full items-baseline not-italic ${className}`}>
    <span className="min-w-0 truncate">{extension ? name.slice(0, -extension.length) : name}</span>
    {extension && <span data-filename-extension className="shrink-0">{extension}</span>}
  </span>
}
