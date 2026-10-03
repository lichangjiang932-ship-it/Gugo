import { projectHue, projectInitial } from '../lib/projectGlyph.js'

/**
 * A small tinted tile with the project's initial — the project's face in the
 * sidebar and the conversation header. `open` lifts the tint a little so an
 * expanded project reads as the one in use without a second icon.
 */
export default function ProjectGlyph({ name, open = false, size = 'md', className = '', ...attributes }) {
  const hue = projectHue(name)
  const small = size === 'sm'
  // The initial is drawn by CSS (`content: attr(data-initial)`), not as text: it
  // is decoration, and as text it would leak into the row's accessible name and
  // into anything that reads the row (search, copy, tests) as "Pproject".
  return (
    <span
      {...attributes}
      aria-hidden="true"
      data-initial={projectInitial(name)}
      className={`project-glyph inline-flex shrink-0 select-none items-center justify-center font-semibold leading-none ${small ? 'h-4 w-4 rounded-[5px] text-[9px]' : 'h-5 w-5 rounded-md text-[10.5px]'} ${className}`}
      style={{ '--project-hue': hue }}
      data-open={open || undefined}
    />
  )
}
