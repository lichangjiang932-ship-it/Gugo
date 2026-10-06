import { fileTypeFamily } from '../lib/fileTypeFamily.js'

/**
 * A file's type at a glance: a page with a folded corner and a coloured badge,
 * the way the reference desktop apps draw a document in their tabs and menus;
 * a file of no known family is a quiet page.
 *
 * The badge's letters are drawn by CSS (`.file-glyph-badge::after`), not as text
 * nodes, so the icon never becomes part of a tab's or a row's accessible name.
 */
export default function FileTypeGlyph({ name = '', type = '', size = 16, className = '' }) {
  const family = fileTypeFamily(type) || fileTypeFamily(name)
  const color = family?.color || 'currentColor'
  const stroke = family ? color : 'currentColor'
  return (
    <span aria-hidden="true" data-file-family={family?.id || 'file'}
      className={`file-glyph relative inline-flex shrink-0 ${family ? '' : 'text-ink-fade'} ${className}`}
      style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox="0 0 16 16" className="block">
        <path d="M4 1.5h5.2L12.5 4.8V13a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 13V3A1.5 1.5 0 0 1 4 1.5Z"
          fill={family ? `${color}14` : 'none'} stroke={stroke} strokeOpacity={family ? 0.55 : 0.8} strokeWidth="1" />
        <path d="M9 1.6V4a1 1 0 0 0 1 1h2.4" fill="none" stroke={stroke} strokeOpacity={family ? 0.55 : 0.8} strokeWidth="1" />
        {family?.id === 'image' && <>
          <circle cx="6" cy="8" r="1.1" fill={color} />
          <path d="M3.6 12.6 6.4 9.9l1.6 1.4 1.9-2.1 1.9 3.4Z" fill={color} />
        </>}
      </svg>
      {family?.label && family.id !== 'image' && (
        <span className={`file-glyph-badge ${family.label.length > 1 ? 'file-glyph-badge-wide' : ''}`}
          data-label={family.label} style={{ backgroundColor: color, fontSize: Math.max(5, size * (family.label.length > 1 ? 0.27 : 0.34)) }} />
      )}
    </span>
  )
}
