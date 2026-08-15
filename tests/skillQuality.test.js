import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applySkillQualityContract,
  classifySkill,
  SKILL_QUALITY_MARKER,
} from '../server/utils/skillQuality.js'
import { buildSkillsBlockFromPrepared, SKILL_PROMPT_LIMITS } from '../server/services/promptCompiler.js'
import { SKILLS } from '../src/data.js'

test('classifies representative built-in and imported skills', () => {
  assert.equal(classifySkill({ id: 'webpage', description: 'single file HTML' }), 'web')
  assert.equal(classifySkill({ name: '制作 PPT' }), 'slides')
  assert.equal(classifySkill({ name: 'Excel 数据清理' }), 'spreadsheet')
  assert.equal(classifySkill({ id: 'custom', description: 'unrecognized specialist' }), 'general')
})

test('adds an executable, verifiable delivery contract to every skill', () => {
  const prompt = applySkillQualityContract({ id: 'code', systemPrompt: 'Implement the request.' })
  assert.match(prompt, /Implement the request\./)
  assert.match(prompt, /use the available tools to create or modify the real deliverable/i)
  assert.match(prompt, /run focused tests/i)
  assert.match(prompt, /only final deliverables/i)
})

test('quality contract is idempotent and leaves the source object untouched', () => {
  const skill = { id: 'ppt', name: 'Slides', systemPrompt: 'Create slides.' }
  const once = applySkillQualityContract(skill)
  const twice = applySkillQualityContract({ ...skill, systemPrompt: once })
  assert.equal(twice, once)
  assert.equal(once.split(SKILL_QUALITY_MARKER).length - 1, 1)
  assert.equal(skill.systemPrompt, 'Create slides.')
})

test('a bare public marker cannot bypass the complete quality contract', () => {
  const prompt = applySkillQualityContract({
    id: 'code',
    systemPrompt: `Implement the request.\n\n${SKILL_QUALITY_MARKER}\n\nUnrelated marker text.`,
  })
  assert.match(prompt, /Unrelated marker text\./)
  assert.match(prompt, /Runtime delivery contract/)
  assert.match(prompt, /### code verification/)
  assert.equal(prompt.split(SKILL_QUALITY_MARKER).length - 1, 2)
})

test('classifies the real built-in catalog from public metadata without prompt contamination', () => {
  const expected = {
    ppt: 'slides', webpage: 'web', doc: 'document', excel: 'spreadsheet', mail: 'general',
    finance: 'research', code: 'code', review: 'code', test: 'code', translate: 'general',
    research: 'research', plan: 'planning',
  }
  for (const skill of SKILLS) assert.equal(classifySkill(skill), expected[skill.id], skill.id)
  assert.equal(classifySkill({
    id: 'connector-operator',
    name: 'Connector Operator',
    description: 'Use connected applications safely.',
    systemPrompt: 'Open a webpage only when a connector requires it.',
  }), 'connector')
})

test('read-only and exact-output skills receive conditional, non-mutating guidance', () => {
  const review = applySkillQualityContract({ id: 'review', systemPrompt: 'Report only actionable defects.' })
  const translation = applySkillQualityContract({ id: 'translate', systemPrompt: 'Return only the translation.' })
  assert.match(review, /For code review only, report evidence-backed findings without silently editing/i)
  assert.match(translation, /Honor the requested operation and output format/i)
  assert.match(translation, /answer-only tasks, return the requested answer without inventing a file/i)
})

test('oversized skill prompts retain the quality contract inside the prompt budget', () => {
  const block = buildSkillsBlockFromPrepared({
    skills: [{
      id: 'oversized-code',
      name: 'Oversized code skill',
      description: 'Code maintenance workflow.',
      systemPrompt: 'A'.repeat(SKILL_PROMPT_LIMITS.maxPromptBytes),
    }],
  })
  assert.match(block.text, /Skill prompt truncated by safety budget/)
  assert.match(block.text, /gugo-skill-quality:v1/)
  assert.match(block.text, /Runtime delivery contract/)
  assert.match(block.text, /code verification/)
})

test('the aggregate skill budget never leaves an included oversized skill without its contract', () => {
  const skills = [1, 2, 3].map((index) => ({
    id: `oversized-code-${index}`,
    name: `Oversized code ${index}`,
    description: 'Code maintenance workflow.',
    systemPrompt: String(index).repeat(SKILL_PROMPT_LIMITS.maxPromptBytes),
  }))
  const block = buildSkillsBlockFromPrepared({ skills })

  assert.ok(Buffer.byteLength(block.text, 'utf8') <= SKILL_PROMPT_LIMITS.maxBlockBytes)
  for (const skill of skills) assert.match(block.text, new RegExp(`## ${skill.name}`))
  assert.equal(block.text.split(SKILL_QUALITY_MARKER).length - 1, skills.length)
  assert.equal(block.text.match(/### code verification/g)?.length, skills.length)
  assert.match(block.text, /Additional skill content omitted by safety budget/)
})
