const path = require('path')
const { getDb } = require(path.join(__dirname, '..', 'server', 'db.js'))
const db = getDb()

console.log('=== Database Status ===')
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
console.log('Tables:', tables.map(t => t.name).join(', '))

const v = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()
console.log('Schema version:', v?.value)

console.log('Jobs:', db.prepare('SELECT COUNT(*) as c FROM jobs').get().c)
console.log('Artifacts:', db.prepare('SELECT COUNT(*) as c FROM job_artifacts').get().c)
console.log('Sessions:', db.prepare('SELECT COUNT(*) as c FROM sessions').get().c)
console.log('Entities:', db.prepare('SELECT COUNT(*) as c FROM entities').get().c)
console.log('Relations:', db.prepare('SELECT COUNT(*) as c FROM relations').get().c)
console.log('Observations:', db.prepare('SELECT COUNT(*) as c FROM observations').get().c)
console.log('Skills:', db.prepare('SELECT COUNT(*) as c FROM skills').get().c)
console.log('Memories:', db.prepare('SELECT COUNT(*) as c FROM memories').get().c)
console.log('Messages: (stored in localStorage, not SQLite)')

console.log('\n=== Recent Artifacts ===')
const arts = db.prepare('SELECT id, job_id, type, title, filename FROM job_artifacts ORDER BY created_at DESC LIMIT 5').all()
arts.forEach(a => console.log(`  ${a.type}: ${a.title} (${a.filename})`))

console.log('\n=== Migration Columns ===')
const cols = db.prepare("PRAGMA table_info(jobs)").all()
const colNames = cols.map(c => c.name)
console.log('Jobs columns:', colNames.join(', '))
console.log('Has user_id:', colNames.includes('user_id'))

process.exit(0)
