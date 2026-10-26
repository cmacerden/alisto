const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../lib/app');

const secret = 'test-only-secret-at-least-32-characters-long';

test('Phase 1 foundation', async t => {
  const tempRoot = process.platform === 'win32' && process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : os.tmpdir();
  fs.mkdirSync(tempRoot, { recursive: true });
  const directory = fs.mkdtempSync(path.join(tempRoot, 'alisto-test-'));
  const databasePath = path.join(directory, 'test.sqlite');
  let runtime;
  let server;
  let base;

  async function start(enableRateLimit = false) {
    runtime = createApp({ databasePath, sessionSecret: secret, enableRateLimit });
    server = await new Promise(resolve => {
      const listening = runtime.app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() {
    if (server) {
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      server = null;
    }
    if (runtime) { runtime.close(); runtime = null; }
  }
  t.after(async () => {
    await stop();
    // Remove only the temporary test directory created by this test.
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await start();

  function client() {
    return {
      cookie: '', token: '',
      async request(url, { method = 'GET', body, csrf = true } = {}) {
        const response = await fetch(`${base}${url}`, {
          method, redirect: 'manual', headers: {
            ...(this.cookie ? { Cookie: this.cookie } : {}),
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            ...(csrf && this.token ? { 'X-CSRF-Token': this.token } : {})
          }, body: body !== undefined ? JSON.stringify(body) : undefined
        });
        const cookie = response.headers.get('set-cookie');
        if (cookie) this.cookie = cookie.split(';')[0];
        const text = await response.text();
        const data = response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text;
        if (data.csrfToken) this.token = data.csrfToken;
        return { status: response.status, data, headers: response.headers };
      },
      async register(role, email, name = 'Test User') {
        await this.request('/api/auth/csrf');
        return this.request('/api/auth/register', { method: 'POST', body: { role, email, name, password: 'SafePassword123!' } });
      }
    };
  }

  const teacher = client();
  const otherTeacher = client();
  const student = client();
  let classroom;

  await t.test('public pages and security headers are served', async () => {
    for (const url of ['/', '/auth.html?role=student', '/css/styles.css', '/js/common.js']) {
      const result = await client().request(url);
      assert.equal(result.status, 200);
      assert.ok(result.headers.get('content-security-policy'));
      assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
    }
  });

  await t.test('anonymous API and dashboard access are blocked', async () => {
    const anonymous = client();
    assert.equal((await anonymous.request('/api/auth/me')).status, 401);
    assert.equal((await anonymous.request('/api/classes')).status, 401);
    const page = await anonymous.request('/teacher.html');
    assert.equal(page.status, 302);
    assert.equal(page.headers.get('location'), '/auth.html?role=teacher');
  });

  await t.test('CSRF is required, including before login and registration', async () => {
    const anonymous = client();
    assert.equal((await anonymous.request('/api/auth/login', { method: 'POST', body: {} })).status, 403);
    await anonymous.request('/api/auth/csrf');
    anonymous.token = 'é'.repeat(64);
    assert.equal((await anonymous.request('/api/auth/register', { method: 'POST', body: {} })).status, 403);
  });

  await t.test('invalid role, missing fields, and oversized passwords are rejected', async () => {
    const anonymous = client();
    await anonymous.request('/api/auth/csrf');
    const valid = { role: 'teacher', name: 'Test', email: 'test@example.com', password: 'SafePassword123!' };
    for (const override of [
      { role: 'admin' }, { role: '__proto__' }, { name: ' ' }, { email: 'invalid' },
      { password: 'short' }, { password: 'é'.repeat(37) }
    ]) {
      assert.equal((await anonymous.request('/api/auth/register', { method: 'POST', body: { ...valid, ...override } })).status, 400);
    }
  });

  await t.test('teacher registration hashes passwords and rotates session identifiers', async () => {
    await teacher.request('/api/auth/csrf');
    const before = teacher.cookie;
    const result = await teacher.register('teacher', 'Teacher@Example.com', 'Teacher One');
    assert.equal(result.status, 201);
    assert.equal(result.data.user.email, 'teacher@example.com');
    assert.equal(result.data.user.role, 'teacher');
    assert.equal(result.data.user.password_hash, undefined);
    assert.notEqual(teacher.cookie, before);
    const row = runtime.db.prepare('SELECT password_hash FROM teachers WHERE email = ?').get('teacher@example.com');
    assert.match(row.password_hash, /^\$2[aby]\$/);
    assert.notEqual(row.password_hash, 'SafePassword123!');
    assert.match(result.headers.get('set-cookie'), /HttpOnly/i);
    assert.match(result.headers.get('set-cookie'), /SameSite=Lax/i);
    assert.equal((await teacher.request('/api/auth/me')).status, 200);
  });

  await t.test('duplicate email is case-insensitive within a role', async () => {
    const duplicate = client();
    assert.equal((await duplicate.register('teacher', 'TEACHER@example.com')).status, 409);
    assert.equal((await student.register('student', 'teacher@example.com', 'Student One')).status, 201);
    assert.equal((await otherTeacher.register('teacher', 'other@example.com', 'Teacher Two')).status, 201);
  });

  await t.test('wrong credentials do not authenticate', async () => {
    const anonymous = client();
    await anonymous.request('/api/auth/csrf');
    const result = await anonymous.request('/api/auth/login', {
      method: 'POST', body: { role: 'teacher', email: 'teacher@example.com', password: 'IncorrectPassword!' }
    });
    assert.equal(result.status, 401);
    assert.equal((await anonymous.request('/api/auth/me')).status, 401);
  });

  await t.test('teachers create permanent six-character codes', async () => {
    const result = await teacher.request('/api/classes', { method: 'POST', body: { title: '  Computing 101  ' } });
    assert.equal(result.status, 201);
    classroom = result.data.class;
    assert.equal(classroom.title, 'Computing 101');
    assert.match(classroom.code, /^[A-HJ-NP-Z2-9]{6}$/);
    const repeated = await teacher.request(`/api/classes/${classroom.id}`);
    assert.equal(repeated.data.class.code, classroom.code);
    assert.equal((await teacher.request('/api/classes')).data.classes.length, 1);
    assert.equal((await teacher.request('/api/classes', { method: 'POST', body: { title: ' ' } })).status, 400);
  });

  await t.test('class ownership is enforced for lists and individual resources', async () => {
    assert.deepEqual((await otherTeacher.request('/api/classes')).data.classes, []);
    assert.equal((await otherTeacher.request(`/api/classes/${classroom.id}`)).status, 404);
    assert.equal((await teacher.request('/api/classes/9999')).status, 404);
    assert.equal(runtime.db.pragma('foreign_keys', { simple: true }), 1);
  });

  await t.test('students cannot access teacher actions or dashboard', async () => {
    assert.equal((await student.request('/api/classes')).status, 403);
    assert.equal((await student.request('/api/classes', { method: 'POST', body: { title: 'Forbidden' } })).status, 403);
    const result = await student.request('/teacher.html');
    assert.equal(result.status, 302);
    assert.equal(result.headers.get('location'), '/student.html');
    assert.equal((await student.request('/student.html')).status, 200);
  });

  await t.test('authenticated writes still require CSRF', async () => {
    assert.equal((await teacher.request('/api/classes', { method: 'POST', csrf: false, body: { title: 'Blocked' } })).status, 403);
    assert.equal((await teacher.request('/api/auth/logout', { method: 'POST', csrf: false })).status, 403);
  });

  await t.test('class deletion requires teacher ownership and CSRF', async () => {
    assert.equal((await client().request(`/api/classes/${classroom.id}`, { method: 'DELETE' })).status, 403);
    const anonymous = client();
    await anonymous.request('/api/auth/csrf');
    assert.equal((await anonymous.request(`/api/classes/${classroom.id}`, { method: 'DELETE' })).status, 401);
    assert.equal((await student.request(`/api/classes/${classroom.id}`, { method: 'DELETE' })).status, 403);
    assert.equal((await otherTeacher.request(`/api/classes/${classroom.id}`, { method: 'DELETE' })).status, 404);
    assert.equal((await teacher.request(`/api/classes/${classroom.id}`, { method: 'DELETE', csrf: false })).status, 403);
    assert.equal((await teacher.request(`/api/classes/${classroom.id}`)).status, 200);
  });

  await t.test('owners can delete classes; deleted and unknown classes return 404', async () => {
    const created = await teacher.request('/api/classes', { method: 'POST', body: { title: 'Temporary class' } });
    const id = created.data.class.id;
    assert.equal((await teacher.request(`/api/classes/${id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await teacher.request(`/api/classes/${id}`)).status, 404);
    assert.equal((await teacher.request('/api/classes')).data.classes.some(item => item.id === id), false);
    assert.equal((await teacher.request(`/api/classes/${id}`, { method: 'DELETE' })).status, 404);
    assert.equal((await teacher.request('/api/classes/9999', { method: 'DELETE' })).status, 404);
  });

  await t.test('deletion never cascades through linked records', async () => {
    const created = await teacher.request('/api/classes', { method: 'POST', body: { title: 'Linked class' } });
    const id = created.data.class.id;
    // Test-only table represents the restrictive references added in later phases.
    runtime.db.exec('CREATE TABLE test_class_references (class_id INTEGER REFERENCES classes(id) ON DELETE RESTRICT)');
    try {
      runtime.db.prepare('INSERT INTO test_class_references (class_id) VALUES (?)').run(id);
      assert.equal((await teacher.request(`/api/classes/${id}`, { method: 'DELETE' })).status, 409);
      assert.equal((await teacher.request(`/api/classes/${id}`)).status, 200);
    } finally {
      runtime.db.exec('DROP TABLE test_class_references');
      assert.equal((await teacher.request(`/api/classes/${id}`, { method: 'DELETE' })).status, 200);
    }
  });

  await t.test('accounts, classes, and login sessions survive app restart', async () => {
    await stop();
    await start();
    assert.equal((await teacher.request('/api/auth/me')).data.user.email, 'teacher@example.com');
    assert.equal((await teacher.request('/api/classes')).data.classes[0].code, classroom.code);
    assert.equal((await student.request('/api/auth/me')).data.user.role, 'student');
  });

  await t.test('logout invalidates the old server-side session', async () => {
    const oldCookie = teacher.cookie;
    assert.equal((await teacher.request('/api/auth/logout', { method: 'POST' })).status, 200);
    assert.equal((await teacher.request('/api/auth/me')).status, 401);
    teacher.cookie = oldCookie;
    assert.equal((await teacher.request('/api/auth/me')).status, 401);
  });

  await t.test('existing users can log in again with normalized email', async () => {
    await teacher.request('/api/auth/csrf');
    const result = await teacher.request('/api/auth/login', {
      method: 'POST', body: { role: 'teacher', email: 'TEACHER@example.com', password: 'SafePassword123!' }
    });
    assert.equal(result.status, 200);
    assert.equal(result.data.user.role, 'teacher');
  });

  await t.test('expired login sessions cannot authenticate', async () => {
    runtime.db.prepare('UPDATE login_sessions SET expires_at = 0').run();
    assert.equal((await student.request('/api/auth/me')).status, 401);
  });

  await t.test('authentication attempts are rate-limited', async () => {
    await stop();
    await start(true);
    const anonymous = client();
    await anonymous.request('/api/auth/csrf');
    for (let index = 0; index < 30; index++) {
      assert.equal((await anonymous.request('/api/auth/login', { method: 'POST', body: {} })).status, 400);
    }
    assert.equal((await anonymous.request('/api/auth/login', { method: 'POST', body: {} })).status, 429);
  });
});
