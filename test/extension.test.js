const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { meetCodeFromUrl, meetCodeFromInput, teacherMeetCode, currentMeetTab } = require('../extension/meet');
const { createExtensionApi } = require('../extension/api');
const { createApp } = require('../lib/app');

const root = path.join(__dirname, '../extension');

test('extension uses Manifest V3, local scripts, and narrowly scoped permissions', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ['sidePanel', 'storage']);
  assert.deepEqual(manifest.host_permissions, ['https://meet.google.com/*', 'http://localhost:3000/*']);
  assert.deepEqual(manifest.content_scripts[0].matches, ['https://meet.google.com/*']);
  assert.equal(manifest.content_scripts[0].all_frames, false);
  for (const file of manifest.content_scripts[0].js) assert.ok(fs.existsSync(path.join(root, file)));
  assert.equal(manifest.externally_connectable, undefined);
  assert.equal(manifest.web_accessible_resources, undefined);
  assert.equal(manifest.action.default_popup, undefined);
  for (const file of [manifest.background.service_worker, manifest.side_panel.default_path]) {
    assert.ok(fs.existsSync(path.join(root, file)));
  }
  const html = fs.readFileSync(path.join(root, 'panel.html'), 'utf8');
  for (const match of html.matchAll(/<script src="([^"]+)"/g)) {
    assert.ok(!match[1].includes(':'));
    assert.ok(fs.existsSync(path.join(root, match[1])));
  }
  assert.ok(!/<script(?! src=)|\son\w+=|<iframe/i.test(html));
  assert.ok(!manifest.content_security_policy.extension_pages.includes('unsafe-'));
});

test('extension toolbar action opens the side panel without opening a website tab', async () => {
  let behavior;
  vm.runInNewContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), {
    importScripts() {}, createExtensionApi: () => ({}),
    chrome: { sidePanel: { setPanelBehavior(value) { behavior = value; return Promise.resolve(); } },
      runtime: { onMessage: { addListener() {} } }, tabs: { onRemoved: { addListener() {} }, onUpdated: { addListener() {} } } }, console
  });
  assert.equal(behavior.openPanelOnActionClick, true);
});

test('Meet room parser accepts canonical meeting URLs without claiming call membership', () => {
  assert.equal(meetCodeFromUrl('https://meet.google.com/abc-defg-hij'), 'abc-defg-hij');
  assert.equal(meetCodeFromUrl('https://meet.google.com/abc-defg-hij/?authuser=1#details'), 'abc-defg-hij');
});

test('Meet room parser rejects non-Meet, lookalike, malformed, and non-room URLs', () => {
  for (const url of [undefined, '', 'abc-defg-hij', 'http://meet.google.com/abc-defg-hij',
    'https://meet.google.com.evil.example/abc-defg-hij', 'https://evil.example/abc-defg-hij',
    'https://meet.google.com@evil.example/abc-defg-hij', 'https://user@meet.google.com/abc-defg-hij',
    'https://meet.google.com:444/abc-defg-hij', 'https://meet.google.com/',
    'https://meet.google.com/new', 'https://meet.google.com/lookup/class',
    'https://meet.google.com/ABC-DEFG-HIJ', 'https://meet.google.com/abc-defg-hij/other']) {
    assert.equal(meetCodeFromUrl(url), null, String(url));
  }
});

test('teacher fallback accepts actual Meet codes and links without changing the strict tab URL parser', () => {
  for (const input of [' abc-defg-hij ', 'ABC-DEFG-HIJ', 'https://meet.google.com/abc-defg-hij?authuser=1', 'meet.google.com/abc-defg-hij']) {
    assert.equal(meetCodeFromInput(input), 'abc-defg-hij');
  }
  assert.equal(meetCodeFromUrl('abc-defg-hij'), null);
});

test('teacher fallback rejects old Alisto codes, unrelated sites, nicknames, and malformed links', () => {
  for (const input of ['', null, 'ABC234', 'my-class', 'https://meet.google.com.evil.example/abc-defg-hij',
    'https://evil.example/abc-defg-hij', 'https://meet.google.com/lookup/class', 'http://meet.google.com/abc-defg-hij',
    'https://user@meet.google.com/abc-defg-hij']) assert.equal(meetCodeFromInput(input), null);
});

test('teacher can select the actual meeting manually when active-tab code detection is unavailable', () => {
  assert.throws(() => teacherMeetCode('', null), /Paste its actual Google Meet link or code/);
  assert.equal(teacherMeetCode('https://meet.google.com/abc-defg-hij', null), 'abc-defg-hij');
  assert.throws(() => teacherMeetCode('ABC234', null), /Enter a Google Meet link or code/);
});

test('teacher fallback refuses conflicting detected rooms instead of silently binding a different call', () => {
  assert.equal(teacherMeetCode('', 'abc-defg-hij'), 'abc-defg-hij');
  assert.equal(teacherMeetCode('abc-defg-hij', 'abc-defg-hij'), 'abc-defg-hij');
  assert.throws(() => teacherMeetCode('xyz-abcd-efg', 'abc-defg-hij'), /does not match/);
});

test('side panel resolves the focused tab when its current window returns no active tab', async () => {
  const calls = [];
  const context = await currentMeetTab({ async query(options) {
    calls.push(options);
    return options.currentWindow ? [] : [{ id: 10, url: 'https://meet.google.com/abc-defg-hij' }];
  } });
  assert.deepEqual(context, { tabId: 10, meetCode: 'abc-defg-hij' });
  assert.deepEqual(calls, [{ active: true, currentWindow: true }, { active: true, lastFocusedWindow: true }]);
});

test('side panel retries focused-window lookup after a current-window API failure', async () => {
  const context = await currentMeetTab({ async query(options) {
    if (options.currentWindow) throw new Error('No window');
    return [{ id: 10, url: 'https://meet.google.com/abc-defg-hij' }];
  } });
  assert.equal(context.meetCode, 'abc-defg-hij');
});

test('side panel does not choose a different room when current tab is not Meet or its URL is withheld', async () => {
  for (const tab of [{ id: 10, url: 'https://example.com' }, { id: 10 }]) {
    let calls = 0;
    const context = await currentMeetTab({ query: async () => { calls++; return [tab]; } });
    assert.deepEqual(context, { tabId: 10, meetCode: null });
    assert.equal(calls, 1);
  }
});

test('extension API sends cookies and CSRF, rotates tokens after authentication, and keeps tokens out of storage', async () => {
  const calls = [];
  const api = createExtensionApi(async (url, options) => {
    calls.push({ url, options });
    const data = url.endsWith('/csrf') ? { csrfToken: 'before-login' }
      : url.endsWith('/login') ? { user: { role: 'student' }, csrfToken: 'after-login' } : {};
    return { ok: true, json: async () => data };
  });
  await api.request('/api/auth/login', { method: 'POST', body: { role: 'student', email: 'student@example.com', password: 'Password123!' } });
  await api.request('/api/classes', { method: 'POST', body: { title: 'Class' } });
  assert.equal(calls.length, 3);
  assert.equal(calls[1].options.headers['X-CSRF-Token'], 'before-login');
  assert.equal(calls[2].options.headers['X-CSRF-Token'], 'after-login');
  assert.equal(calls[1].options.credentials, 'include');
  assert.equal(calls[1].options.redirect, 'error');
  assert.equal(calls[1].options.cache, 'no-store');
  assert.equal(calls[1].options.headers['Content-Type'], 'application/json');
  assert.equal(calls[1].options.signal.aborted, false);
  assert.equal(JSON.parse(calls[1].options.body).role, 'student');
});

test('extension API rejects arbitrary destinations, legacy session joins, and destructive requests', async () => {
  let calls = 0;
  const api = createExtensionApi(() => { calls++; });
  for (const input of ['https://evil.example/api/auth/me', '//evil.example/api/auth/me', '/api/../private',
    '/api/classes/1/sessions', '/api/sessions/0', '/api/sessions/1?extra=yes', '/api/meet/live/ABC234']) {
    await assert.rejects(api.request(input), /Unsupported/);
  }
  await assert.rejects(api.request('/api/classes', { method: 'DELETE' }), /Unsupported/);
  assert.equal(calls, 0);
});

test('extension API reports backend outages and invalid responses without exposing credentials', async () => {
  const unavailable = createExtensionApi(async () => { throw new Error('private error'); });
  await assert.rejects(unavailable.request('/api/auth/me'), /Cannot reach Alisto/);
  const invalid = createExtensionApi(async () => ({ ok: true, json: async () => { throw new Error('not JSON'); } }));
  await assert.rejects(invalid.request('/api/auth/me'), /invalid response/);
  for (const result of [null, [], 'Unexpected response']) {
    const malformed = createExtensionApi(async () => ({ ok: true, json: async () => result }));
    await assert.rejects(malformed.request('/api/auth/me'), /invalid response/);
  }
});

test('extension API invalidates CSRF after expiration and obtains a new token on the next write', async () => {
  const calls = [];
  let expired = true;
  const api = createExtensionApi(async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/csrf')) return { ok: true, json: async () => ({ csrfToken: `token-${calls.length}` }) };
    if (expired) { expired = false; return { ok: false, status: 403, json: async () => ({ error: 'Expired token.' }) }; }
    return { ok: true, json: async () => ({}) };
  });
  await assert.rejects(api.request('/api/classes', { method: 'POST', body: { title: 'Class' } }), { status: 403 });
  await api.request('/api/classes', { method: 'POST', body: { title: 'Class' } });
  assert.equal(calls.filter(call => call.url.endsWith('/csrf')).length, 2);
  assert.equal(calls[3].options.headers['X-CSRF-Token'], 'token-3');
});

test('extension API foundation works with the real backend without starting legacy presence', async t => {
  const runtime = createApp({ databasePath: ':memory:', sessionSecret: 'extension-tests-secret-at-least-32-characters', enableRateLimit: false });
  const server = http.createServer(runtime.app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); runtime.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  function client() {
    let cookie = '';
    // Node has no cookie jar. This test adapter supplies it; Chrome uses the
    // existing HttpOnly session cookie under the manifest's host permission.
    return createExtensionApi(async (url, options) => {
      assert.equal(new URL(url).origin, 'http://localhost:3000');
      const response = await fetch(`${base}${new URL(url).pathname}`, {
        ...options, headers: { ...options.headers, Cookie: cookie }
      });
      const saved = response.headers.get('set-cookie');
      if (saved) cookie = saved.split(';')[0];
      return response;
    });
  }
  const teacher = client(); const student = client(); const other = client();
  await assert.rejects(student.request('/api/auth/me'), { status: 401 });
  for (const [api, role, name] of [[teacher, 'teacher', 'Teacher'], [student, 'student', 'Student'], [other, 'teacher', 'Other']]) {
    const result = await api.request('/api/auth/register', { method: 'POST', body: {
      role, name, email: `${name.toLowerCase()}@example.com`, password: 'Password123!'
    } });
    assert.equal(result.user.role, role);
    assert.equal((await api.request('/api/auth/me')).user.name, name);
  }
  const classroom = (await teacher.request('/api/classes', { method: 'POST', body: { title: '<script>Class</script>' } })).class;
  assert.equal((await teacher.request('/api/classes')).classes[0].title, classroom.title);
  assert.equal((await other.request('/api/classes')).classes.length, 0);
  await assert.rejects(student.request('/api/classes'), { status: 403 });
  assert.equal((await student.request('/api/sessions')).sessions.length, 0);
  assert.equal(runtime.db.prepare('SELECT count(*) AS count FROM sessions').get().count, 0);
  // Seed a legacy saved session via the existing service, not the extension.
  const session = runtime.presence.start(classroom.id, 1);
  runtime.presence.connect(session.id, 1, 'legacy-test');
  runtime.presence.end(session.id, 1);
  assert.equal((await student.request('/api/sessions')).sessions[0].id, session.id);
  const snapshot = await student.request(`/api/sessions/${session.id}`);
  assert.equal(snapshot.session.status, 'ended');
  assert.equal(snapshot.students, undefined);
  assert.equal(snapshot.self.name, 'Student');
  await assert.rejects(other.request(`/api/sessions/${session.id}`), { status: 404 });
  await student.request('/api/auth/logout', { method: 'POST' });
  await assert.rejects(student.request('/api/auth/me'), { status: 401 });
  await student.request('/api/auth/login', { method: 'POST', body: { role: 'student', email: 'student@example.com', password: 'Password123!' } });
  assert.equal((await student.request('/api/auth/me')).user.name, 'Student');
});
