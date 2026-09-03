export default function BrandMark({ className = 'w-7 h-7', title = 'Gugo' }) {
  return (
    <svg
      viewBox="0 0 48 48"
      role="img"
      aria-label={title}
      className={className}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect x="4" y="4" width="40" height="40" rx="13" fill="currentColor" />
      <path
        d="M31.8 17.3a11 11 0 1 0 1.2 12.9h-8.4"
        stroke="rgb(var(--color-paper-rgb))"
        strokeWidth="4.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="m34.2 10.2.9 2.7 2.7.9-2.7.9-.9 2.7-.9-2.7-2.7-.9 2.7-.9.9-2.7Z"
        fill="rgb(var(--color-paper-rgb))"
      />
    </svg>
  )
}
