export const CLASSIC_STYLE_PART_3 = `  gap: 4px;
}
.split-col-bullets li::before {
  content: '\u2022';
  flex-shrink: 0;
}

/* Table */
.slide-table {
  background: #F4EFE5;
  display: flex;
  flex-direction: column;
  padding: 14px 18px;
}
.table-header {
  margin-bottom: 6px;
}
.table-title {
  font-size: 16px;
  font-weight: 600;
  color: #2A1F17;
}
.table-line {
  width: 24px;
  height: 2px;
  background: #2E8FA3;
  margin-top: 5px;
}
.table-body {
  flex: 1;
  overflow: auto;
  display: flex;
  align-items: center;
}
.table-body table {
  width: 100%;
  border-collapse: collapse;
  font-size: 10px;
}
.table-body th {
  background: #2E8FA3;
  color: white;
  padding: 6px 8px;
  text-align: left;
  font-weight: 600;
}
.table-body td {
  background: #F8F4EC;
  color: #5E4F40;
  padding: 5px 8px;
  border-bottom: 1px solid #DBD2BE;
}

/* Process */
.slide-process {
  background: #F4EFE5;
  display: flex;
  flex-direction: column;
  padding: 14px 18px;
}
.process-header {
  margin-bottom: 6px;
}
.process-title {
  font-size: 16px;
  font-weight: 600;
  color: #2A1F17;
}
.process-line {
  width: 24px;
  height: 2px;
  background: #2E8FA3;
  margin-top: 5px;
}
.process-body {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 8px 0;
}
.process-step {
  flex: 1;
  text-align: center;
  max-width: 140px;
}
.process-circle {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 700;
  color: white;
  margin-bottom: 6px;
}
.process-circle-ember { background: #E86A3C; }
.process-circle-cyan { background: #2E8FA3; }
.process-name {
  font-size: 11px;
  font-weight: 600;
  color: #2A1F17;
}
.process-desc {
  font-size: 9px;
  color: #5E4F40;
  margin-top: 3px;
}
.process-arrow {
  font-size: 14px;
  color: #DBD2BE;
  flex-shrink: 0;
}

/* Section */
.slide-section {
  background: linear-gradient(90deg, #F4EFE5 0%, #EAE2D2 100%);
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 20px 30px;
}
.section-number {
  font-size: 56px;
  font-weight: 700;
  color: #E86A3C;
  line-height: 1;
}
.section-title {
  font-size: 22px;
  font-weight: 700;
  color: #2A1F17;
  margin-top: 8px;
}
.section-desc {
  font-size: 12px;
  color: #5E4F40;
  margin-top: 6px;
}
.section-line {
  width: 30px;
  height: 3px;
  background: #E86A3C;
  margin-top: 10px;
  border-radius: 2px;
}
`

