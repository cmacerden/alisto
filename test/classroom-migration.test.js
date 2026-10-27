const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../lib/database');
const { PresenceService } = require('../lib/presence');

function filename(t) {
  const root = process.platform === 'win32' && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : os.tmpdir();
  fs.mkdirSync(root, { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, 'alisto-classroom-migration-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'test.sqlite');
}

test('version-4 migration adds classroom tables without changing accounts, measurements, logins, or ID sequence', t => {
  const file = filename(t);
  let db = openDatabase(file);
  db.exec(`DROP TABLE participation_responses; DROP TABLE participation_eligibility; DROP TABLE participation_activities; DROP TABLE messages;
    PRAGMA user_version = 4;
    INSERT INTO teachers (id, name, email, password_hash) VALUES (1, 'Teacher', 't@example.com', 'saved-hash');
    INSERT INTO students (id, name, email, password_hash) VALUES (1, 'Student', 's@example.com', 'saved-hash');
    INSERT INTO classes (id, teacher_id, title, code) VALUES (1, 1, 'Class', 'ABC234');
    INSERT INTO sessions (id, class_id, source, meet_code, status, started_at, ended_at, checkpoint_at)
      VALUES (40, 1, 'meet', 'abc-defg-hij', 'ended', 100000, 200000, 200000);
    INSERT INTO meet_students (session_id, student_id, enrolled_at, joined_at, measurement_started_at, active_ms, total_ms, unknown_ms, updated_at, final_rate)
      VALUES (40, 1, 100000, 100000, 160000, 20000, 30000, 10000, 200000, 200.0/3);
    INSERT INTO id_sequences VALUES ('sessions', 100);
    INSERT INTO login_sessions VALUES ('existing', '{"persisted":true}', 9999999999999);`);
  const tables = ['teachers', 'students', 'classes', 'sessions', 'meet_students', 'meet_sources', 'session_students', 'id_sequences', 'login_sessions'];
  const before = Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table}`).all()]));
  db.close(); db = openDatabase(file);
  try {
    assert.equal(db.pragma('user_version', { simple: true }), 5);
    for (const table of tables) assert.deepEqual(db.prepare(`SELECT * FROM ${table}`).all(), before[table]);
    for (const table of ['messages', 'participation_activities', 'participation_eligibility', 'participation_responses']) {
      assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0);
    }
    const presence = new PresenceService(db);
    assert.equal(presence.snapshot(40, { role: 'student', id: 1 }).self.participation.participation_rate, null);
    assert.ok(presence.meet.start(1, 1, 'abc-defg-hij') > 100);
  } finally { db.close(); }
});

test('persisted chat, private responses, and atomic cutoff survive a real database close/reopen', t => {
  const file = filename(t);
  let db = openDatabase(file);
  db.exec(`INSERT INTO teachers (id, name, email, password_hash) VALUES (1, 'Teacher', 't@example.com', 'hash');
    INSERT INTO students (id, name, email, password_hash) VALUES (1, 'Student', 's@example.com', 'hash');
    INSERT INTO classes (id, teacher_id, title, code) VALUES (1, 1, 'Class', 'ABC234');`);
  let at = 100000;
  let presence = new PresenceService(db, { now: () => at });
  const teacher = { role: 'teacher', id: 1 }; const student = { role: 'student', id: 1 };
  const id = presence.start(1, 1).id;
  presence.connect(id, 1, 'tab');
  presence.classroom.postMessage(id, student, 'Saved discussion');
  const prompt = presence.classroom.openPrompt(id, teacher, { body: 'Question', durationSeconds: 60 });
  at += 1000;
  presence.classroom.respond(id, student, prompt.id, { body: 'Private answer', visibility: 'teacher' });
  db.close(); at += 900000;
  db = openDatabase(file); presence = new PresenceService(db, { now: () => at });
  try {
    const saved = presence.classroom.snapshot(id, student);
    assert.equal(saved.session_status, 'interrupted');
    assert.equal(saved.server_time, 101000);
    assert.equal(saved.prompts[0].closed_at, 101000);
    assert.equal(saved.prompts[0].responses[0].body, 'Private answer');
    assert.equal(saved.messages[0].body, 'Saved discussion');
    assert.equal(saved.self.participation_rate, 100);
    at += 100000;
    assert.deepEqual(presence.classroom.snapshot(id, student), saved);
  } finally { db.close(); }
});

test('a newer unsupported schema is refused rather than silently downgraded', t => {
  const file = filename(t);
  const db = openDatabase(file); db.pragma('user_version = 6'); db.close();
  assert.throws(() => openDatabase(file), /newer Alisto version/);
});
