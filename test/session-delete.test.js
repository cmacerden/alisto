const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { io } = require('socket.io-client');
const { openDatabase } = require('../lib/database');
const { PresenceService } = require('../lib/presence');
const { createApp } = require('../lib/app');
const { createExtensionApi } = require('../extension/api');

function fixture(t) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  db.exec(`INSERT INTO teachers (id, name, email, password_hash) VALUES (1, 'Teacher', 'teacher@example.com', 'hash'), (2, 'Other', 'other@example.com', 'hash');
    INSERT INTO students (id, name, email, password_hash) VALUES (1, 'Student', 'student@example.com', 'hash');
    INSERT INTO classes (id, teacher_id, title, code) VALUES (1, 1, 'Class', 'ABC234'), (2, 2, 'Other class', 'DEF234');`);
  const presence = new PresenceService(db, { now: () => 1_000_000 });
  return { db, presence };
}

test('session deletion refuses live sessions, unknown IDs, and another teacher’s records', t => {
  const { db, presence } = fixture(t);
  const session = presence.start(1, 1);
  assert.throws(() => presence.deleteEnded(session.id, 1), { status: 409 });
  presence.end(session.id, 1);
  assert.throws(() => presence.deleteEnded(session.id, 2), { status: 404 });
  assert.throws(() => presence.deleteEnded(99999, 1), { status: 404 });
  assert.equal(db.prepare('SELECT count(*) AS n FROM sessions').get().n, 1);
});

test('deleting an ended website session removes its counters but preserves accounts, classes, and other sessions', t => {
  const { db, presence } = fixture(t);
  const session = presence.start(1, 1); presence.connect(session.id, 1, 'tab'); presence.end(session.id, 1);
  const other = presence.start(2, 2);
  const deleted = presence.deleteEnded(session.id, 1);
  assert.deepEqual(deleted, { sessionId: session.id, teacherId: 1, studentIds: [1] });
  assert.equal(db.prepare('SELECT count(*) AS n FROM session_students').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM teachers').get().n, 2);
  assert.equal(db.prepare('SELECT count(*) AS n FROM students').get().n, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM classes').get().n, 2);
  assert.equal(presence.session(other.id).status, 'live');
  assert.deepEqual(presence.list({ id: 1, role: 'student' }), []);
  assert.throws(() => presence.snapshot(session.id, { id: 1, role: 'student' }), { status: 404 });
});

test('deleting a Meet session removes its sources and measurements in foreign-key-safe order', t => {
  const { db, presence } = fixture(t);
  const id = presence.meet.start(1, 1, 'abc-defg-hij');
  presence.meet.enroll(id, 1, 'abc-defg-hij', 'profile_123456789', () => presence.checkpoint(id));
  presence.end(id, 1); presence.deleteEnded(id, 1);
  for (const table of ['sessions', 'meet_sources', 'meet_students']) {
    assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0);
  }
  assert.equal(db.pragma('foreign_key_check').length, 0);
  assert.throws(() => presence.meet.live('abc-defg-hij'), { status: 404 });
});

test('interrupted sessions can be deleted, but never through automatic recovery alone', t => {
  const { db, presence } = fixture(t);
  const session = presence.start(1, 1);
  presence.recoverInterrupted();
  assert.equal(presence.session(session.id).status, 'interrupted');
  presence.deleteEnded(session.id, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM sessions').get().n, 0);
});

test('additional linked records block deletion and roll back every partial cleanup', t => {
  const { db, presence } = fixture(t);
  const session = presence.start(1, 1); presence.connect(session.id, 1, 'tab'); presence.end(session.id, 1);
  db.exec(`CREATE TABLE future_reports (session_id INTEGER REFERENCES sessions(id) ON DELETE RESTRICT);
    INSERT INTO future_reports (session_id) VALUES (${session.id});`);
  const before = db.prepare('SELECT * FROM session_students').all();
  assert.throws(() => presence.deleteEnded(session.id, 1), { status: 409 });
  assert.deepEqual(db.prepare('SELECT * FROM session_students').all(), before);
  assert.equal(presence.session(session.id).status, 'ended');
  assert.equal(db.prepare('SELECT count(*) AS n FROM future_reports').get().n, 1);
});

test('deleted session IDs are never reused by either Meet or website creation', t => {
  const { presence } = fixture(t);
  const first = presence.start(1, 1); presence.end(first.id, 1); presence.deleteEnded(first.id, 1);
  const second = presence.meet.start(1, 1, 'abc-defg-hij');
  assert.ok(second > first.id);
  presence.end(second, 1); presence.deleteEnded(second, 1);
  const third = presence.start(1, 1);
  assert.ok(third.id > second);
  assert.throws(() => presence.deleteEnded(first.id, 1), { status: 404 });
  assert.equal(presence.session(third.id).status, 'live');
});

test('deletion preserves a high-water mark for pre-migration session IDs too', t => {
  const { db, presence } = fixture(t);
  db.prepare(`INSERT INTO sessions (id, class_id, status, started_at, ended_at, checkpoint_at)
    VALUES (75, 1, 'ended', 100000, 200000, 200000)`).run();
  presence.deleteEnded(75, 1);
  assert.ok(presence.start(1, 1).id > 75);
});

test('session DELETE API requires confirmation, CSRF, teacher ownership, and notifies/clears socket subscriptions', async t => {
  const runtime = createApp({ databasePath: ':memory:', sessionSecret: 'delete-test-secret-at-least-32-characters', enableRateLimit: false });
  const server = http.createServer(runtime.app);
  const realtime = runtime.attach(server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.disconnect();
    runtime.close();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  function client() {
    let cookie = '';
    const send = async (path, options = {}) => {
      const response = await fetch(`${base}${path}`, { ...options, headers: { ...options.headers, Cookie: cookie } });
      const saved = response.headers.get('set-cookie'); if (saved) cookie = saved.split(';')[0];
      return response;
    };
    return { api: createExtensionApi((url, options) => send(new URL(url).pathname, options)), send, cookie: () => cookie };
  }
  async function connect(client) {
    const { csrfToken } = await client.api.request('/api/auth/me');
    const socket = io(base, { forceNew: true, reconnection: false, transports: ['websocket'], auth: { csrfToken },
      extraHeaders: { Cookie: client.cookie() }, autoConnect: false });
    sockets.push(socket);
    const ready = once(socket, 'connect', { signal: AbortSignal.timeout(4000) }); socket.connect(); await ready;
    return socket;
  }
  const teacher = client(); const student = client(); const other = client();
  for (const [client, role, name] of [[teacher, 'teacher', 'teacher'], [student, 'student', 'student'], [other, 'teacher', 'other']]) {
    await client.api.request('/api/auth/register', { method: 'POST', body: { role, name, email: `${name}@example.com`, password: 'Password123!' } });
  }
  const classroom = (await teacher.api.request('/api/classes', { method: 'POST', body: { title: 'Class' } })).class;
  const session = runtime.presence.start(classroom.id, 1);
  const target = `/api/sessions/${session.id}`;
  const options = { method: 'DELETE', body: { confirm: true } };
  const anonymous = client();
  await anonymous.api.request('/api/auth/csrf');
  await assert.rejects(anonymous.api.request(target, options), { status: 401 });
  const teacherSocket = await connect(teacher); const studentSocket = await connect(student);
  await teacherSocket.timeout(4000).emitWithAck('session:watch', { sessionId: session.id });
  await studentSocket.timeout(4000).emitWithAck('session:join', { code: classroom.code });
  assert.equal((await client().send(target, { method: 'DELETE' })).status, 403); // missing CSRF
  assert.equal((await teacher.send(target, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: '{"confirm":true}' })).status, 403);
  await assert.rejects(student.api.request(target, options), { status: 403 });
  await assert.rejects(other.api.request(target, options), { status: 404 });
  await assert.rejects(teacher.api.request(target, { method: 'DELETE' }), { status: 400 });
  await assert.rejects(teacher.api.request(target, options), { status: 409 });
  runtime.presence.end(session.id, 1);
  const teacherDeleted = once(teacherSocket, 'session:deleted', { signal: AbortSignal.timeout(4000) });
  const studentDeleted = once(studentSocket, 'session:deleted', { signal: AbortSignal.timeout(4000) });
  const result = await teacher.api.request(target, options);
  assert.equal(result.sessionId, session.id);
  assert.deepEqual((await teacherDeleted)[0], { sessionId: session.id });
  assert.deepEqual((await studentDeleted)[0], { sessionId: session.id });
  assert.ok([...realtime.io.sockets.sockets.values()].every(socket => socket.data.sessionId == null));
  assert.equal((await studentSocket.timeout(4000).emitWithAck('session:leave', {})).ok, true);
  await assert.rejects(student.api.request(target), { status: 404 });
  await assert.rejects(teacher.api.request(target, options), { status: 404 });
  assert.deepEqual((await teacher.api.request('/api/sessions')).sessions, []);
  assert.deepEqual((await student.api.request('/api/sessions')).sessions, []);
  assert.equal((await teacher.api.request('/api/classes')).classes[0].has_sessions, 0);
  teacherSocket.disconnect(); studentSocket.disconnect();
  const meetId = runtime.presence.meet.start(classroom.id, 1, 'abc-defg-hij');
  runtime.presence.meet.enroll(meetId, 1, 'abc-defg-hij', 'source_1234567890', () => runtime.presence.checkpoint(meetId));
  runtime.presence.end(meetId, 1);
  await teacher.api.request(`/api/sessions/${meetId}`, options);
  assert.equal(runtime.db.prepare('SELECT count(*) AS n FROM meet_sources').get().n, 0);
  assert.equal(runtime.db.prepare('SELECT count(*) AS n FROM meet_students').get().n, 0);
  await assert.rejects(teacher.api.request('/api/sessions/invalid', options), /Unsupported/);
});
