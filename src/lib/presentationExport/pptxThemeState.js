import { PRESENTATION_THEMES as THEMES } from '../presentationThemes.js'

let theme = THEMES.warm

export function presentationTheme() {
  return theme
}

export function setPresentationTheme(nextTheme) {
  theme = nextTheme || THEMES.warm
}

