export const SKILL_QUALITY_MARKER = '<!-- gugo-skill-quality:v1 -->'

const UNIVERSAL_CONTRACT = `## Runtime delivery contract
- Inspect the real inputs, available workspace, and current state before acting.
- Treat the selected skill's own instructions and bundled scripts, references, templates, and assets as the domain workflow. Load only what the task needs, prefer deterministic bundled resources over recreating them, and do not replace specialist guidance with generic advice.
- Honor the requested operation and output format. Read-only review, translation, research, explanation, and planning tasks must not mutate files or external systems unless the user also asks for those changes.
- When the request authorizes changes, use the available tools to create or modify the real deliverable, then inspect the result, run the most relevant checks, fix in-scope failures, and re-check.
- Never claim that a command ran, a file changed, an external action completed, or an artifact was verified unless tool evidence confirms it. If a required capability is unavailable, state exactly what remains unverified.
- Treat scratch files, logs, screenshots, caches, and intermediate exports as internal work. Present only final deliverables unless the user explicitly asks for diagnostics.
- For artifact-producing tasks, link final deliverables by their real paths when the client supports file links and summarize verification. For answer-only tasks, return the requested answer without inventing a file deliverable.`

const CATEGORY_CONTRACTS = Object.freeze({
  web: 'When producing or changing a web deliverable, open the rendered result in a real browser when possible; verify target widths, overflow, keyboard focus, interactions, console errors, loading states, and readable contrast before delivery.',
  slides: 'When producing or changing slides, render the deck and inspect every slide for clipping, overlap, legibility, visual rhythm, editable text, correct count, and successful export before delivery.',
  document: 'When producing or changing a document artifact, render or reopen the exported file; verify headings, pagination, tables, links, fonts, margins, and that no requested content was lost.',
  spreadsheet: 'When producing or changing a spreadsheet, reopen the workbook; verify formulas, data types, ranges, totals, filters, charts, frozen panes, and representative values without replacing formulas with guessed numbers.',
  pdf: 'When producing or changing a PDF, render every page; verify page count, crop, orientation, searchable text where expected, form fields when relevant, and absence of clipping or blank pages.',
  image: 'When producing or changing an image, inspect the actual output at full size; verify dimensions, crop, transparency, text spelling, subject integrity, and requested format.',
  media: 'When producing or changing audio or video, probe and play representative segments; verify duration, streams, codec/container compatibility, synchronization, and audible or visible corruption.',
  translation: 'For translation or localization, preserve meaning, tone, placeholders, markup, identifiers, numbers, and machine-readable structure; apply target-locale conventions consistently and run a terminology and omission pass before returning only the requested format.',
  communication: 'For messages, briefs, posts, or customer-facing copy, identify audience, intent, channel, tone, required facts, and call to action; preserve supplied names and commitments, flag unsupported claims, and keep drafting separate from sending or publishing.',
  data: 'For data, analytics, or visualization work, inspect schema and units first; preserve lineage, filters, null handling, joins, time zones, and denominators; reconcile representative totals and ensure each visual encoding supports the stated conclusion.',
  evaluation: 'For evaluations, benchmarks, audits, or comparisons, define the rubric and pass criteria before scoring; use representative evidence, separate measured results from judgment, make runs reproducible, and report limitations or confounders.',
  security: 'For security, privacy, or compliance work, stay within the authorized scope; avoid exposing secrets or weaponizing findings, preserve evidence, rank issues by exploitability and impact, and verify remediations with focused checks.',
  deployment: 'For deployment and infrastructure work, inspect the target environment and current state first; validate configuration before applying, protect secrets, prefer reversible staged changes, verify health and observability, and provide rollback evidence for risky changes.',
  automation: 'For automation and agent workflows, define inputs, outputs, ownership, retry and idempotency behavior, timeouts, failure paths, and human approval boundaries; dry-run or simulate when possible and verify the resulting state.',
  science: 'For scientific or biomedical work, preserve sample identifiers, units, parameters, provenance, and reference versions; use domain-standard controls and QC, distinguish exploratory output from validated conclusions, and never overstate biological or clinical meaning.',
  finance: 'For financial or investment work, preserve period, currency, units, accounting basis, and source dates; show formulas and assumptions, reconcile key totals, separate facts from scenarios, and avoid presenting uncertain projections as verified outcomes.',
  code: 'When the request authorizes code changes, edit the real project, preserve its conventions, run focused tests plus relevant lint/type/build checks, and report any check that could not run. For code review only, report evidence-backed findings without silently editing the project.',
  research: 'For research, retrieve current primary sources when tools allow, distinguish evidence from inference, attach citations to claims, cross-check consequential facts, and label unresolved uncertainty.',
  connector: 'For connectors and external actions, inspect current state first, use least privilege, require confirmation at the final irreversible boundary when appropriate, and verify the remote result before claiming success.',
  planning: 'For plans, ground tasks in the actual repository or supplied constraints, include dependencies and measurable acceptance criteria, and do not claim implementation or validation that did not occur.',
  archive: 'When producing or changing archives, inspect inputs, preserve relative structure and metadata when requested, validate the result by listing or reopening it, and avoid including temporary or secret files.',
  general: 'Follow the specialist workflow, identify the concrete outcome and its acceptance evidence before acting, and choose verification that directly exercises the requested result while preserving exact-output and read-only constraints.',
})

const SKILL_ID_CATEGORIES = Object.freeze({
  ppt: 'slides',
  webpage: 'web',
  doc: 'document',
  excel: 'spreadsheet',
  mail: 'communication',
  finance: 'finance',
  code: 'code',
  review: 'code',
  test: 'code',
  translate: 'translation',
  research: 'research',
  plan: 'planning',
})

// Classify only from public metadata. Prompt bodies often mention incidental
// tools or formats and must never silently change the skill's declared purpose.
const CATEGORY_RULES = [
  ['slides', /\b(pptx?|powerpoint|slides?|slide-deck|presentation-deck)\b|\u5e7b\u706f\u7247|\u6f14\u793a\u6587\u7a3f/i],
  ['spreadsheet', /\b(xlsx?|spreadsheet|excel|csv|tsv|workbook)\b|\u7535\u5b50\u8868\u683c|\u5de5\u4f5c\u7c3f|\u6570\u636e\u6e05\u6d17|\u900f\u89c6\u5206\u6790/i],
  ['pdf', /\bpdf\b/i],
  ['translation', /\b(translate|translation|translator|locali[sz](?:e|ation)|i18n|l10n)\b|\u7ffb\u8bd1|\u672c\u5730\u5316|\u8bd1\u6587/i],
  ['security', /\b(security|secure|vulnerabilit(?:y|ies)|threat|malware|privacy|compliance|iam|rbac|secret|penetration|owasp|sast|dast)\b|\u5b89\u5168|\u6f0f\u6d1e|\u5a01\u80c1|\u9690\u79c1|\u5408\u89c4/i],
  ['science', /\b(bioinformatics|biomedical|genomics?|transcriptomics?|proteomics?|protein|peptide|antibody|molecule|compound|chemistry|clinical|ngs|rna-?seq|fastq|bam|vcf|admet|docking)\b|\u751f\u7269|\u57fa\u56e0|\u86cb\u767d|\u5206\u5b50|\u5316\u5b66|\u4e34\u5e8a|\u6d4b\u5e8f/i],
  ['finance', /\b(finance|financial|valuation|investment|portfolio|equity|fund|etf|dcf|earnings|capital-allocation|bull-bear|trading|accounting|revenue|forecast)\b|\u8d22\u52a1|\u91d1\u878d|\u4f30\u503c|\u6295\u8d44|\u57fa\u91d1|\u4f1a\u8ba1/i],
  ['connector', /\b(connector|oauth|airtable|asana|canva|dropbox|figma|github|google-(?:calendar|drive)|hubspot|jira|linear|notion|outlook|salesforce|slack|teams|todoist|trello|whatsapp|zoom)\b|\u8fde\u63a5\u5668/i],
  ['deployment', /\b(deploy|deployment|infrastructure|kubernetes|k8s|docker|terraform|cloudformation|helm|serverless|ci\/?cd|pipeline|wrangler|netlify|vercel|cloudflare|aws|azure|gcp)\b|\u90e8\u7f72|\u57fa\u7840\u8bbe\u65bd|\u4e91\u670d\u52a1|\u6d41\u6c34\u7ebf/i],
  ['automation', /\b(automation|workflow|orchestrat\w*|agentic|subagent|parallel-agents?|scheduler|scheduled|hook|batch-job|queue|idempot\w*)\b|\u81ea\u52a8\u5316|\u5de5\u4f5c\u6d41|\u5b50\u4ee3\u7406|\u8c03\u5ea6/i],
  ['evaluation', /\b(evaluation|evaluate|evals?|benchmark|rubric|scorecard|audit|quality-assurance|verification|comparison?)\b|\u8bc4\u4f30|\u8bc4\u6d4b|\u57fa\u51c6|\u8bc4\u5206|\u5ba1\u8ba1|\u9a8c\u6536/i],
  ['data', /\b(data|analytics?|metric|dashboard|visuali[sz]ation|chart|plot|etl|warehouse|database|postgres|sql|schema|tableau|mixpanel|time-series|geospatial)\b|\u6570\u636e|\u5206\u6790|\u6307\u6807|\u770b\u677f|\u53ef\u89c6\u5316|\u6570\u636e\u5e93/i],
  ['web', /\b(html|css|javascript|typescript|react|nextjs|next\.js|vue|svelte|frontend|website|webpage|browser|playwright|shadcn|component|design-system)\b|\u7f51\u9875|\u7f51\u7ad9|\u524d\u7aef|\u6d4f\u89c8\u5668|\u7ec4\u4ef6|\u8bbe\u8ba1\u7cfb\u7edf/i],
  ['document', /\b(docx?|word|document|memo|report|minutes|writer|writing)\b|\u6587\u6863|\u62a5\u544a|\u7eaa\u8981|\u516c\u6587|\u957f\u6587|\u6458\u8981|\u6539\u5199/i],
  ['image', /\b(image|photo|illustration|graphic|svg|png|jpe?g|webp)\b|\u56fe\u7247|\u56fe\u50cf|\u6d77\u62a5|\u63d2\u753b/i],
  ['media', /\b(audio|video|media|mp3|wav|mp4|subtitle|transcript|remotion)\b|\u97f3\u9891|\u89c6\u9891|\u5b57\u5e55|\u8f6c\u5f55/i],
  ['research', /\b(research|investigation|competitive-research|literature|primary-sources?)\b|\u7814\u7a76|\u8c03\u7814|\u7ade\u54c1\u5206\u6790|\u8d8b\u52bf\u5224\u65ad/i],
  ['communication', /\b(email|mail|message|brief|copywriting|blog|post|press-release|client-alert|meeting-prep|interview|sales|marketing|crm|customer|support)\b|\u90ae\u4ef6|\u6d88\u606f|\u7b80\u62a5|\u6587\u6848|\u5ba2\u6237|\u8425\u9500|\u9500\u552e|\u4f1a\u8bae/i],
  ['planning', /\b(plan|planning|roadmap|strategy|brainstorming|requirements?)\b|\u8ba1\u5212|\u89c4\u5212|\u8def\u7ebf\u56fe|\u91cc\u7a0b\u7891|\u4efb\u52a1\u62c6\u89e3/i],
  ['archive', /\b(zip|archive|compress|extract|tar)\b|\u5f52\u6863|\u538b\u7f29|\u89e3\u538b/i],
  ['code', /\b(code|coding|programming|developer|repository|git|unit-test|integration-test|test|debug|review|refactor|swift|ios|macos|android|api|sdk|cli)\b|\u4ee3\u7801|\u7f16\u7a0b|\u4ed3\u5e93|\u5355\u5143\u6d4b\u8bd5|\u8c03\u8bd5|\u5ba1\u67e5|\u91cd\u6784/i],
]

export function classifySkill(skill = {}) {
  const exactId = String(skill.id || '').trim().toLowerCase()
  if (SKILL_ID_CATEGORIES[exactId]) return SKILL_ID_CATEGORIES[exactId]
  const identity = [skill.id, skill.name, skill.pluginId, skill.source?.pluginId]
    .filter(Boolean)
    .join('\n')
  const metadata = [
    identity,
    skill.category,
    skill.description,
    skill.desc,
    ...(Array.isArray(skill.permissions) ? skill.permissions : []),
  ].filter(Boolean).join('\n')
  return CATEGORY_RULES.find(([, pattern]) => pattern.test(identity))?.[0]
    || CATEGORY_RULES.find(([, pattern]) => pattern.test(metadata))?.[0]
    || 'general'
}

export function getSkillQualityContract(skill = {}) {
  const category = classifySkill(skill)
  return [
    SKILL_QUALITY_MARKER,
    UNIVERSAL_CONTRACT,
    `### ${category} verification\n- ${CATEGORY_CONTRACTS[category]}`,
  ].join('\n\n')
}

export function hasSkillQualityContract(skill = {}, value = skill.systemPrompt) {
  const prompt = String(value || '').trim()
  const contract = getSkillQualityContract(skill)
  return prompt === contract || prompt.endsWith(`\n\n${contract}`)
}

export function applySkillQualityContract(skill = {}) {
  const prompt = String(skill.systemPrompt || '').trim()
  if (hasSkillQualityContract(skill, prompt)) return prompt
  return [prompt, getSkillQualityContract(skill)]
    .filter(Boolean)
    .join('\n\n')
}
