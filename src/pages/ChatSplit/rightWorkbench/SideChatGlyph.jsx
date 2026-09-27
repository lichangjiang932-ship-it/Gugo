/**
 * The side-chat glyph, redesigned: a speech bubble with three dots.
 *
 * The plain square bubble read as a generic "comment" box, so the side chat now
 * carries its own pattern — a bubble that is visibly *talking* (typing dots),
 * drawn with `currentColor` so it inherits whichever tint tile it sits in.
 */
export function SideChatGlyph({ className }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M4 7a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v5.5a3 3 0 0 1-3 3H9.5L4.8 19A1 1 0 0 1 3.2 18.2L4 15.5V7Z" />
      <circle cx="8.6" cy="9.6" r="0.95" fill="currentColor" stroke="none" />
      <circle cx="12" cy="9.6" r="0.95" fill="currentColor" stroke="none" />
      <circle cx="15.4" cy="9.6" r="0.95" fill="currentColor" stroke="none" />
    </svg>
  )
}
