import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'

process.env.APP_DATA_DIR = path.join(os.tmpdir(), 'yma-knowledge-graph-tests', String(process.pid))

const {
  createEntities,
  findEntityByName,
  deleteEntities,
  createRelations,
  addObservations,
  searchNodes,
  readGraph,
  openNodes,
} = await import('../server/services/knowledgeGraph.js')
const { issueTestSession } = await import('./helpers/testAuth.js')

const { userId: TEST_USER } = issueTestSession({ email: 'kg-test@example.com' })

test('createEntities creates entities and returns them', () => {
  const result = createEntities({
    userId: TEST_USER,
    entities: [
      { name: 'Project Alpha', entityType: 'project' },
      { name: 'User Smith', entityType: 'person' },
      { name: 'Feature X', entityType: 'feature' },
    ],
  })
  assert.equal(result.length, 3)
  assert.ok(result[0].id)
  assert.equal(result[0].name, 'Project Alpha')
  assert.equal(result[0].entityType, 'project')
})

test('findEntityByName returns entity or null', () => {
  const e = findEntityByName({ userId: TEST_USER, name: 'Project Alpha' })
  assert.ok(e)
  assert.equal(e.name, 'Project Alpha')
  const missing = findEntityByName({ userId: TEST_USER, name: 'nonexistent' })
  assert.equal(missing, null)
})

test('createRelations links entities', () => {
  createRelations({
    userId: TEST_USER,
    relations: [
      { from: 'Project Alpha', to: 'Feature X', relationType: 'has_feature' },
      { from: 'User Smith', to: 'Project Alpha', relationType: 'works_on' },
    ],
  })
  // Verify by reading graph
  const graph = readGraph({ userId: TEST_USER })
  assert.ok(graph.relations.length >= 2)
  const relTypes = graph.relations.map((r) => r.relationType)
  assert.ok(relTypes.includes('has_feature'))
  assert.ok(relTypes.includes('works_on'))
})

test('addObservations attaches observations to entities', () => {
  addObservations({
    userId: TEST_USER,
    observations: [
      { entityName: 'Project Alpha', contents: ['这是一个测试项目', '使用 React 构建'] },
      { entityName: 'Feature X', contents: ['核心功能模块'] },
    ],
  })
  const opened = openNodes({ userId: TEST_USER, names: ['Project Alpha'] })
  assert.equal(opened.length, 1)
  assert.ok(opened[0].observations.length >= 2)
})

test('searchNodes finds matching entities, relations, observations', () => {
  const result = searchNodes({ userId: TEST_USER, query: 'Alpha' })
  assert.ok(result.entities.length >= 1)
  assert.equal(result.entities[0].name, 'Project Alpha')
})

test('openNodes returns entities with relations and observations', () => {
  const result = openNodes({ userId: TEST_USER, names: ['Project Alpha', 'Feature X'] })
  assert.equal(result.length, 2)
  for (const node of result) {
    assert.ok(node.relations)
    assert.ok(node.observations)
  }
})

test('deleteEntities removes entity and cascades', () => {
  createEntities({ userId: TEST_USER, entities: [{ name: 'Temp Entity', entityType: 'temp' }] })
  assert.ok(findEntityByName({ userId: TEST_USER, name: 'Temp Entity' }))
  deleteEntities({ userId: TEST_USER, entityNames: ['Temp Entity'] })
  assert.equal(findEntityByName({ userId: TEST_USER, name: 'Temp Entity' }), null)
})

test('readGraph returns full graph structure', () => {
  const graph = readGraph({ userId: TEST_USER })
  assert.ok(Array.isArray(graph.entities))
  assert.ok(Array.isArray(graph.relations))
  assert.ok(Array.isArray(graph.observations))
  assert.ok(graph.entities.length >= 3) // Project Alpha, User Smith, Feature X
})

test('knowledge graph is isolated by user', () => {
  const { userId: otherUser } = issueTestSession({ email: 'kg-other@example.com' })
  createEntities({ userId: otherUser, entities: [{ name: 'Secret', entityType: 'secret' }] })
  const myGraph = readGraph({ userId: TEST_USER })
  const names = myGraph.entities.map((e) => e.name)
  assert.ok(!names.includes('Secret'), 'other user entities should not leak')
  // cleanup
  deleteEntities({ userId: otherUser, entityNames: ['Secret'] })
})

test('readGraph reports totalEntities and truncated=false when under the limit', () => {
  const graph = readGraph({ userId: TEST_USER })
  assert.equal(graph.truncated, false)
  assert.equal(graph.totalEntities, graph.entities.length)
})

test('readGraph signals truncation instead of silently dropping entities', () => {
  const { userId } = issueTestSession({ email: 'kg-truncate@example.com' })
  // 名字按字典序排列,便于断言分页窗口
  const entities = Array.from({ length: 250 }, (_, i) => ({
    name: `Node ${String(i).padStart(3, '0')}`,
    entityType: 'bulk',
  }))
  createEntities({ userId, entities })

  const page = readGraph({ userId })
  assert.equal(page.totalEntities, 250, 'total should count all entities, not just the page')
  assert.equal(page.entities.length, 200, 'default page size still caps at 200')
  assert.equal(page.truncated, true, 'caller must be told the graph is incomplete')

  const rest = readGraph({ userId, offset: 200 })
  assert.equal(rest.entities.length, 50)
  assert.equal(rest.truncated, false, 'final page is not truncated')
  assert.equal(rest.totalEntities, 250)

  deleteEntities({ userId, entityNames: entities.map((e) => e.name) })
})

test('readGraph returns relations whose far endpoint is outside the page window', () => {
  const { userId } = issueTestSession({ email: 'kg-edge@example.com' })
  // 复现原始 bug 的形状:关系的 from 端被分页截断在窗口外,to 端在窗口内。
  // 旧实现只按 from_entity_id 查询,这类关系会被静默丢弃。
  createEntities({
    userId,
    entities: [
      { name: 'AAA Target', entityType: 'node' },
      { name: 'zzz Source', entityType: 'node' },
    ],
  })
  createRelations({
    userId,
    relations: [{ from: 'zzz Source', to: 'AAA Target', relationType: 'points_at' }],
  })

  const page = readGraph({ userId, limit: 1 })
  assert.equal(page.entities.length, 1)
  assert.equal(page.entities[0].name, 'AAA Target', 'only the to-end is in the page window')
  assert.equal(page.truncated, true)
  // from 端不在本页,关系本身仍应返回,而不是被静默丢弃
  const relTypes = page.relations.map((r) => r.relationType)
  assert.ok(relTypes.includes('points_at'), 'relation must not vanish when its source is paged out')

  deleteEntities({ userId, entityNames: ['AAA Target', 'zzz Source'] })
})
