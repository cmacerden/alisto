const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../lib/app');
const { createExtensionApi } = require('../extension/api');

test('Meet HTTP lifecycle preserves auth, CSRF, ownership, privacy, and source separation', async t => {
  let time = 1_000_000;
  const runtime = createApp({ databasePath: ':memory:', sessionSecret: 'meet-http-secret-at-least-32-characters', enableRateLimit: false, now: () => time });
  const server = http.createServer(runtime.app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); runtime.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  function client() {
    let cookie = '';
    const send = async (path, options = {}) => {
      const response = await fetch(`${base}${path}`, { ...options, headers: { ...options.headers, Cookie: cookie } });
      const saved = response.headers.get('set-cookie'); if (saved) cookie = saved.split(';')[0];
      return response;
    };
    const api = createExtensionApi((url, options) => send(new URL(url).pathname, options));
    return { ...api, send, async register(role, name) {
      return api.request('/api/auth/register', { method: 'POST', body: { role, name, email: `${name}@example.com`, password: 'Password123!' } });
    } };
  }
  const teacher = client(); const other = client(); const student = client(); const peer = client();
  await teacher.register('teacher', 'teacher'); await other.register('teacher', 'other');
  await student.register('student', 'student'); await peer.register('student', 'peer');
  const classroom = (await teacher.request('/api/classes', { method: 'POST', body: { title: 'Meet classroom' } })).class;
  const start = `/api/meet/classes/${classroom.id}/sessions`;
  const body = { meetCode: 'abc-defg-hij' };
  await assert.rejects(student.request(start, { method: 'POST', body }), { status: 403 });
  await assert.rejects(other.request(start, { method: 'POST', body }), { status: 404 });
  assert.equal((await teacher.send(start, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).status, 403);
  await assert.rejects(teacher.request(start, { method: 'POST', body: { meetCode: classroom.code } }), { status: 400 });
  const session = (await teacher.request(start, { method: 'POST', body })).session;
  await assert.rejects(teacher.request(start, { method: 'POST', body }), { status: 409 });
  assert.equal((await student.request('/api/meet/live/abc-defg-hij')).session.id, session.id);
  assert.equal((await client().send('/api/meet/live/abc-defg-hij')).status, 401);
  await assert.rejects(peer.request(`/api/sessions/${session.id}`), { status: 404 });
  const join = `/api/meet/sessions/${session.id}/join`;
  const observation = `/api/meet/sessions/${session.id}/observe`;
  const source = { meetCode: body.meetCode, sourceId: 'profile_1234567890' };
  await assert.rejects(teacher.request(join, { method: 'POST', body: source }), { status: 403 });
  await assert.rejects(student.request(observation, { method: 'POST', body: { ...source, state: 'in' } }), { status: 404 });
  const joined = await student.request(join, { method: 'POST', body: source });
  assert.equal(joined.self.detection_notice, 'Cannot verify');
  assert.equal(joined.self.status, null);
  assert.equal(joined.students, undefined);
  await assert.rejects(peer.request(observation, { method: 'POST', body: { ...source, state: 'in' } }), { status: 404 });
  await assert.rejects(student.request(observation, { method: 'POST', body: { ...source, meetCode: 'xyz-abcd-efg', state: 'in' } }), { status: 404 });
  for (let index = 0; index <= 14; index++) {
    await student.request(observation, { method: 'POST', body: { ...source, state: 'in', clientTime: 9999999999999, active_ms: 999999 } });
    if (index < 14) time += 5000;
  }
  const mine = await student.request(`/api/sessions/${session.id}`);
  assert.equal(mine.self.active_seconds, 10);
  assert.equal(mine.self.activity_rate, 100);
  assert.equal(mine.self.email, undefined);
  assert.equal(mine.session.code, undefined);
  const roster = await teacher.request(`/api/sessions/${session.id}`);
  assert.equal(roster.students.length, 1);
  assert.equal(roster.students[0].active_seconds, mine.self.active_seconds);
  assert.equal(runtime.db.prepare('SELECT count(*) AS n FROM session_students').get().n, 0);
  assert.equal((await teacher.request('/api/sessions')).sessions[0].source, 'meet');
  await assert.rejects(other.request(`/api/sessions/${session.id}/end`, { method: 'POST' }), { status: 404 });
  await teacher.request(`/api/sessions/${session.id}/end`, { method: 'POST' });
  await assert.rejects(student.request(observation, { method: 'POST', body: { ...source, state: 'in' } }), { status: 409 });
  const saved = await student.request(`/api/sessions/${session.id}`);
  time += 900000;
  assert.deepEqual(await student.request(`/api/sessions/${session.id}`), saved);
  await student.request('/api/auth/logout', { method: 'POST' });
  await assert.rejects(student.request(`/api/sessions/${session.id}`), { status: 401 });
});
