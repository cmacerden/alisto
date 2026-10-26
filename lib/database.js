const Database = require('better-sqlite3');
const fs = require('node:fs');
const path = require('node:path');

function openDatabase(filename) {
  if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new Database(filename);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  const version = db.pragma('user_version', { simple: true });
  if (version > 4) {
    db.close();
    throw new Error('This database was created by a newer Alisto version.');
  }
  db.transaction(() => {
    db.exec(fs.readFileSync(path.join(__dirname, '../database/schema.sql'), 'utf8'));
    const columns = new Set(db.pragma('table_info(sessions)').map(column => column.name));
    if (!columns.has('source')) db.exec("ALTER TABLE sessions ADD COLUMN source TEXT NOT NULL DEFAULT 'alisto' CHECK(source IN ('alisto', 'meet'))");
    if (!columns.has('meet_code')) db.exec('ALTER TABLE sessions ADD COLUMN meet_code TEXT');
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS sessions_one_live_meet ON sessions(meet_code) WHERE status = 'live' AND source = 'meet'");
    db.pragma('user_version = 4');
  })();
  return db;
}

module.exports = { openDatabase };
