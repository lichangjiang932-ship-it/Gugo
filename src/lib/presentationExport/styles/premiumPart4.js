export const PREMIUM_STYLE_PART_4 = `  display:flex;
  flex-direction:column;
  padding:100px 140px;
  position:relative;
}
.slide-split .grid-bg-light { opacity:0.5; }
.split-tag {
  font-size:16px;
  letter-spacing:7px;
  text-transform:uppercase;
  color:#E86A3C;
  margin-bottom:20px;
  font-weight:700;
}
.split-title {
  font-size:64px;
  font-weight:900;
  color:#2A1F17;
  line-height:1.15;
  letter-spacing:-1px;
}
.split-title-line {
  width:80px; height:5px;
  background: linear-gradient(90deg, #E86A3C 0%, #2E8FA3 100%);
  margin-top:28px;
  border-radius:3px;
}
.split-body {
  display:flex;
  gap:50px;
  margin-top:60px;
  flex:1;
}
.split-col {
  flex:1;
  padding:55px;
  border-radius:28px;
  display:flex;
  flex-direction:column;
  position:relative;
  overflow:hidden;
}
.split-col-cyan {
  background: linear-gradient(135deg, rgba(46,143,163,0.06) 0%, rgba(46,143,163,0.02) 100%);
  border:2px solid rgba(46,143,163,0.18);
  box-shadow: 0 4px 20px rgba(46,143,163,0.08);
}
.split-col-ember {
  background: linear-gradient(135deg, rgba(232,106,60,0.06) 0%, rgba(232,106,60,0.02) 100%);
  border:2px solid rgba(232,106,60,0.18);
  box-shadow: 0 4px 20px rgba(232,106,60,0.08);
}
.split-col-accent {
  position:absolute;
  top:0; left:0; right:0;
  height:5px;
  border-radius:28px 28px 0 0;
}
.split-col-cyan .split-col-accent {
  background: linear-gradient(90deg, #2E8FA3 0%, #236b7a 100%);
}
.split-col-ember .split-col-accent {
  background: linear-gradient(90deg, #E86A3C 0%, #c9552e 100%);
}
.split-col-title {
  font-size:40px;
  font-weight:900;
  margin-bottom:35px;
  letter-spacing:-0.5px;
}
.split-col-title-cyan { color:#2E8FA3; }
.split-col-title-ember { color:#E86A3C; }
.split-col-bullets { list-style:none; }
.split-col-bullets li {
  font-size:26px;
  color:#3d3328;
  line-height:1.6;
  padding:16px 0 16px 40px;
  position:relative;
  border-bottom:1px solid rgba(219,210,190,0.3);
}
.split-col-bullets li:last-child { border-bottom:none; }
.split-col-bullets li .bullet-square {
  position:absolute;
  left:0; top:24px;
  width:12px; height:12px;
  border-radius:3px;
}
.bullet-square-cyan { background: linear-gradient(135deg, #2E8FA3 0%, #236b7a 100%); }
.bullet-square-ember { background: linear-gradient(135deg, #E86A3C 0%, #c9552e 100%); }

/* \u2500\u2500 Table \u2500\u2500 */
.slide-table {
  background:#F4EFE5;
  display:flex;
  flex-direction:column;
  padding:100px 140px;
  position:relative;
}
.slide-table .grid-bg-light { opacity:0.5; }
.table-tag {
  font-size:16px;
  letter-spacing:7px;
  text-transform:uppercase;
  color:#2E8FA3;
  margin-bottom:20px;
  font-weight:700;
}
.table-title {
  font-size:64px;
  font-weight:900;
  color:#2A1F17;
  line-height:1.15;
  letter-spacing:-1px;
}
.table-title-line {
  width:80px; height:5px;
  background: linear-gradient(90deg, #2E8FA3 0%, #236b7a 100%);
  margin-top:28px;
  border-radius:3px;
}
.table-body {
  margin-top:55px;
  flex:1;
  overflow:auto;
}
.table-body table {
  width:100%;
  border-collapse:separate;
  border-spacing:0;
  font-size:26px;
  box-shadow: 0 8px 32px rgba(42,31,23,0.08);
  border-radius:16px;
  overflow:hidden;
}
.table-body th {
  background: linear-gradient(135deg, #2E8FA3 0%, #267a8c 100%);
  color:white;
  padding:32px 36px;
  text-align:left;
  font-weight:700;
}
.table-body th:first-child { border-radius:16px 0 0 0; }
.table-body th:last-child { border-radius:0 16px 0 0; }
.table-body td {
  background:white;
  color:#3d3328;
  padding:26px 36px;
  border-bottom:2px solid #EAE2D2;
  font-weight:500;
}
.table-body tr:last-child td:first-child { border-radius:0 0 0 16px; }
.table-body tr:last-child td:last-child { border-radius:0 0 16px 0; }
.table-body tr:nth-child(even) td { background:#faf8f4; }

/* \u2500\u2500 Process \u2500\u2500 */
.slide-process {
  background:#F4EFE5;
  display:flex;
  flex-direction:column;
  padding:100px 140px;
  position:relative;
}
.slide-process .grid-bg-light { opacity:0.5; }
.process-tag {
  font-size:16px;
  letter-spacing:7px;
  text-transform:uppercase;
  color:#2E8FA3;
  margin-bottom:20px;
  font-weight:700;
}
.process-title {
  font-size:64px;
  font-weight:900;
  color:#2A1F17;
  line-height:1.15;
  letter-spacing:-1px;
}
.process-title-line {
  width:80px; height:5px;
  background: linear-gradient(90deg, #2E8FA3 0%, #236b7a 100%);
  margin-top:28px;
  border-radius:3px;
}
.process-body {
  display:flex;
  align-items:flex-start;
  gap:20px;
  margin-top:70px;
  flex:1;
  position:relative;
}
.process-track {
  position:absolute;
  top:44px; left:90px; right:90px;
  height:3px;
  background: linear-gradient(90deg, #E86A3C 0%, #2E8FA3 100%);
  opacity:0.3;
  border-radius:2px;
}
.process-step {
  flex:1;
  text-align:center;
  display:flex;
  flex-direction:column;
  align-items:center;
  position:relative;
  z-index:1;
}
.process-circle {
  width:100px; height:100px;
  border-radius:50%;
  display:inline-flex;
  align-items:center;
  justify-content:center;
  font-size:40px;
  font-weight:900;
  color:white;
  margin-bottom:35px;`

