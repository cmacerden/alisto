const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../lib/app');
const { createExtensionApi } = require('../extension/api');

test('extension class deletion is restricted to specific class URLs and sends CSRF with cookies', async () => {
  const calls = [];
  const api = createExtensionApi(async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => url.endsWith('/csrf') ? { csrfToken: 'class-delete-token' } : {} };
  });
  await api.request('/api/classes/12', { method: 'DELETE', body: { confirm: true } });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, 'http://localhost:3000/api/classes/12');
  assert.equal(calls[1].options.method, 'DELETE');
  assert.equal(calls[1].options.credentials, 'include');
  assert.equal(calls[1].options.headers['X-CSRF-Token'], 'class-delete-token');
  for (const path of ['/api/classes', '/api/classes/0', '/api/classes/-1', '/api/classes/12/sessions', '/api/auth/logout']) {
    await assert.rejects(api.request(path, { method: 'DELETE' }), /Unsupported/);
  }
  assert.equal(calls.length, 2);
});

test('extension class deletion preserves role/ownership/CSRF checks and protects live and saved session records', async t => {
  const runtime = createApp({ databasePath: ':memory:', sessionSecret: 'class-delete-extension-secret-at-least-32-characters', enableRateLimit: false });
  const server = http.createServer(runtime.app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); runtime.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  function client() {
    let cookie = '';
    async function send(path, options = {}) {
      const response = await fetch(`${base}${path}`, { ...options, headers: { ...options.headers, Cookie: cookie } });
      const saved = response.headers.get('set-cookie'); if (saved) cookie = saved.split(';')[0];
      return response;
    }
    return { send, api: createExtensionApi((url, options) => send(new URL(url).pathname, options)) };
  }
  const teacher = client(); const other = client(); const student = client();
  for (const [account, role, name] of [[teacher, 'teacher', 'teacher'], [other, 'teacher', 'other'], [student, 'student', 'student']]) {
    await account.api.request('/api/auth/register', { method: 'POST', body: { role, name, email: `${name}@example.com`, password: 'Password123!' } });
  }
  const classroom = (await teacher.api.request('/api/classes', { method: 'POST', body: { title: 'Class to delete' } })).class;
  const target = `/api/classes/${classroom.id}`;
  const options = { method: 'DELETE', body: { confirm: true } };
  await assert.rejects(student.api.request(target, options), { status: 403 });
  await assert.rejects(other.api.request(target, options), { status: 404 });
  assert.equal((await teacher.send(target, { method: 'DELETE' })).status, 403);
  const sessionId = runtime.presence.meet.start(classroom.id, 1, 'abc-defg-hij');
  await assert.rejects(teacher.api.request(target, options), { status: 409 });
  assert.ok((await teacher.api.request('/api/classes')).classes[0].has_sessions);
  runtime.presence.end(sessionId, 1);
  await assert.rejects(teacher.api.request(target, options), { status: 409 });
  assert.equal(runtime.presence.session(sessionId).status, 'ended');
  await teacher.api.request(`/api/sessions/${sessionId}`, { method: 'DELETE', body: { confirm: true } });
  assert.equal((await teacher.api.request('/api/classes')).classes[0].has_sessions, 0);
  await teacher.api.request(target, options);
  assert.deepEqual((await teacher.api.request('/api/classes')).classes, []);
  await assert.rejects(teacher.api.request(target), { status: 404 });
  assert.equal(runtime.db.prepare('SELECT count(*) AS n FROM teachers').get().n, 2);
  assert.equal(runtime.db.prepare('SELECT count(*) AS n FROM students').get().n, 1);
  assert.equal((await teacher.api.request('/api/auth/me')).user.role, 'teacher');
});
