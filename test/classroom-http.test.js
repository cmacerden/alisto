const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { io } = require('socket.io-client');
const { createApp } = require('../lib/app');
const { createExtensionApi } = require('../extension/api');

test('classroom HTTP enforces CSRF/ownership, private delivery, deadlines, and saved deletion without socket leaks', async t => {
  let time = 1_000_000;
  const runtime = createApp({ databasePath: ':memory:', sessionSecret: 'classroom-http-secret-at-least-32-characters', enableRateLimit: false, now: () => time });
  const server = http.createServer(runtime.app);
  const realtime = runtime.attach(server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const sockets = [];
  t.after(async () => {
    sockets.forEach(socket => socket.disconnect());
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
    const api = createExtensionApi((url, options) => send(new URL(url).pathname, options));
    return { ...api, send, cookie: () => cookie };
  }
  const teacher = client(); const other = client(); const student = client(); const peer = client(); const stranger = client();
  for (const [account, role, name] of [[teacher, 'teacher', 'teacher'], [other, 'teacher', 'other'],
    [student, 'student', 'student'], [peer, 'student', 'peer'], [stranger, 'student', 'stranger']]) {
    await account.request('/api/auth/register', { method: 'POST', body: { role, name, email: `${name}@example.com`, password: 'Password123!' } });
  }
  const classroom = (await teacher.request('/api/classes', { method: 'POST', body: { title: 'Chat class' } })).class;
  const session = (await teacher.request(`/api/meet/classes/${classroom.id}/sessions`, { method: 'POST', body: { meetCode: 'abc-defg-hij' } })).session;
  const path = `/api/sessions/${session.id}`;
  const chat = `${path}/classroom`;
  const post = (body) => ({ method: 'POST', body });
  const source = { meetCode: 'abc-defg-hij', sourceId: 'profile_1234567890' };
  for (const account of [student, peer]) {
    await account.request(`/api/meet/sessions/${session.id}/join`, post(source));
  }
  assert.equal((await client().send(chat)).status, 401);
  await assert.rejects(other.request(chat), { status: 404 });
  await assert.rejects(stranger.request(chat), { status: 404 });
  await assert.rejects(student.request(chat), { status: 403 });
  for (const account of [student, peer]) {
    await account.request(`/api/meet/sessions/${session.id}/observe`, post({ ...source, state: 'in' }));
  }
  const peerToken = (await peer.request('/api/auth/me')).csrfToken;
  const socket = io(base, { autoConnect: false, forceNew: true, reconnection: false, transports: ['websocket'],
    auth: { csrfToken: peerToken }, extraHeaders: { Cookie: peer.cookie() } });
  sockets.push(socket);
  const connected = once(socket, 'connect', { signal: AbortSignal.timeout(4000) }); socket.connect(); await connected;
  // This is the same private subscription used by existing Meet snapshots.
  realtime.io.sockets.sockets.get(socket.id).join(`student:${session.id}:2`);
  const packets = [];
  socket.onAny((event, payload) => packets.push({ event, payload }));
  assert.equal((await teacher.send(`${path}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"body":"No token"}' })).status, 403);
  await assert.rejects(student.request(`${path}/prompts`, post({ body: 'Wrong role', durationSeconds: 60 })), { status: 403 });
  await assert.rejects(other.request(`${path}/messages`, post({ body: 'Wrong teacher' })), { status: 404 });
  await teacher.request(`${path}/messages`, post({ body: 'General <script>discussion</script>', student_id: 2 }));
  await student.request(`${path}/messages`, post({ body: 'My discussion' }));
  const prompt = await teacher.request(`${path}/prompts`, post({ body: 'Respond now', durationSeconds: 5 }));
  await student.request(`${path}/prompts/${prompt.id}/respond`, post({ body: 'PRIVATE HTTP SENTINEL', visibility: 'teacher' }));
  await peer.request(`${path}/prompts/${prompt.id}/respond`, post({ body: 'Public peer answer' }));
  const teacherData = await teacher.request(chat);
  const mine = await student.request(chat);
  const peerData = await peer.request(chat);
  assert.ok(JSON.stringify(teacherData).includes('PRIVATE HTTP SENTINEL'));
  assert.ok(JSON.stringify(mine).includes('PRIVATE HTTP SENTINEL'));
  assert.ok(!JSON.stringify(peerData).includes('PRIVATE HTTP SENTINEL'));
  assert.equal(peerData.students, undefined);
  assert.equal(peerData.progress, undefined);
  assert.ok(!JSON.stringify(peerData).includes('student@example.com'));
  assert.equal(peerData.messages[0].sender_role, 'teacher');
  assert.equal(peerData.self.participation_rate, 100);
  const update = once(socket, 'presence:update', { signal: AbortSignal.timeout(4000) }); realtime.publish(session.id); await update;
  assert.ok(!JSON.stringify(packets).includes('PRIVATE HTTP SENTINEL'));
  assert.equal(packets.find(packet => packet.event === 'presence:update').payload.self.participation.participation_rate, 100);
  await assert.rejects(student.request(`${path}/prompts/${prompt.id}/respond`, post({ body: 'Second tab duplicate' })), { status: 409 });
  time += 5000;
  assert.equal((await student.request(chat)).prompts[0].open, false);
  const next = await teacher.request(`${path}/prompts`, post({ body: 'Second question', durationSeconds: 60 }));
  await teacher.request(`${path}/prompts/${next.id}/close`, post());
  await assert.rejects(student.request(`${path}/prompts/${next.id}/respond`, post({ body: 'Too late' })), { status: 409 });
  await teacher.request(`${path}/end`, post());
  const saved = await student.request(chat);
  assert.equal(saved.self.participation_rate, 50);
  time += 600000;
  assert.deepEqual(await student.request(chat), saved);
  await assert.rejects(peer.request(`${path}/messages`, post({ body: 'Ended' })), { status: 409 });
  await teacher.request(path, { method: 'DELETE', body: { confirm: true } });
  await assert.rejects(student.request(chat), { status: 404 });
  assert.equal(runtime.db.prepare('SELECT count(*) AS n FROM participation_responses').get().n, 0);
});

test('classroom write rate limiting is per authenticated account and does not block snapshots', async t => {
  const runtime = createApp({ databasePath: ':memory:', sessionSecret: 'classroom-limiter-secret-at-least-32-characters' });
  const server = http.createServer(runtime.app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); runtime.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const api = createExtensionApi(async (url, options) => {
    const response = await fetch(`${base}${new URL(url).pathname}`, { ...options, headers: { ...options.headers, Cookie: cookie } });
    const saved = response.headers.get('set-cookie'); if (saved) cookie = saved.split(';')[0];
    return response;
  });
  await api.request('/api/auth/register', { method: 'POST', body: { role: 'teacher', name: 'Teacher', email: 't@example.com', password: 'Password123!' } });
  const classroom = (await api.request('/api/classes', { method: 'POST', body: { title: 'Rate limit' } })).class;
  const session = (await api.request(`/api/meet/classes/${classroom.id}/sessions`, { method: 'POST', body: { meetCode: 'abc-defg-hij' } })).session;
  for (let index = 0; index < 60; index++) {
    await api.request(`/api/sessions/${session.id}/messages`, { method: 'POST', body: { body: `Message ${index}` } });
  }
  await assert.rejects(api.request(`/api/sessions/${session.id}/messages`, { method: 'POST', body: { body: 'Limited' } }), { status: 429 });
  assert.equal((await api.request(`/api/sessions/${session.id}/classroom`)).messages.length, 60);
});
