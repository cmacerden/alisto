const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../lib/database');
const { PresenceService } = require('../lib/presence');

function fixture(t) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  db.exec(`INSERT INTO teachers (id, name, email, password_hash) VALUES (1, 'Teacher', 'teacher@example.com', 'test');
    INSERT INTO students (id, name, email, password_hash) VALUES
      (1, 'Student One', 'one@example.com', 'test'), (2, 'Student Two', 'two@example.com', 'test');
    INSERT INTO classes (id, teacher_id, title, code) VALUES (1, 1, 'Computing', 'ABC234');`);
  let time = 1_000_000;
  const presence = new PresenceService(db, { now: () => time });
  const session = presence.start(1, 1);
  return {
    db, presence, session,
    advance(milliseconds) { time += milliseconds; },
    at(timestamp) { time = 1_000_000 + timestamp; },
    self() { return presence.snapshot(session.id, { id: 1, role: 'student' }).self; },
    join(connection = 'tab-one') { presence.connect(session.id, 1, connection); },
    leave(connection = 'tab-one') { presence.disconnect(session.id, 1, connection); }
  };
}

test('presence is Active immediately but unmeasured for the first 60 seconds', t => {
  const f = fixture(t); f.join();
  assert.equal(f.self().status, 'Active');
  assert.equal(f.self().activity_rate, null);
  assert.equal(f.self().grace_remaining_ms, 60000);
  f.advance(59999);
  assert.equal(f.self().total_seconds, 0);
  assert.equal(f.self().grace_remaining_ms, 1);
  f.advance(1);
  assert.equal(f.self().grace_remaining_ms, null);
  assert.equal(f.self().total_seconds, 0);
  f.advance(1000);
  assert.equal(f.self().active_seconds, 1);
  assert.equal(f.self().activity_rate, 100);
});

test('grace restarts before measurement, excluding every earlier interval', t => {
  const f = fixture(t); f.join(); f.advance(30000); f.leave();
  f.advance(20000); f.join();
  assert.equal(f.self().grace_remaining_ms, 60000);
  f.advance(61000);
  assert.equal(f.self().active_seconds, 1);
  assert.equal(f.self().total_seconds, 1);
});

test('approved 15-minute example produces 540 active / 840 measured seconds', t => {
  const f = fixture(t); f.join(); f.at(600000); f.leave(); f.at(900000);
  f.presence.end(f.session.id, 1);
  assert.equal(f.self().active_seconds, 540);
  assert.equal(f.self().total_seconds, 840);
  assert.equal(f.self().activity_rate, 540 / 840 * 100);
  assert.equal(f.self().status, 'Offline');
});

test('reconnection after grace never resets the measurement window', t => {
  const f = fixture(t); f.join(); f.advance(70000); f.leave();
  f.advance(10000); f.join(); f.advance(10000);
  assert.equal(f.self().grace_remaining_ms, null);
  assert.equal(f.self().active_seconds, 20);
  assert.equal(f.self().total_seconds, 30);
  assert.equal(f.self().activity_rate, 20 / 30 * 100);
});

test('closing one of multiple tabs neither disconnects the student nor resets grace', t => {
  const f = fixture(t); f.join('one'); f.advance(30000); f.join('two');
  f.leave('one');
  assert.equal(f.self().status, 'Active');
  assert.equal(f.self().grace_remaining_ms, 30000);
  f.advance(40000); f.leave('two');
  assert.equal(f.self().status, 'Offline');
  assert.equal(f.self().active_seconds, 10);
  f.advance(10000);
  assert.equal(f.self().total_seconds, 20);
});

test('ending during grace preserves N/A; closed results never change', t => {
  const f = fixture(t); f.join(); f.advance(20000); f.presence.end(f.session.id, 1);
  const saved = f.self();
  assert.equal(saved.activity_rate, null);
  assert.equal(saved.total_seconds, 0);
  assert.equal(saved.status, 'Offline');
  f.advance(900000);
  assert.deepEqual(f.self(), saved);
  assert.throws(() => f.join(), { status: 409 });
  assert.throws(() => f.presence.end(f.session.id, 1), { status: 409 });
});

test('interruption recovery freezes all students at one saved cutoff without downtime', t => {
  const f = fixture(t); f.join(); f.advance(70000);
  f.presence.connect(f.session.id, 2, 'other-student');
  f.advance(5000); f.presence.checkpointAll();
  const checkpoint = f.presence.session(f.session.id).checkpoint_at;
  f.advance(500000);
  const recovered = new PresenceService(f.db, { now: () => checkpoint + 500000 });
  const snapshot = recovered.snapshot(f.session.id, { id: 1, role: 'teacher' });
  assert.equal(snapshot.session.status, 'interrupted');
  assert.equal(snapshot.session.ended_at, checkpoint);
  assert.equal(snapshot.students[0].total_seconds, 15);
  assert.equal(snapshot.students[0].active_seconds, 15);
  assert.equal(snapshot.students[1].activity_rate, null);
  assert.ok(snapshot.students.every(student => student.status === 'Offline'));
  const next = recovered.start(1, 1);
  assert.notEqual(next.id, f.session.id);
});

test('snapshots are read-only and late joins have individual grace periods', t => {
  const f = fixture(t); f.join(); f.advance(120000);
  f.presence.connect(f.session.id, 2, 'late');
  const before = f.db.prepare('SELECT * FROM session_students ORDER BY student_id').all();
  f.advance(10000);
  const teacher = f.presence.snapshot(f.session.id, { id: 1, role: 'teacher' });
  assert.equal(teacher.students[0].total_seconds, 70);
  assert.equal(teacher.students[1].grace_remaining_ms, 50000);
  assert.deepEqual(f.db.prepare('SELECT * FROM session_students ORDER BY student_id').all(), before);
});

test('student snapshots expose only their own measurements, never the class roster', t => {
  const f = fixture(t); f.join(); f.presence.connect(f.session.id, 2, 'second');
  const result = f.presence.snapshot(f.session.id, { id: 1, role: 'student' });
  assert.equal(result.students, undefined);
  assert.equal(result.self.student_id, 1);
  assert.equal(result.self.email, undefined);
  assert.equal(result.session.teacher_id, undefined);
});

test('only one live session per class; codes are case-insensitive and require a live session', t => {
  const f = fixture(t);
  assert.throws(() => f.presence.start(1, 1), { status: 409 });
  assert.throws(() => f.presence.start(1, 99), { status: 404 });
  assert.equal(f.presence.resolveJoin({ code: ' abc234 ' }, 1), f.session.id);
  assert.throws(() => f.presence.resolveJoin({ code: 'bad' }, 1), { status: 400 });
  assert.throws(() => f.presence.resolveJoin({ sessionId: f.session.id }, 1), { status: 404 });
  f.presence.end(f.session.id, 1);
  assert.throws(() => f.presence.resolveJoin({ code: 'ABC234' }, 1), { status: 404 });
});

test('repeated join requests are idempotent and disconnected grace remains unmeasured', t => {
  const f = fixture(t); f.join(); f.advance(20000); f.join();
  assert.equal(f.self().grace_remaining_ms, 40000);
  f.leave(); f.advance(120000);
  f.presence.end(f.session.id, 1);
  assert.equal(f.self().activity_rate, null);
  assert.equal(f.self().total_seconds, 0);
});

test('clock rollback cannot subtract measured time', t => {
  const f = fixture(t); f.join(); f.advance(70000); f.presence.checkpointAll();
  f.advance(-5000);
  assert.equal(f.self().total_seconds, 10);
  f.leave();
  assert.equal(f.self().total_seconds, 10);
});
