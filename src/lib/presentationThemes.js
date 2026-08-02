export const PRESENTATION_THEMES = {
  warm: {
    id: 'warm', paper: 'F4EFE5', paper2: 'EAE2D2', ink: '2A1F17', inkSoft: '5E4F40',
    inkFade: '8A7B68', ember: 'E86A3C', cyan: '2E8FA3', white: 'FFFFFF', skeleton: 'DBD2BE',
    glowA: 'F6B26B', glowB: 'F08A5D',
  },
  tech: {
    id: 'tech', paper: 'EEF2FF', paper2: 'E0E7FF', ink: '151A2D', inkSoft: '334155',
    inkFade: '64748B', ember: '6366F1', cyan: '06B6D4', white: 'FFFFFF', skeleton: 'CBD5E1',
    glowA: '818CF8', glowB: '22D3EE',
  },
  finance: {
    id: 'finance', paper: 'EEF7F1', paper2: 'DDEFE4', ink: '13261C', inkSoft: '315141',
    inkFade: '5F7D6B', ember: '0F766E', cyan: '65A30D', white: 'FFFFFF', skeleton: 'C6D8CC',
    glowA: '34D399', glowB: 'A3E635',
  },
  consumer: {
    id: 'consumer', paper: 'FFF1F2', paper2: 'FFE4E6', ink: '32121A', inkSoft: '6B3240',
    inkFade: '9F5D6F', ember: 'F43F5E', cyan: 'FB7185', white: 'FFFFFF', skeleton: 'F4C7CF',
    glowA: 'FDA4AF', glowB: 'FBCFE8',
  },
}

export function resolvePresentationTheme(topic = '') {
  const text = String(topic || '').toLowerCase()
  if (/ai|saas|software|cloud|tech|digital|\u667a\u80fd|\u79d1\u6280|\u7b97\u6cd5|\u5e73\u53f0/.test(text)) return PRESENTATION_THEMES.tech
  if (/bank|finance|fund|insurance|wealth|\u91d1\u878d|\u94f6\u884c|\u4fdd\u9669|\u57fa\u91d1|\u6295\u7814/.test(text)) return PRESENTATION_THEMES.finance
  if (/consumer|brand|retail|beauty|food|fashion|\u6d88\u8d39|\u54c1\u724c|\u96f6\u552e|\u7f8e\u5986|\u9910\u996e/.test(text)) return PRESENTATION_THEMES.consumer
  if (!text.trim()) return PRESENTATION_THEMES.warm

  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  const fallbackThemes = Object.values(PRESENTATION_THEMES)
  return fallbackThemes[(hash >>> 0) % fallbackThemes.length]
}

export function buildPremiumThemeOverride(theme) {
  const value = theme || PRESENTATION_THEMES.warm
  return `
:root {
  --deck-paper:#${value.paper}; --deck-paper-2:#${value.paper2};
  --deck-ink:#${value.ink}; --deck-ink-soft:#${value.inkSoft}; --deck-ink-fade:#${value.inkFade};
  --deck-primary:#${value.ember}; --deck-secondary:#${value.cyan};
  --deck-white:#${value.white}; --deck-line:#${value.skeleton};
}
.slide { background:var(--deck-paper); color:var(--deck-ink); }
.slide-cover,.slide-end,.slide-data,.slide-quote,.slide-template-dark-card { background:var(--deck-ink); }
.toc-sidebar { background:var(--deck-ink); }
.accent-bar-v,.accent-bar-h { background:linear-gradient(180deg,var(--deck-primary),var(--deck-secondary)); }
.content-title,.split-title,.table-title,.process-title,.image-title { color:var(--deck-ink); }
.content-tag,.split-tag,.table-tag,.process-tag,.image-tag,.cover-tag,.end-tag { color:var(--deck-primary); }
.content-title-line,.split-title-line,.table-title-line,.process-title-line,.image-title-line { background:var(--deck-primary); }
.content-card,.split-col,.table-body { border-color:var(--deck-line); }
.content-card-index,.data-value { color:var(--deck-primary); }
.content-card-text,.split-col-title,.process-name { color:var(--deck-ink); }
.content-card-note,.data-label,.process-desc,.corner-badge { color:var(--deck-ink-fade); }
.glow-ember,.data-glow-1,.content-orb-a { background:#${value.glowA}; }
.glow-cyan,.data-glow-2,.content-orb-b { background:#${value.glowB}; }
.content-footer-line,.cover-line-bottom,.end-line-bottom { background:linear-gradient(90deg,var(--deck-primary),var(--deck-secondary)); }
`
}
