/**
 * The new-conversation glyph: an open page with a pen crossing its corner, and
 * the brand's green dot where the pen meets the page.
 *
 * A bare "+" says "add something"; this says "start writing", which is what a
 * new conversation is. Drawn on the same 24px grid and stroke as the rail's
 * other icons so it sits in line with search below it.
 */
export default function NewChatGlyph({ className = '' }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {/* The page, open at the top-right where the pen comes in. */}
      <path d="M11.5 4H7a3 3 0 0 0-3 3v10a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-4.5" />
      {/* The pen. */}
      <path d="M17.6 3.6a2.05 2.05 0 0 1 2.9 2.9l-6.7 6.7-3.6.9.9-3.6 6.5-6.9Z" />
      {/* Large enough to read as green at the 15px of the project-row action too. */}
      <circle cx="9.3" cy="15.1" r="1.6" className="fill-accent" stroke="none" />
    </svg>
  )
}
