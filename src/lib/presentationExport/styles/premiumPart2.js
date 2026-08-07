export const PREMIUM_STYLE_PART_2 = `  font-weight:800;
  color:#E86A3C;
  font-variant-numeric: tabular-nums;
  min-width:48px;
}
.toc-item-text {
  font-size:30px;
  color:#2A1F17;
  font-weight:600;
  letter-spacing:-0.3px;
}

/* \u2500\u2500 Section \u2500\u2500 */
.slide-section {
  background: linear-gradient(135deg, #F4EFE5 0%, #EAE2D2 100%);
  display:flex;
  flex-direction:column;
  justify-content:center;
  padding-left:200px;
  position:relative;
}
.slide-section .grid-bg-light { opacity:0.6; }
.section-bg-num {
  position:absolute;
  top:50px; left:80px;
  font-size:280px;
  font-weight:900;
  color:rgba(232,106,60,0.06);
  line-height:1;
  font-variant-numeric:tabular-nums;
  letter-spacing:-10px;
}
.section-decor-tri {
  position:absolute;
  width:0; height:0;
  bottom:80px; right:100px;
  border-left:80px solid transparent;
  border-right:80px solid transparent;
  border-bottom:140px solid rgba(46,143,163,0.08);
  transform:rotate(15deg);
}
.section-title {
  font-size:88px;
  font-weight:900;
  color:#2A1F17;
  max-width:1300px;
  line-height:1.1;
  letter-spacing:-2px;
}
.section-desc {
  font-size:30px;
  color:#5E4F40;
  margin-top:35px;
  max-width:1000px;
  line-height:1.6;
}
.section-line {
  width:100px; height:6px;
  background: linear-gradient(90deg, #E86A3C 0%, #2E8FA3 100%);
  margin-top:45px;
  border-radius:3px;
}

/* \u2500\u2500 Content \u2500\u2500 */
.slide-content {
  background:#F4EFE5;
  display:flex;
  flex-direction:column;
  padding:100px 160px;
  position:relative;
}
.slide-content-light {
  background:
    radial-gradient(circle at 88% 18%, rgba(232,106,60,0.14) 0%, transparent 30%),
    radial-gradient(circle at 10% 82%, rgba(46,143,163,0.12) 0%, transparent 28%),
    linear-gradient(135deg, #F6F0E4 0%, #EAE2D2 100%);
}
.slide-content-dark {
  background:
    radial-gradient(circle at 82% 12%, rgba(232,106,60,0.26) 0%, transparent 30%),
    radial-gradient(circle at 14% 86%, rgba(46,143,163,0.24) 0%, transparent 32%),
    linear-gradient(145deg, #11100e 0%, #1b1712 48%, #0d0c0b 100%);
}
.slide-content .accent-bar-v {
  width:8px;
  background: linear-gradient(180deg, #E86A3C 0%, rgba(232,106,60,0.3) 70%, transparent 100%);
}
.slide-content-dark .accent-bar-v {
  background: linear-gradient(180deg, #E86A3C 0%, #2E8FA3 100%);
  box-shadow: 0 0 24px rgba(232,106,60,.45);
}
.content-orb {
  position:absolute;
  border-radius:999px;
  pointer-events:none;
  filter:blur(6px);
}
.content-orb-a {
  width:360px; height:360px;
  right:-120px; top:70px;
  border:1px solid rgba(232,106,60,.22);
  background:radial-gradient(circle, rgba(232,106,60,.10), transparent 62%);
}
.content-orb-b {
  width:220px; height:220px;
  left:96px; bottom:42px;
  border:1px solid rgba(46,143,163,.18);
  background:radial-gradient(circle, rgba(46,143,163,.10), transparent 64%);
}
.content-shard {
  position:absolute;
  width:240px; height:110px;
  right:120px; bottom:72px;
  transform:skewX(-18deg) rotate(-8deg);
  background:linear-gradient(135deg, rgba(255,255,255,.18), rgba(255,255,255,0));
  border:1px solid rgba(255,255,255,.18);
}
.content-tag {
  font-size:16px;
  letter-spacing:7px;
  text-transform:uppercase;
  color:#E86A3C;
  margin-bottom:20px;
  font-weight:700;
}
.content-title {
  font-size:64px;
  font-weight:900;
  color:#2A1F17;
  line-height:1.15;
  letter-spacing:-1px;
  max-width:1320px;
  position:relative;
  z-index:1;
}
.slide-content-dark .content-title {
  color:#F4EFE5;
  text-shadow:0 12px 42px rgba(0,0,0,.35);
}
.content-title-line {
  width:80px; height:5px;
  background: linear-gradient(90deg, #E86A3C 0%, #2E8FA3 100%);
  margin-top:28px;
  border-radius:3px;
  position:relative;
  z-index:1;
}
.content-card-grid {
  margin-top:58px;
  display:grid;
  grid-template-columns:repeat(2, minmax(0, 1fr));
  gap:28px;
  position:relative;
  z-index:1;
}
.slide-template-editorial .content-card-grid {
  grid-template-columns:1.18fr .82fr;
  grid-auto-rows:minmax(150px, auto);
  align-items:stretch;
}
.slide-template-editorial .content-card:first-child {
  grid-row:span 2;
  min-height:328px;
  padding:42px 44px;
  background:linear-gradient(145deg, rgba(255,255,255,.72), rgba(255,255,255,.45));
}
.slide-template-editorial .content-card:first-child .content-card-text {
  font-size:34px;
  line-height:1.34;
}
.slide-template-editorial .content-card:first-child .content-card-note {
  font-size:21px;
  line-height:1.56;
}
.slide-template-matrix .content-card-grid {
  grid-template-columns:repeat(2, minmax(0, 1fr));
  gap:24px;
}
.slide-template-matrix .content-card {
  min-height:158px;
  border-radius:22px;
  background:
    linear-gradient(135deg, rgba(255,255,255,.68), rgba(255,255,255,.38)),
    radial-gradient(circle at 92% 18%, rgba(46,143,163,.12), transparent 42%);
}
.slide-template-matrix .content-card:nth-child(2n) {
  background:
    linear-gradient(135deg, rgba(255,255,255,.64), rgba(255,255,255,.34)),
    radial-gradient(circle at 12% 88%, rgba(232,106,60,.12), transparent 44%);
}
.slide-template-dark-card {
  padding:92px 130px;
}
.slide-template-dark-card .grid-bg-light {
  opacity:.18;
  filter:invert(1);
}
.slide-template-dark-card .content-card-grid {
  grid-template-columns:repeat(4, minmax(0, 1fr));
  gap:20px;
  margin-top:52px;
}
.slide-template-dark-card .content-card {
  grid-template-columns:1fr;
  min-height:300px;
  padding:34px 28px;
  align-content:start;
  background:linear-gradient(180deg, rgba(244,239,229,.09), rgba(244,239,229,.035));
}
.slide-template-dark-card .content-card-index {
  width:48px;
  height:48px;
  border-radius:16px;
}
.slide-template-dark-card .content-card-text {
  font-size:25px;
}
.slide-template-dark-card .content-card-note {
  grid-column:1;
  margin-top:16px;`

