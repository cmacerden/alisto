const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../lib/database');
const { PresenceService } = require('../lib/presence');

test('version-3 migration preserves Meet results and deleted-ID high-water marks survive restart', t => {
  const root = process.platform === 'win32' && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : os.tmpdir();
  fs.mkdirSync(root, { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, 'alisto-session-id-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'v3.sqlite');
  let db = openDatabase(filename);
  db.exec(`DROP TABLE id_sequences; PRAGMA user_version = 3;
    INSERT INTO teachers (id, name, email, password_hash) VALUES (1, 'Teacher', 't@example.com', 'hash');
    INSERT INTO students (id, name, email, password_hash) VALUES (1, 'Student', 's@example.com', 'hash');
    INSERT INTO classes (id, teacher_id, title, code) VALUES (1, 1, 'Class', 'ABC234');
    INSERT INTO sessions (id, class_id, source, meet_code, status, started_at, ended_at, checkpoint_at)
      VALUES (22, 1, 'meet', 'abc-defg-hij', 'ended', 100000, 200000, 200000);
    INSERT INTO meet_students (session_id, student_id, enrolled_at, joined_at, measurement_started_at, active_ms, total_ms, unknown_ms, updated_at, final_rate)
      VALUES (22, 1, 100000, 100000, 160000, 20000, 30000, 10000, 200000, 200.0/3);`);
  const before = db.prepare('SELECT * FROM meet_students').all();
  db.close(); db = openDatabase(filename);
  assert.equal(db.pragma('user_version', { simple: true }), 5);
  assert.deepEqual(db.prepare('SELECT * FROM meet_students').all(), before);
  let presence = new PresenceService(db);
  presence.deleteEnded(22, 1); db.close();
  db = openDatabase(filename); presence = new PresenceService(db);
  try {
    const next = presence.meet.start(1, 1, 'abc-defg-hij');
    assert.ok(next > 22);
    assert.equal(db.prepare('SELECT count(*) AS n FROM meet_students').get().n, 0);
  } finally { db.close(); }
});
