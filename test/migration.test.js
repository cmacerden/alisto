const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase } = require('../lib/database');
const { PresenceService } = require('../lib/presence');
const { createApp } = require('../lib/app');

test('Phase 1 databases upgrade additively without losing accounts, classes, or login sessions', t => {
  const root = process.platform === 'win32' && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : os.tmpdir();
  fs.mkdirSync(root, { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, 'alisto-migration-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'legacy.sqlite');
  let db = openDatabase(filename);
  // Recreate a version-1 fixture in this test-owned database only.
  db.exec(`DROP TABLE meet_sources; DROP TABLE meet_students; DROP TABLE session_students; DROP TABLE sessions; PRAGMA user_version = 1;
    INSERT INTO teachers (id, name, email, password_hash) VALUES (7, 'Existing Teacher', 'old@example.com', 'existing-hash');
    INSERT INTO students (id, name, email, password_hash) VALUES (9, 'Existing Student', 'student@example.com', 'student-hash');
    INSERT INTO classes (id, teacher_id, title, code) VALUES (4, 7, 'Existing Class', 'OLD234');
    INSERT INTO login_sessions (sid, data, expires_at) VALUES ('existing-session', '{}', 9999999999999);`);
  db.close();
  db = openDatabase(filename);
  try {
    assert.equal(db.pragma('user_version', { simple: true }), 4);
    assert.equal(db.prepare('SELECT password_hash FROM teachers WHERE id = 7').get().password_hash, 'existing-hash');
    assert.equal(db.prepare('SELECT name FROM students WHERE id = 9').get().name, 'Existing Student');
    assert.equal(db.prepare('SELECT code FROM classes WHERE id = 4').get().code, 'OLD234');
    assert.equal(db.prepare('SELECT count(*) AS count FROM login_sessions').get().count, 1);
    assert.equal(db.prepare('SELECT count(*) AS count FROM sessions').get().count, 0);
    assert.equal(db.prepare('SELECT count(*) AS count FROM session_students').get().count, 0);
  } finally { db.close(); }
});

test('version-2 website results upgrade to version 4 without changing their meaning or counters', t => {
  const root = process.platform === 'win32' && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : os.tmpdir();
  const directory = fs.mkdtempSync(path.join(root, 'alisto-meet-migration-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'v2.sqlite');
  let db = openDatabase(filename);
  db.exec(`DROP TABLE meet_sources; DROP TABLE meet_students; DROP INDEX sessions_one_live_meet;
    ALTER TABLE sessions DROP COLUMN meet_code; ALTER TABLE sessions DROP COLUMN source;
    PRAGMA user_version = 2;
    INSERT INTO teachers (id, name, email, password_hash) VALUES (1, 'Teacher', 't@example.com', 'hash');
    INSERT INTO students (id, name, email, password_hash) VALUES (1, 'Student', 's@example.com', 'hash');
    INSERT INTO classes (id, teacher_id, title, code) VALUES (1, 1, 'Class', 'ABC234');
    INSERT INTO sessions (id, class_id, status, started_at, ended_at, checkpoint_at) VALUES (1, 1, 'ended', 100000, 220000, 220000);
    INSERT INTO session_students (session_id, student_id, joined_at, connected, measurement_started_at, active_ms, total_ms, updated_at, final_rate)
      VALUES (1, 1, 100000, 0, 160000, 30000, 60000, 220000, 50);`);
  const before = db.prepare('SELECT * FROM session_students').get();
  db.close(); db = openDatabase(filename);
  try {
    assert.equal(db.pragma('user_version', { simple: true }), 4);
    assert.deepEqual(db.prepare('SELECT * FROM session_students').get(), before);
    assert.equal(db.prepare('SELECT source FROM sessions').get().source, 'alisto');
    const presence = new PresenceService(db);
    const saved = presence.snapshot(1, { id: 1, role: 'student' });
    assert.equal(saved.self.activity_rate, 50);
    assert.equal(saved.self.active_seconds, 30);
    assert.equal(saved.session.source, 'alisto');
  } finally { db.close(); }
});

test('application startup recovers a persisted interrupted session and exposes saved presence to both roles', t => {
  const root = process.platform === 'win32' && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : os.tmpdir();
  fs.mkdirSync(root, { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, 'alisto-recovery-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'interrupted.sqlite');
  const db = openDatabase(filename);
  db.exec(`INSERT INTO teachers (id, name, email, password_hash) VALUES (1, 'Teacher', 't@example.com', 'hash');
    INSERT INTO students (id, name, email, password_hash) VALUES (1, 'Student', 's@example.com', 'hash');
    INSERT INTO classes (id, teacher_id, title, code) VALUES (1, 1, 'Class', 'ABC234');`);
  let time = 1_000_000;
  const presence = new PresenceService(db, { now: () => time });
  const session = presence.start(1, 1);
  presence.connect(session.id, 1, 'test-connection');
  time += 75000; presence.checkpointAll();
  // Closing the raw fixture database without service shutdown represents an
  // abrupt loss after its persisted checkpoint, not a normal session ending.
  db.close();
  time += 600000;
  const runtime = createApp({ databasePath: filename, sessionSecret: 'recovery-test-secret-at-least-32-characters', now: () => time });
  try {
    const student = runtime.presence.snapshot(session.id, { id: 1, role: 'student' });
    const teacher = runtime.presence.snapshot(session.id, { id: 1, role: 'teacher' });
    assert.equal(student.session.status, 'interrupted');
    assert.equal(student.session.ended_at, 1_075_000);
    assert.equal(student.self.total_seconds, 15);
    assert.equal(student.self.activity_rate, 100);
    assert.equal(student.self.status, 'Offline');
    assert.equal(teacher.students[0].total_seconds, student.self.total_seconds);
    assert.equal(runtime.presence.list({ id: 1, role: 'student' }).length, 1);
    assert.equal(runtime.presence.list({ id: 1, role: 'teacher' }).length, 1);
  } finally { runtime.close(); }
});
