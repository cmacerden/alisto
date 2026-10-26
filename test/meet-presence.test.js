const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../lib/database');
const { PresenceService } = require('../lib/presence');
const { projectMeet } = require('../lib/meet-presence');

function fixture(t) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  db.exec(`INSERT INTO teachers (id, name, email, password_hash) VALUES (1, 'Teacher', 'teacher@example.com', 'test'), (2, 'Other', 'other@example.com', 'test');
    INSERT INTO students (id, name, email, password_hash) VALUES (1, 'Student', 'student@example.com', 'test'), (2, 'Peer', 'peer@example.com', 'test');
    INSERT INTO classes (id, teacher_id, title, code) VALUES (1, 1, 'Computing', 'ABC234'), (2, 2, 'Other class', 'DEF234');`);
  let time = 1_000_000;
  const presence = new PresenceService(db, { now: () => time });
  const id = presence.meet.start(1, 1, 'abc-defg-hij');
  const source = 'source_profile_123456';
  const checkpoint = () => presence.checkpoint(id);
  function enroll(student = 1, sourceId = source) { presence.meet.enroll(id, student, 'abc-defg-hij', sourceId, checkpoint); }
  function observe(state = 'in', student = 1, sourceId = source) {
    presence.meet.observe(id, student, { meetCode: 'abc-defg-hij', sourceId, state }, checkpoint);
  }
  return { db, presence, id, source, enroll, observe,
    advance(ms) { time += ms; },
    run(ms, state = 'in') {
      while (ms > 0) { const step = Math.min(ms, 5000); time += step; observe(state); ms -= step; }
    },
    self() { return presence.snapshot(id, { id: 1, role: 'student' }).self; }
  };
}

test('Meet enrollment is uncertain, not Active; actual in-call evidence starts 60-second grace', t => {
  const f = fixture(t); f.enroll();
  assert.equal(f.self().status, null);
  assert.equal(f.self().detection_notice, 'Cannot verify');
  assert.equal(f.self().joined_at, null);
  f.advance(10000); f.observe();
  assert.equal(f.self().status, 'Active');
  assert.equal(f.self().grace_remaining_ms, 60000);
  assert.equal(f.self().excluded_seconds, 10);
  f.run(59999);
  assert.equal(f.self().grace_remaining_ms, 1);
  f.advance(1); f.observe();
  assert.equal(f.self().activity_rate, null);
  f.run(1000);
  assert.equal(f.self().active_seconds, 1);
  assert.equal(f.self().activity_rate, 100);
});

test('unknown and out-of-call intervals break incomplete Meet grace without inventing absence', t => {
  const f = fixture(t); f.enroll(); f.observe(); f.run(30000); f.observe('unknown');
  f.run(20000, 'unknown'); f.observe();
  assert.equal(f.self().grace_remaining_ms, 60000);
  f.run(20000); f.observe('out'); f.run(10000, 'out'); f.observe();
  assert.equal(f.self().grace_remaining_ms, 60000);
  f.run(61000);
  assert.equal(f.self().active_seconds, 1);
  assert.equal(f.self().total_seconds, 1);
  assert.equal(f.self().excluded_seconds, 20);
});

test('verified out-of-call time counts after grace; unknown time affects neither side of the rate', t => {
  const f = fixture(t); f.enroll(); f.observe(); f.run(70000);
  f.observe('unknown'); f.run(20000, 'unknown');
  assert.equal(f.self().active_seconds, 10);
  assert.equal(f.self().total_seconds, 10);
  f.observe('out'); f.run(10000, 'out');
  assert.equal(f.self().activity_rate, 50);
  assert.equal(f.self().excluded_seconds, 20);
  f.observe();
  assert.equal(f.self().grace_remaining_ms, null);
  f.run(10000);
  assert.equal(f.self().activity_rate, 20 / 30 * 100);
});

test('missing evidence expires exactly after 15 seconds and cannot earn unbounded call time', t => {
  const f = fixture(t); f.enroll(); f.observe(); f.run(70000); f.advance(45000);
  assert.equal(f.self().active_seconds, 25);
  assert.equal(f.self().total_seconds, 25);
  assert.equal(f.self().excluded_seconds, 30);
  assert.equal(f.self().status, null);
  assert.equal(f.self().detection_notice, 'Cannot verify');
  f.observe(); f.run(5000);
  assert.equal(f.self().active_seconds, 30);
  assert.equal(f.self().grace_remaining_ms, null);
});

test('evidence expiration during grace resets verified continuity even without a prior checkpoint', t => {
  const f = fixture(t); f.enroll(); f.observe(); f.advance(70000); f.observe();
  assert.equal(f.self().grace_remaining_ms, 60000);
  assert.equal(f.self().measurement_started_at, null);
  assert.equal(f.self().excluded_seconds, 55);
});

test('multiple browser sources count once; fresh in-call proof wins, stale sources cannot prove absence', t => {
  const f = fixture(t); f.enroll(); f.observe(); f.run(70000);
  const second = 'source_profile_654321';
  f.enroll(1, second); f.observe('out', 1, second);
  assert.equal(f.self().call_state, 'in');
  f.advance(5000); f.observe('in', 1, second); f.observe('out');
  assert.equal(f.self().active_seconds, 15);
  assert.equal(f.self().call_state, 'in');
  f.advance(20000); f.observe('out', 1, second);
  assert.equal(f.self().call_state, 'unknown');
  f.observe('out');
  assert.equal(f.self().call_state, 'out');
});

test('Meet results are private, labeled with their source, and keep Alisto connection counters untouched', t => {
  const f = fixture(t); f.enroll(); f.observe(); f.enroll(2); f.observe('in', 2);
  const student = f.presence.snapshot(f.id, { id: 1, role: 'student' });
  assert.equal(student.session.source, 'meet');
  assert.equal(student.session.meet_code, 'abc-defg-hij');
  assert.equal(student.session.code, undefined);
  assert.equal(student.students, undefined);
  assert.equal(student.self.email, undefined);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM session_students').get().n, 0);
  assert.equal(f.presence.list({ id: 1, role: 'teacher' })[0].student_count, 2);
  assert.equal(f.presence.list({ id: 1, role: 'student' }).length, 1);
  assert.throws(() => f.presence.snapshot(f.id, { id: 2, role: 'teacher' }), { status: 404 });
});

test('Meet-code uniqueness, class ownership, and legacy join rejection are enforced', t => {
  const f = fixture(t);
  assert.throws(() => f.presence.meet.start(1, 2, 'xyz-abcd-efg'), { status: 404 });
  assert.throws(() => f.presence.meet.start(2, 2, 'abc-defg-hij'), { status: 409 });
  assert.throws(() => f.presence.meet.start(2, 2, 'ABC234'), { status: 400 });
  assert.throws(() => f.presence.resolveJoin({ code: 'ABC234' }, 1), { status: 409 });
  assert.throws(() => f.presence.connect(f.id, 1, 'legacy-tab'), { status: 409 });
  f.enroll();
  assert.throws(() => f.presence.resolveJoin({ sessionId: f.id }, 1), { status: 409 });
});

test('wrong rooms, unregistered observation sources, and unsupported states are rejected', t => {
  const f = fixture(t); f.enroll();
  assert.throws(() => f.presence.meet.observe(f.id, 1, { meetCode: 'abc-defg-hij', sourceId: 'unregistered_source', state: 'in' }, () => f.presence.checkpoint(f.id)), { status: 404 });
  assert.throws(() => f.presence.meet.observe(f.id, 1, { meetCode: 'abc-defg-hij', sourceId: f.source, state: 'focused' }, () => f.presence.checkpoint(f.id)), { status: 400 });
  assert.throws(() => f.presence.meet.enroll(f.id, 1, 'xyz-abcd-efg', f.source, () => f.presence.checkpoint(f.id)), { status: 404 });
});

test('ending locks Meet counters, includes excluded duration, and allows Meet code reuse only in a new session', t => {
  const f = fixture(t); f.enroll(); f.observe(); f.run(70000); f.observe('unknown'); f.advance(5000);
  f.presence.end(f.id, 1);
  const saved = f.presence.snapshot(f.id, { id: 1, role: 'student' });
  assert.equal(saved.self.status, 'Offline');
  assert.equal(saved.self.active_seconds, 10);
  assert.equal(saved.self.excluded_seconds, 5);
  f.advance(900000);
  assert.deepEqual(f.presence.snapshot(f.id, { id: 1, role: 'student' }), saved);
  assert.throws(() => f.observe(), { status: 404 });
  assert.notEqual(f.presence.meet.start(1, 1, 'abc-defg-hij'), f.id);
});

test('Meet recovery freezes at the last consistent checkpoint and excludes restart downtime', t => {
  const f = fixture(t); f.enroll(); f.observe(); f.run(70000); f.observe('unknown');
  f.advance(5000); f.presence.checkpointAll(); f.advance(900000);
  const recovered = new PresenceService(f.db, { now: () => 2_000_000 });
  const snapshot = recovered.snapshot(f.id, { id: 1, role: 'teacher' });
  assert.equal(snapshot.session.status, 'interrupted');
  assert.equal(snapshot.session.ended_at, 1_075_000);
  assert.equal(snapshot.students[0].active_seconds, 10);
  assert.equal(snapshot.students[0].excluded_seconds, 5);
  assert.equal(snapshot.students[0].status, 'Offline');
});

test('Meet snapshots are read-only and backward server clock movement never subtracts time', t => {
  const f = fixture(t); f.enroll(); f.observe(); f.run(70000);
  const before = f.db.prepare('SELECT * FROM meet_students').get();
  f.advance(5000); f.self();
  assert.deepEqual(f.db.prepare('SELECT * FROM meet_students').get(), before);
  f.advance(-10000); f.observe();
  assert.equal(f.self().active_seconds, 10);
});

test('Meet accounting is independent of checkpoint frequency across grace and evidence expiry boundaries', () => {
  const initial = { updated_at: 0, grace_started_at: 0, measurement_started_at: null, active_ms: 0, total_ms: 0, unknown_ms: 0 };
  const sources = [{ state: 'in', expires_at: 90000 }, { state: 'out', expires_at: 120000 }];
  const whole = projectMeet(initial, sources, 150000);
  let segmented = initial;
  for (const at of [5000, 59999, 60000, 60001, 85000, 89999, 90000, 90001, 100000, 120000, 150000]) {
    segmented = projectMeet(segmented, sources, at);
  }
  assert.deepEqual(segmented, whole);
  assert.equal(whole.active_ms, 30000);
  assert.equal(whole.total_ms, 30000);
  assert.equal(whole.unknown_ms, 60000);
});
