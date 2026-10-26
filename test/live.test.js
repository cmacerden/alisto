const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { io } = require('socket.io-client');
const { createApp } = require('../lib/app');

test('Phase 2 HTTP and authenticated Socket.IO integration', async t => {
  let time = 1_000_000;
  const runtime = createApp({ databasePath: ':memory:', sessionSecret: 'live-test-secret-at-least-32-characters', enableRateLimit: false, now: () => time });
  const server = http.createServer(runtime.app);
  runtime.attach(server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.disconnect();
    runtime.close();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  });

  function client() {
    return {
      cookie: '', token: '',
      async request(url, method = 'GET', body, csrf = true) {
        const response = await fetch(`${base}${url}`, { method, headers: {
          Cookie: this.cookie, ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(csrf ? { 'X-CSRF-Token': this.token } : {})
        }, body: body ? JSON.stringify(body) : undefined });
        const cookie = response.headers.get('set-cookie');
        if (cookie) this.cookie = cookie.split(';')[0];
        const data = await response.json(); if (data.csrfToken) this.token = data.csrfToken;
        return { status: response.status, data };
      },
      async register(role, email) {
        await this.request('/api/auth/csrf');
        const result = await this.request('/api/auth/register', 'POST', { role, email, name: email.split('@')[0], password: 'SafePassword123!' });
        assert.equal(result.status, 201); this.user = result.data.user;
      }
    };
  }
  async function connect(account, { csrf = account.token, origin, transport = 'websocket', expectError = false } = {}) {
    const socket = io(base, {
      forceNew: true, reconnection: false, transports: [transport],
      auth: { csrfToken: csrf }, extraHeaders: { Cookie: account.cookie, ...(origin ? { Origin: origin } : {}) }, autoConnect: false
    });
    sockets.push(socket);
    const ready = once(socket, expectError ? 'connect_error' : 'connect', { signal: AbortSignal.timeout(4000) });
    socket.connect(); await ready; return socket;
  }
  async function emit(socket, event, payload) { return socket.timeout(4000).emitWithAck(event, payload); }
  function update(socket, predicate) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.off('presence:update', listener); reject(new Error('Expected presence update was not received.')); }, 4000);
      function listener(value) { if (predicate(value)) { clearTimeout(timer); socket.off('presence:update', listener); resolve(value); } }
      socket.on('presence:update', listener);
    });
  }
  const teacher = client(); const other = client(); const student = client(); const peer = client();
  await teacher.register('teacher', 'teacher@example.com');
  await other.register('teacher', 'other@example.com');
  await student.register('student', 'student@example.com');
  await peer.register('student', 'peer@example.com');
  const classroom = (await teacher.request('/api/classes', 'POST', { title: 'Live Computing' })).data.class;
  let session;
  let teacherSocket;
  let studentSocket;
  let peerSocket;

  await t.test('session lifecycle routes enforce login, roles, ownership, and CSRF', async () => {
    const anonymous = client();
    assert.equal((await anonymous.request('/api/sessions')).status, 401);
    assert.equal((await student.request(`/api/classes/${classroom.id}/sessions`, 'POST')).status, 403);
    assert.equal((await other.request(`/api/classes/${classroom.id}/sessions`, 'POST')).status, 404);
    assert.equal((await teacher.request(`/api/classes/${classroom.id}/sessions`, 'POST', undefined, false)).status, 403);
    const result = await teacher.request(`/api/classes/${classroom.id}/sessions`, 'POST');
    assert.equal(result.status, 201); session = result.data.session;
    assert.equal((await teacher.request(`/api/classes/${classroom.id}/sessions`, 'POST')).status, 409);
    assert.equal((await teacher.request('/api/classes')).data.classes[0].live_session_id, session.id);
    assert.equal((await other.request(`/api/sessions/${session.id}`)).status, 404);
    assert.equal((await student.request(`/api/sessions/${session.id}`)).status, 404);
    assert.equal((await teacher.request(`/api/classes/${classroom.id}`, 'DELETE')).status, 409);
  });

  await t.test('sockets reject anonymous users, missing CSRF, and foreign origins', async () => {
    await connect(client(), { expectError: true });
    await connect(teacher, { csrf: '', expectError: true });
    await connect(teacher, { origin: 'https://not-alisto.example', expectError: true });
    teacherSocket = await connect(teacher);
    studentSocket = await connect(student);
    // Exercise polling as well as WebSocket transport.
    peerSocket = await connect(peer, { transport: 'polling' });
    const otherSocket = await connect(other);
    assert.equal((await emit(otherSocket, 'session:watch', { sessionId: session.id })).status, 404);
    assert.equal((await emit(studentSocket, 'session:watch', { sessionId: session.id })).status, 403);
    assert.equal((await emit(teacherSocket, 'session:join', { code: classroom.code })).status, 403);
  });

  await t.test('code-based joining publishes Active and starts grace immediately', async () => {
    assert.equal((await emit(teacherSocket, 'session:watch', { sessionId: session.id })).ok, true);
    const next = update(teacherSocket, snapshot => snapshot.students.length === 1);
    const joined = await emit(studentSocket, 'session:join', { code: classroom.code.toLowerCase() });
    assert.equal(joined.ok, true);
    assert.equal(joined.data.self.status, 'Active');
    assert.equal(joined.data.self.grace_remaining_ms, 60000);
    assert.equal(joined.data.students, undefined);
    const teacherView = await next;
    assert.equal(teacherView.students[0].activity_rate, null);
    assert.equal((await student.request('/api/sessions')).data.sessions.length, 1);
  });

  await t.test('peers receive only their own presence and invalid joins do not leave current sessions', async () => {
    const joined = await emit(peerSocket, 'session:join', { code: classroom.code });
    assert.equal(joined.ok, true);
    assert.equal(joined.data.self.student_id, peer.user.id);
    assert.equal(joined.data.students, undefined);
    assert.equal(joined.data.self.email, undefined);
    assert.equal((await emit(studentSocket, 'session:join', { code: 'ZZZZZZ' })).status, 404);
    const snapshot = (await teacher.request(`/api/sessions/${session.id}`)).data;
    assert.equal(snapshot.students.length, 2);
    assert.ok(snapshot.students.every(row => row.status === 'Active'));
  });

  await t.test('student and teacher see identical post-grace rates and timers', async () => {
    time += 70000;
    const studentView = (await student.request(`/api/sessions/${session.id}`)).data;
    const teacherView = (await teacher.request(`/api/sessions/${session.id}`)).data;
    assert.equal(studentView.self.active_seconds, 10);
    assert.equal(studentView.self.activity_rate, 100);
    assert.equal(studentView.self.total_seconds, teacherView.students.find(row => row.student_id === student.user.id).total_seconds);
    assert.equal(studentView.self.activity_rate, teacherView.students.find(row => row.student_id === student.user.id).activity_rate);
  });

  await t.test('last-tab disconnect becomes Offline; reconnection does not restart completed grace', async () => {
    const secondTab = await connect(student);
    await emit(secondTab, 'session:join', { sessionId: session.id });
    studentSocket.disconnect();
    const offline = update(teacherSocket, value => value.students.find(row => row.student_id === student.user.id)?.status === 'Offline');
    secondTab.disconnect();
    await offline;
    time += 10000;
    studentSocket = await connect(student);
    const joined = await emit(studentSocket, 'session:join', { sessionId: session.id });
    assert.equal(joined.data.self.grace_remaining_ms, null);
    assert.equal(joined.data.self.total_seconds, 20);
    assert.equal(joined.data.self.active_seconds, 10);
    assert.equal(joined.data.self.activity_rate, 50);
  });

  await t.test('leaving one session and joining another does not expose unrelated sessions', async () => {
    const anotherClass = (await teacher.request('/api/classes', 'POST', { title: 'Another class' })).data.class;
    const anotherSession = (await teacher.request(`/api/classes/${anotherClass.id}/sessions`, 'POST')).data.session;
    assert.equal((await student.request(`/api/sessions/${anotherSession.id}`)).status, 404);
    assert.equal((await emit(studentSocket, 'session:join', { sessionId: anotherSession.id })).status, 404);
    const joined = await emit(studentSocket, 'session:join', { code: anotherClass.code });
    assert.equal(joined.data.session.id, anotherSession.id);
    const old = (await student.request(`/api/sessions/${session.id}`)).data;
    assert.equal(old.self.status, 'Offline');
    assert.equal((await emit(studentSocket, 'session:leave', {})).ok, true);
    assert.equal((await student.request(`/api/sessions/${anotherSession.id}`)).data.self.status, 'Offline');
    await teacher.request(`/api/sessions/${anotherSession.id}/end`, 'POST');
    await emit(studentSocket, 'session:join', { sessionId: session.id });
  });

  await t.test('logging out disconnects associated sockets immediately', async () => {
    const disconnected = once(peerSocket, 'disconnect', { signal: AbortSignal.timeout(4000) });
    const offline = update(teacherSocket, value => value.students.find(row => row.student_id === peer.user.id)?.status === 'Offline');
    assert.equal((await peer.request('/api/auth/logout', 'POST')).status, 200);
    await disconnected; await offline;
    await connect(peer, { expectError: true });
  });

  await t.test('ending freezes results, pushes Offline, preserves history, and allows a new session', async () => {
    assert.equal((await other.request(`/api/sessions/${session.id}/end`, 'POST')).status, 404);
    assert.equal((await student.request(`/api/sessions/${session.id}/end`, 'POST')).status, 403);
    const ended = update(studentSocket, value => value.session.status === 'ended');
    const result = await teacher.request(`/api/sessions/${session.id}/end`, 'POST');
    assert.equal(result.status, 200);
    assert.ok(result.data.students.every(row => row.status === 'Offline'));
    assert.equal((await ended).self.status, 'Offline');
    const before = (await student.request(`/api/sessions/${session.id}`)).data;
    time += 600000;
    assert.deepEqual((await student.request(`/api/sessions/${session.id}`)).data, before);
    assert.equal((await emit(studentSocket, 'session:join', { sessionId: session.id })).status, 409);
    assert.equal((await teacher.request(`/api/sessions/${session.id}/end`, 'POST')).status, 409);
    assert.ok((await student.request('/api/sessions')).data.sessions.some(row => row.id === session.id));
    assert.equal((await teacher.request(`/api/classes/${classroom.id}/sessions`, 'POST')).status, 201);
    assert.equal((await teacher.request(`/api/classes/${classroom.id}`)).data.class.code, classroom.code);
  });

  await t.test('expired login sessions disconnect without requiring a student action', async () => {
    const joined = await emit(studentSocket, 'session:join', { code: classroom.code });
    assert.equal(joined.ok, true);
    const disconnected = once(studentSocket, 'disconnect', { signal: AbortSignal.timeout(4000) });
    runtime.db.prepare(`UPDATE login_sessions SET expires_at = 0
      WHERE json_extract(data, '$.user.role') = 'student' AND json_extract(data, '$.user.id') = ?`).run(student.user.id);
    await disconnected;
    assert.equal((await student.request('/api/auth/me')).status, 401);
    const saved = runtime.db.prepare('SELECT connected FROM session_students WHERE session_id = ? AND student_id = ?')
      .get(joined.data.session.id, student.user.id);
    assert.equal(saved.connected, 0);
  });
});
