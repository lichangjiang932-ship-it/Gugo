export default function RailDisclosureIcon({ collapsed }) {
  return <svg viewBox="0 0 24 24" className="left-rail-disclosure-icon" aria-hidden="true" focusable="false"
    data-sidebar-disclosure={collapsed ? 'collapsed' : 'expanded'}>
    <rect x="2.5" y="4" width="19" height="16" rx="4.5" fill="currentColor" opacity="0.07" />
    <rect x="4.5" y="6" width="4.5" height="12" rx="2.25" fill="currentColor" opacity="0.28" />
    <path d={collapsed ? 'm13 8.5 3.5 3.5-3.5 3.5' : 'm16.5 8.5-3.5 3.5 3.5 3.5'}
      fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
}
