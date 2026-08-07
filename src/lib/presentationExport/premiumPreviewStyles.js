import { PREMIUM_STYLE_PART_1 } from './styles/premiumPart1.js'
import { PREMIUM_STYLE_PART_2 } from './styles/premiumPart2.js'
import { PREMIUM_STYLE_PART_3 } from './styles/premiumPart3.js'
import { PREMIUM_STYLE_PART_4 } from './styles/premiumPart4.js'
import { PREMIUM_STYLE_PART_5 } from './styles/premiumPart5.js'

export const PREMIUM_CSS = [
  PREMIUM_STYLE_PART_1,
  PREMIUM_STYLE_PART_2,
  PREMIUM_STYLE_PART_3,
  PREMIUM_STYLE_PART_4,
  PREMIUM_STYLE_PART_5,
].join('\n')

export const PREMIUM_RESPONSIVE_CSS = `
@media screen {
  html, body {
    min-height:100%;
    background:#070707;
  }
  body {
    padding:24px;
    overflow:auto;
  }
  .slide {
    width:min(100%, 1120px);
    height:auto;
    aspect-ratio:16/9;
    margin:0 auto 24px;
    border-radius:18px;
    box-shadow:0 26px 90px rgba(0,0,0,.38);
  }
  .slide:last-child { margin-bottom:0; }
}
`

