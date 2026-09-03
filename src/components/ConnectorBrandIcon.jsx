function hexToRgba(hex, alpha) {
  const value = String(hex || '').replace('#', '')
  if (!/^[0-9a-f]{6}$/i.test(value)) return `rgb(var(--color-ink-fade-rgb) / ${alpha})`
  const number = Number.parseInt(value, 16)
  return `rgba(${number >> 16}, ${(number >> 8) & 255}, ${number & 255}, ${alpha})`
}

export default function ConnectorBrandIcon({ connector, size = 'md' }) {
  const color = connector?.brandColor || 'rgb(var(--color-ink-fade-rgb))'
  const compact = size === 'sm'
  return (
    <span
      aria-hidden="true"
      className={`${compact ? 'w-9 h-9' : 'w-12 h-12'} relative inline-flex items-center justify-center shrink-0 rounded-full border shadow-sm`}
      style={{
        color,
        borderColor: hexToRgba(color, 0.24),
        background: `linear-gradient(145deg, rgb(var(--color-paper-rgb)) 8%, ${hexToRgba(color, 0.13)} 100%)`,
        boxShadow: `inset 0 1px 0 rgba(255,255,255,.9), 0 5px 14px ${hexToRgba(color, 0.12)}`,
      }}
    >
      <span className={`${compact ? 'w-7 h-7' : 'w-9 h-9'} inline-flex items-center justify-center rounded-full bg-paper/90 shadow-[0_1px_4px_rgba(15,23,42,.08)]`}>
        <BrandMark provider={connector?.provider} color={color} compact={compact} />
      </span>
    </span>
  )
}

function BrandMark({ provider, color, compact }) {
  const cls = compact ? 'w-5 h-5' : 'w-7 h-7'
  switch (provider) {
    case 'browser': return <svg viewBox="0 0 24 24" className={cls} fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="12" cy="12" r="8.5" /><path d="M3.8 12h16.4M12 3.5c2.2 2.4 3.2 5.2 3.2 8.5S14.2 18.1 12 20.5C9.8 18.1 8.8 15.3 8.8 12S9.8 5.9 12 3.5Z" /></svg>
    case 'github': return <svg viewBox="0 0 24 24" className={cls} fill="currentColor"><path d="M12 2.8a9.4 9.4 0 0 0-3 18.3c.5.1.7-.2.7-.5v-1.8c-2.8.6-3.4-1.2-3.4-1.2-.5-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 0 1.6 1 1.6 1 .9 1.6 2.4 1.1 2.9.9.1-.7.4-1.1.7-1.4-2.3-.3-4.6-1.1-4.6-4.7 0-1 .4-1.9 1-2.5-.1-.3-.4-1.3.1-2.5 0 0 .8-.3 2.6 1a9 9 0 0 1 4.8 0c1.8-1.2 2.6-1 2.6-1 .5 1.2.2 2.2.1 2.5.7.7 1 1.5 1 2.5 0 3.6-2.4 4.4-4.6 4.7.4.3.7.9.7 1.8v2.7c0 .3.2.6.7.5A9.4 9.4 0 0 0 12 2.8Z" /></svg>
    case 'notion': return <svg viewBox="0 0 24 24" className={cls} fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="4" y="3.5" width="16" height="17" rx="2.5" /><path d="M8 17V8l8 9V8" /></svg>
    case 'wechat_personal': return <svg viewBox="0 0 24 24" className={cls} fill="currentColor"><path d="M10.3 5c-4 0-7.2 2.5-7.2 5.6 0 1.8 1 3.4 2.8 4.5l-.7 2.2 2.6-1.3c.8.2 1.6.3 2.5.3.3 0 .6 0 .9-.1a5 5 0 0 1-.4-1.9c0-3 2.8-5.4 6.3-5.4h.3C16.4 6.6 13.6 5 10.3 5Zm-2.5 4a.9.9 0 1 1 0-1.8.9.9 0 0 1 0 1.8Zm5 0a.9.9 0 1 1 0-1.8.9.9 0 0 1 0 1.8Z" /><path d="M21.3 14.3c0-2.5-2.5-4.6-5.5-4.6s-5.5 2.1-5.5 4.6 2.5 4.6 5.5 4.6c.7 0 1.3-.1 1.9-.3l2 1-.5-1.8c1.3-.8 2.1-2.1 2.1-3.5Zm-7.3-.8a.7.7 0 1 1 0-1.4.7.7 0 0 1 0 1.4Zm3.8 0a.7.7 0 1 1 0-1.4.7.7 0 0 1 0 1.4Z" /></svg>
    case 'feishu': return <svg viewBox="0 0 24 24" className={cls}><path fill="#3370FF" d="M5 4.5h8.4L19 10l-6 9.5H5l5.9-9.3Z"/><path fill="#00D6B9" d="m5 4.5 5.9 5.7L5 14.6Z"/><path fill="#fff" d="m11.6 8.2 3.3 2.2-3 4.7-2-2 2.4-2.4Z"/></svg>
    case 'web_gmail': return <svg viewBox="0 0 24 24" className={cls} fill="none" strokeWidth="2.5" strokeLinecap="round"><path d="M3 7v11" stroke="#4285F4"/><path d="M21 7v11" stroke="#34A853"/><path d="m3 7 9 7 9-7" stroke="#EA4335"/><path d="M3 18h18" stroke="#FBBC04" opacity=".75"/></svg>
    case 'web_outlook': return <svg viewBox="0 0 24 24" className={cls}><path fill="#0078D4" d="M3 5h10v14H3z"/><path fill="#28A8EA" d="M11 7h10v10H11z"/><path fill="#fff" d="m12 9 4 3 4-3v6h-8z"/><ellipse cx="8" cy="12" rx="3" ry="4" fill="#fff"/><ellipse cx="8" cy="12" rx="1.5" ry="2.4" fill="#0078D4"/></svg>
    case 'web_slack': return <svg viewBox="0 0 24 24" className={cls} strokeLinecap="round" strokeWidth="3"><path d="M8 4v5" stroke="#36C5F0"/><path d="M4 8h5" stroke="#2EB67D"/><path d="M16 20v-5" stroke="#ECB22E"/><path d="M20 16h-5" stroke="#E01E5A"/><path d="M16 4v5" stroke="#E01E5A"/><path d="M20 8h-5" stroke="#36C5F0"/><path d="M8 20v-5" stroke="#2EB67D"/><path d="M4 16h5" stroke="#ECB22E"/></svg>
    case 'web_teams': return <svg viewBox="0 0 24 24" className={cls}><circle cx="17.5" cy="6" r="2.5" fill="#7B83EB"/><circle cx="20" cy="11" r="2" fill="#5059C9"/><path fill="#6264A7" d="M9 7h9v10.5a3 3 0 0 1-3 3H9z"/><path fill="#4B53BC" d="M3 6h10v12H3z"/><path fill="#fff" d="M5.5 8h5v2H9v6H7v-6H5.5z"/></svg>
    case 'web_dingtalk': return <svg viewBox="0 0 24 24" className={cls} fill="currentColor"><path d="M5 4.5c4.2 1.3 8.5 2.3 13 2.7l-2.2 2.1 3.4.8-5.5 4.5 1.8.5L8.2 21l2.2-5.2-4.2-1.2 4.6-3.1C8.6 10 6.7 7.7 5 4.5Z"/></svg>
    case 'web_zoom': return <svg viewBox="0 0 24 24" className={cls} fill="currentColor"><rect x="3" y="6.5" width="12" height="11" rx="3"/><path d="m15 10 6-3v10l-6-3Z"/></svg>
    case 'web_discord': return <svg viewBox="0 0 24 24" className={cls} fill="currentColor"><path d="M6.5 5.5A16 16 0 0 1 10 4.4l.5 1.1a12 12 0 0 1 3 0l.5-1.1a16 16 0 0 1 3.5 1.1c2.2 3 2.8 5.9 2.4 8.8a14 14 0 0 1-4.3 2.2l-1.1-1.5c.7-.3 1.4-.7 2-1.2-3.8 1.7-7.2 1.7-10.9 0 .6.5 1.3.9 2 1.2l-1.1 1.5a14 14 0 0 1-4.3-2.2c-.4-3 .2-5.9 2.3-8.8Zm2 7.2c.9 0 1.6-.8 1.6-1.8s-.7-1.8-1.6-1.8-1.6.8-1.6 1.8.7 1.8 1.6 1.8Zm7 0c.9 0 1.6-.8 1.6-1.8s-.7-1.8-1.6-1.8-1.6.8-1.6 1.8.7 1.8 1.6 1.8Z"/></svg>
    case 'telegram':
    case 'web_telegram': return <svg viewBox="0 0 24 24" className={cls} fill="currentColor"><path d="M21 4 3.8 10.7c-1.2.5-1.2 1.1-.2 1.4l4.4 1.4 1.7 5.2c.2.7.1 1 .8 1 .5 0 .8-.2 1-.4l2.2-2.1 4.6 3.4c.9.5 1.5.3 1.7-.8l2.8-13.4c.3-1.3-.5-1.9-1.8-1.4ZM9 13.2l9.9-6.3c.5-.3.9-.1.5.2l-8.2 7.4-.3 3.2Z"/></svg>
    case 'web_whatsapp': return <svg viewBox="0 0 24 24" className={cls} fill="currentColor"><path d="M12 3a8.5 8.5 0 0 0-7.4 12.7L3.5 20.5l4.9-1.1A8.5 8.5 0 1 0 12 3Zm0 15.4c-1.2 0-2.3-.3-3.3-.8l-.4-.2-2.4.6.6-2.3-.2-.4A6.8 6.8 0 1 1 12 18.4Zm3.8-5.1c-.2-.1-1.2-.6-1.4-.7-.2-.1-.3-.1-.5.1l-.7.8c-.1.2-.3.2-.5.1-1.4-.7-2.3-1.3-3.2-2.9-.2-.3.2-.3.6-1 .1-.2.1-.3 0-.5l-.6-1.5c-.2-.4-.4-.3-.5-.3h-.5c-.2 0-.5.1-.7.3-.8.8-.8 1.9-.6 2.6.5 2 2.4 3.8 4.3 4.6 1.2.5 2.2.8 3 .6.9-.1 1.3-.5 1.5-1 .2-.4.2-.9.1-1-.1-.1-.2-.1-.3-.2Z"/></svg>
    case 'qq': return <svg viewBox="0 0 24 24" className={cls} fill="currentColor"><path d="M12 2.8c-3 0-5 2.7-5 6.3 0 .8.1 1.5.3 2.1-.8 1.2-1.3 2.5-1.5 3.7-.2 1.1.2 1.7.9 1.7.4 0 .8-.2 1.3-.7.9 1.1 2.3 1.8 4 1.8s3.1-.7 4-1.8c.5.5.9.7 1.3.7.7 0 1.1-.6.9-1.7-.2-1.2-.7-2.5-1.5-3.7.2-.7.3-1.4.3-2.1 0-3.6-2-6.3-5-6.3Zm-2 5.4c-.5 0-.8-.5-.8-1.1S9.5 6 10 6s.8.5.8 1.1-.3 1.1-.8 1.1Zm4 0c-.5 0-.8-.5-.8-1.1S13.5 6 14 6s.8.5.8 1.1-.3 1.1-.8 1.1Z"/></svg>
    case 'web_google_drive': return <svg viewBox="0 0 24 24" className={cls}><path d="M9 3h6l6 10h-6Z" fill="#F4B400"/><path d="M9 3 3 13l3 5 6-10Z" fill="#0F9D58"/><path d="M6 18h12l3-5H9Z" fill="#4285F4"/></svg>
    case 'web_calendar': return <svg viewBox="0 0 24 24" className={cls}><rect x="3" y="4" width="18" height="17" rx="2.5" fill="#4285F4"/><path fill="#fff" d="M3 8h18v11H3z"/><path fill="#EA4335" d="M3 8h4v4H3z"/><path fill="#FBBC04" d="M17 8h4v4h-4z"/><path fill="#34A853" d="M17 17h4v2h-4z"/><text x="12" y="17" textAnchor="middle" fontSize="7" fontWeight="700" fill="#4285F4">31</text></svg>
    case 'web_google_docs': return <svg viewBox="0 0 24 24" className={cls}><path fill="#4285F4" d="M5 2h10l4 4v16H5z"/><path fill="#AECBFA" d="M15 2v5h4z"/><path stroke="#fff" strokeWidth="1.5" d="M8 11h8M8 14h8M8 17h6"/></svg>
    case 'web_google_sheets': return <svg viewBox="0 0 24 24" className={cls}><path fill="#0F9D58" d="M5 2h10l4 4v16H5z"/><path fill="#87CEAC" d="M15 2v5h4z"/><path fill="none" stroke="#fff" strokeWidth="1.3" d="M8 10h8v8H8zm0 3h8m-5-3v8"/></svg>
    case 'web_onedrive': return <svg viewBox="0 0 24 24" className={cls}><path fill="#0364B8" d="M9.5 7.2a6 6 0 0 1 10 3.4 4.5 4.5 0 0 1-.3 9H6.3a4.3 4.3 0 0 1-.8-8.5 6 6 0 0 1 4-3.9Z"/><path fill="#28A8EA" d="M5.5 11.1a6 6 0 0 1 10.8 1.5 4 4 0 0 1 2.9 7H6.3a4.3 4.3 0 0 1-.8-8.5Z"/></svg>
    case 'web_sharepoint': return <svg viewBox="0 0 24 24" className={cls}><circle cx="16" cy="7" r="4" fill="#37C6D0"/><circle cx="18" cy="15" r="4" fill="#038387"/><circle cx="10" cy="12" r="7" fill="#0B9E9E"/><path fill="#fff" d="M6.5 8.5h7v2h-4c-.7 0-.7 1 0 1h1.5a3 3 0 0 1 0 6h-4.5v-2H11c.7 0 .7-1 0-1H9.5a3 3 0 0 1 0-6Z"/></svg>
    case 'web_dropbox': return <svg viewBox="0 0 24 24" className={cls} fill="currentColor"><path d="m7 4 5 3-5 3-5-3 5-3Zm10 0 5 3-5 3-5-3 5-3ZM7 11l5 3-5 3-5-3 5-3Zm10 0 5 3-5 3-5-3 5-3Zm-5 4 5 3-5 3-5-3 5-3Z"/></svg>
    case 'web_box': return <svg viewBox="0 0 24 24" className={cls} fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round"><circle cx="6" cy="13" r="3"/><circle cx="13" cy="13" r="3"/><path d="M3 6v7m16-3 4 6m0-6-4 6"/></svg>
    case 'web_tencent_docs': return <svg viewBox="0 0 24 24" className={cls}><path fill="#20A0FF" d="M6 2h9l4 4v16H6z"/><path fill="#8AD5FF" d="M15 2v5h4z"/><path stroke="#fff" strokeWidth="1.5" d="M9 11h7M9 14h7M9 17h5"/></svg>
    case 'web_baidu_netdisk': return <svg viewBox="0 0 24 24" className={cls} fill="currentColor"><ellipse cx="7" cy="8" rx="2.3" ry="3.2" transform="rotate(-25 7 8)"/><ellipse cx="17" cy="8" rx="2.3" ry="3.2" transform="rotate(25 17 8)"/><ellipse cx="4.5" cy="13" rx="2" ry="2.8" transform="rotate(-35 4.5 13)"/><ellipse cx="19.5" cy="13" rx="2" ry="2.8" transform="rotate(35 19.5 13)"/><path d="M7.2 18c0-2.8 2.2-5.6 4.8-5.6s4.8 2.8 4.8 5.6c0 2-2.2 3-4.8 3s-4.8-1-4.8-3Z"/></svg>
    case 'web_alipan': return <svg viewBox="0 0 24 24" className={cls} fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M4 9.5 8 5l4 3.5L8 13Zm16 0L16 5l-4 3.5 4 4.5Z"/><path d="m8 13 4 6 4-6-4-4.5Z"/></svg>
    case 'web_airtable': return <svg viewBox="0 0 24 24" className={cls}><path fill="#FCB400" d="m3 7 9-4 9 4-9 4Z"/><path fill="#18BFFF" d="m13 12 8-4v9l-8 4Z"/><path fill="#F82B60" d="m3 8 8 4v9l-8-4Z"/></svg>
    case 'web_figma': return <svg viewBox="0 0 24 24" className={cls}><circle cx="9" cy="5" r="3" fill="#F24E1E"/><circle cx="15" cy="5" r="3" fill="#FF7262"/><circle cx="9" cy="11" r="3" fill="#A259FF"/><circle cx="15" cy="11" r="3" fill="#1ABCFE"/><circle cx="9" cy="17" r="3" fill="#0ACF83"/></svg>
    case 'web_canva': return <svg viewBox="0 0 24 24" className={cls}><defs><linearGradient id="canva" x1="0" x2="1"><stop stopColor="#00C4CC"/><stop offset="1" stopColor="#7D2AE8"/></linearGradient></defs><circle cx="12" cy="12" r="9" fill="url(#canva)"/><path d="M16 8.5c-1-1.2-4.6-1.2-6.4.7-2 2.1-1 5.9 1.6 6.5 1.8.4 3.7-.3 4.8-1.5" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round"/></svg>
    case 'web_miro': return <svg viewBox="0 0 24 24" className={cls}><rect x="2" y="2" width="20" height="20" rx="5" fill="#FFD02F"/><path stroke="#050038" strokeWidth="2.4" d="m6 16 4-9m0 9 4-9m0 9 4-9"/></svg>
    case 'web_jira': return <svg viewBox="0 0 24 24" className={cls}><path fill="#2684FF" d="M12 2 22 12 12 22 2 12Z"/><path fill="#fff" d="M12 7.5 16.5 12 12 16.5 7.5 12Z"/><path fill="#2684FF" d="m12 10 2 2-2 2-2-2Z"/></svg>
    case 'web_confluence': return <svg viewBox="0 0 24 24" className={cls} fill="currentColor"><path d="M4 15.5c3.5 1.8 5.2 2.2 7.5-.6l1.3-1.6 3 2.5-1.5 1.9c-4 5-8.1 3.2-12 .9Zm16-7c-3.5-1.8-5.2-2.2-7.5.6l-1.3 1.6-3-2.5 1.5-1.9c4-5 8.1-3.2 12-.9Z"/></svg>
    case 'web_linear': return <svg viewBox="0 0 24 24" className={cls} fill="currentColor"><path d="M12 2a10 10 0 0 1 9.8 12H10L2.2 6.2A10 10 0 0 1 12 2Zm8.8 14A10 10 0 0 1 8 21.2V16ZM5 19.2A10 10 0 0 1 2.8 16H5Zm-3-6.1A10 10 0 0 1 2 10l3 3.1Z"/></svg>
    case 'web_trello': return <svg viewBox="0 0 24 24" className={cls}><rect x="3" y="3" width="18" height="18" rx="4" fill="currentColor"/><rect x="6" y="6" width="5" height="11" rx="1.3" fill="#fff"/><rect x="13" y="6" width="5" height="7" rx="1.3" fill="#fff"/></svg>
    case 'web_asana': return <svg viewBox="0 0 24 24" className={cls}><circle cx="12" cy="7" r="4" fill="#F06A6A"/><circle cx="7" cy="16" r="4" fill="#FF8D72"/><circle cx="17" cy="16" r="4" fill="#A855F7"/></svg>
    case 'web_clickup': return <svg viewBox="0 0 24 24" className={cls} fill="none" strokeLinecap="round"><path d="m5 10 7-6 7 6" stroke="#FF4A8D" strokeWidth="3"/><path d="M18.5 14a7 7 0 0 1-13 0" stroke="#7B68EE" strokeWidth="3"/></svg>
    case 'web_monday': return <svg viewBox="0 0 24 24" className={cls} fill="none" strokeLinecap="round" strokeWidth="4"><path d="m6 8-2 6" stroke="#FF3D57"/><path d="m13 8-2 6" stroke="#FFCB00"/><path d="m20 8-2 6" stroke="#00CA72"/></svg>
    case 'web_hubspot': return <svg viewBox="0 0 24 24" className={cls} fill="none" stroke="currentColor" strokeWidth="2"><circle cx="14" cy="13" r="4"/><circle cx="5" cy="16" r="2" fill="currentColor"/><circle cx="17" cy="4" r="2" fill="currentColor"/><path d="m7 15 3-1m5-5 1-3M9 5l3 4"/><path d="M9 3v4H5"/></svg>
    case 'web_salesforce': return <svg viewBox="0 0 24 24" className={cls}><path fill="currentColor" d="M9 5.2a5 5 0 0 1 8.5 2A4.4 4.4 0 1 1 19 15.8H7a4 4 0 1 1 1.1-7.9A5 5 0 0 1 9 5.2Z"/><text x="12" y="14.3" textAnchor="middle" fontSize="4.2" fontWeight="700" fill="#fff">salesforce</text></svg>
    default: return <svg viewBox="0 0 24 24" className={cls} fill="none" stroke={color} strokeWidth="1.8"><circle cx="12" cy="12" r="8"/><path d="M8 12h8M12 8v8"/></svg>
  }
}
