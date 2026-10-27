const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const bcrypt = require('bcryptjs');
const { createApp } = require('../lib/app');
const { createExtensionApi } = require('../extension/api');
const { RequestError } = require('../lib/request-error');

async function fixture(t, { limited = false } = {}) {
  const sent = []; let send = async () => ({ mode: 'preview', message: 'Preview only — not delivered.', preview_url: 'https://ethereal.email/message/test' });
  const runtime = createApp({ databasePath: ':memory:', sessionSecret: 'reports-http-secret-at-least-32-characters', enableRateLimit: limited,
    reportMailer: { async send(...args) { sent.push(args); return send(...args); } } });
  const hash = bcrypt.hashSync('Password123!', 4);
  for (const [table, accounts] of [['teachers', ['teacher', 'other']], ['students', ['student', 'peer', 'stranger']]]) {
    accounts.forEach((name, index) => runtime.db.prepare(`INSERT INTO ${table} (id,name,email,password_hash) VALUES (?,?,?,?)`).run(index + 1, name, `${name}@example.com`, hash));
  }
  runtime.db.exec("INSERT INTO classes (id,teacher_id,title,code) VALUES (1,1,'Report Class','ABC234')");
  const id = runtime.presence.start(1, 1).id;
  runtime.presence.connect(id, 1, 'tab-1'); runtime.presence.connect(id, 2, 'tab-2');
  const prompt = runtime.presence.classroom.openPrompt(id, { id: 1, role: 'teacher' }, { body: 'Question', durationSeconds: 60 });
  runtime.presence.classroom.respond(id, { id: 2, role: 'student' }, prompt.id, { body: 'PRIVATE PEER SENTINEL', visibility: 'teacher' });
  runtime.presence.end(id, 1);
  const server = http.createServer(runtime.app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); runtime.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function client(role, email) {
    let cookie = '';
    const raw = async (path, options = {}) => {
      const response = await fetch(`${base}${path}`, { ...options, headers: { ...options.headers, Cookie: cookie } });
      const saved = response.headers.get('set-cookie'); if (saved) cookie = saved.split(';')[0];
      return response;
    };
    const api = createExtensionApi((url, options) => raw(new URL(url).pathname, options));
    if (role) await api.request('/api/auth/login', { method: 'POST', body: { role, email, password: 'Password123!' } });
    return { ...api, raw };
  }
  return { runtime, id, sent, client, handle(fn) { send = fn; } };
}

test('report/CSV HTTP enforces ownership, own-only exports, source labeling, filenames, and no-store', async t => {
  const f = await fixture(t);
  const teacher = await f.client('teacher', 'teacher@example.com');
  const other = await f.client('teacher', 'other@example.com');
  const student = await f.client('student', 'student@example.com');
  const stranger = await f.client('student', 'stranger@example.com');
  const anon = await f.client();
  for (const path of [`/api/sessions/${f.id}/report`, `/api/sessions/${f.id}/report.csv`]) {
    assert.equal((await anon.raw(path)).status, 401);
    await assert.rejects(other.request(path), { status: 404 });
    await assert.rejects(stranger.request(path), { status: 404 });
  }
  const report = await teacher.request(`/api/sessions/${f.id}/report`);
  assert.equal(report.students.length, 2);
  assert.equal(report.completion_label, 'Completed');
  const mine = await student.request(`/api/sessions/${f.id}/report`);
  assert.equal(mine.students, undefined);
  assert.equal(mine.self.email, 'student@example.com');
  assert.ok(!JSON.stringify(mine).includes('peer@example.com'));
  assert.ok(!JSON.stringify(mine).includes('PRIVATE PEER SENTINEL'));
  const csv = await student.request(`/api/sessions/${f.id}/report.csv`);
  assert.equal(csv.viewer, 'student:1');
  assert.ok(!csv.csv.includes('peer@example.com'));
  assert.ok(csv.csv.includes('Legacy Alisto connection time'));
  const raw = await teacher.raw(`/api/sessions/${f.id}/report.csv`);
  assert.equal(raw.headers.get('Cache-Control'), 'no-store');
  assert.equal(raw.headers.get('Content-Disposition'), `attachment; filename="alisto-session-${f.id}-class.csv"`);
  const fullCsv = await raw.text();
  assert.ok(fullCsv.includes('peer@example.com'));
  assert.ok(!fullCsv.includes('PRIVATE PEER SENTINEL'));
  const live = f.runtime.presence.start(1, 1).id;
  await assert.rejects(teacher.request(`/api/sessions/${live}/report`), { status: 409 });
  await assert.rejects(teacher.request(`/api/sessions/${live}/report.csv`), { status: 409 });
  const response = await teacher.raw('/api/sessions/0/report'); assert.equal(response.status, 400);
});

test('report email requires student ownership and CSRF, ignores supplied recipient, and excludes peer content', async t => {
  const f = await fixture(t);
  const student = await f.client('student', 'student@example.com');
  const teacher = await f.client('teacher', 'teacher@example.com');
  const stranger = await f.client('student', 'stranger@example.com');
  const path = `/api/sessions/${f.id}/report/email`;
  const post = { method: 'POST', body: { to: 'attacker@example.com', student_id: 2 } };
  assert.equal((await student.raw(path, { method: 'POST' })).status, 403);
  await assert.rejects(teacher.request(path, post), { status: 403 });
  await assert.rejects(stranger.request(path, post), { status: 404 });
  const result = await student.request(path, post);
  assert.equal(result.mode, 'preview'); assert.match(result.message, /not delivered/);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0][0].self.email, 'student@example.com');
  assert.ok(!JSON.stringify(f.sent[0]).includes('peer@example.com'));
  assert.ok(!JSON.stringify(f.sent[0]).includes('PRIVATE PEER SENTINEL'));
  assert.equal(f.sent[0][2], `alisto-session-${f.id}-student-1.csv`);
  await teacher.request(`/api/sessions/${f.id}`, { method: 'DELETE', body: { confirm: true } });
  await assert.rejects(student.request(path, post), { status: 404 });
  assert.equal(f.sent.length, 1);
});

test('email permits only one in-flight request per student and releases the guard on failure', async t => {
  const f = await fixture(t); const student = await f.client('student', 'student@example.com');
  const path = `/api/sessions/${f.id}/report/email`;
  let finish, started;
  const ready = new Promise(resolve => { started = resolve; });
  f.handle(() => new Promise(resolve => { finish = resolve; started(); }));
  const pending = student.request(path, { method: 'POST' });
  await ready;
  await assert.rejects(student.request(path, { method: 'POST' }), { status: 409 });
  finish({ mode: 'smtp', message: 'Accepted by SMTP.' });
  assert.equal((await pending).mode, 'smtp');
  f.handle(() => { throw new RequestError(502, 'Report email could not be confirmed.'); });
  await assert.rejects(student.request(path, { method: 'POST' }), { status: 502, message: 'Report email could not be confirmed.' });
  f.handle(() => ({ mode: 'preview', message: 'Preview only' }));
  assert.equal((await student.request(path, { method: 'POST' })).mode, 'preview');
});

test('report email is rate limited per account while reading/exporting reports remains available', async t => {
  const f = await fixture(t, { limited: true }); const student = await f.client('student', 'student@example.com');
  const peer = await f.client('student', 'peer@example.com'); const path = `/api/sessions/${f.id}/report`;
  for (let n = 0; n < 5; n++) await student.request(`${path}/email`, { method: 'POST' });
  await assert.rejects(student.request(`${path}/email`, { method: 'POST' }), { status: 429 });
  assert.equal((await student.request(path)).self.email, 'student@example.com');
  assert.ok((await student.request(`${path}.csv`)).csv);
  assert.equal((await peer.request(`${path}/email`, { method: 'POST' })).mode, 'preview');
});

test('extension report allowlist rejects wrong methods/extra paths and validates CSV content type', async () => {
  let calls = 0;
  const api = createExtensionApi(async () => { calls++; return { ok: true, headers: new Headers({ 'Content-Type': 'text/html' }) }; });
  for (const [path, method] of [['/api/sessions/1/report', 'POST'], ['/api/sessions/1/report.csv', 'POST'],
    ['/api/sessions/1/report/email', 'GET'], ['/api/sessions/1/report?student=2', 'GET'], ['/api/sessions/1/report/2', 'GET']]) {
    await assert.rejects(api.request(path, { method }), /Unsupported/);
  }
  assert.equal(calls, 0);
  await assert.rejects(api.request('/api/sessions/1/report.csv'), /invalid CSV/);
  const failed = createExtensionApi(async () => { throw new Error('private connection details'); });
  await assert.rejects(failed.request('/api/sessions/1/report/email', { method: 'POST' }), /Cannot reach/);
});

test('student DOCX HTTP preserves login, role/ownership, binary content, and deleted/live session boundaries', async t => {
  const f = await fixture(t);
  const student = await f.client('student', 'student@example.com');
  const peer = await f.client('student', 'peer@example.com');
  const teacher = await f.client('teacher', 'teacher@example.com');
  const stranger = await f.client('student', 'stranger@example.com'); const anon = await f.client();
  const path = `/api/sessions/${f.id}/report.docx`;
  assert.equal((await anon.raw(path)).status, 401);
  await assert.rejects(teacher.request(path), { status: 403 });
  await assert.rejects(stranger.request(path), { status: 404 });
  const raw = await student.raw(path);
  assert.equal(raw.headers.get('Cache-Control'), 'no-store');
  assert.equal(raw.headers.get('Content-Disposition'), `attachment; filename="alisto-session-${f.id}-student-1.docx"`);
  assert.equal(raw.headers.get('Content-Type'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  const result = await student.request(path); assert.equal(result.viewer, 'student:1');
  const { unzipSync, strFromU8 } = require('fflate');
  const xml = strFromU8(unzipSync(new Uint8Array(result.document))['word/document.xml']);
  assert.ok(xml.includes('student@example.com'));
  assert.ok(!xml.includes('peer@example.com')); assert.ok(!xml.includes('PRIVATE PEER SENTINEL'));
  const peerResult = await peer.request(path); assert.equal(peerResult.viewer, 'student:2');
  const peerXml = strFromU8(unzipSync(new Uint8Array(peerResult.document))['word/document.xml']);
  assert.ok(peerXml.includes('peer@example.com')); assert.ok(!peerXml.includes('student@example.com'));
  assert.equal((await student.raw(path, { method: 'POST', headers: { 'X-CSRF-Token': (await student.request('/api/auth/csrf')).csrfToken } })).status, 404);
  const live = f.runtime.presence.start(1, 1).id; f.runtime.presence.connect(live, 1, 'live-tab');
  await assert.rejects(student.request(`/api/sessions/${live}/report.docx`), { status: 409 });
  await teacher.request(`/api/sessions/${f.id}`, { method: 'DELETE', body: { confirm: true } });
  await assert.rejects(student.request(path), { status: 404 });
  assert.equal(f.sent.length, 0);
});

test('extension DOCX allowlist rejects wrong methods, arbitrary paths and non-document responses', async () => {
  let calls = 0;
  const api = createExtensionApi(async () => { calls++; return { ok: true, headers: new Headers({ 'Content-Type': 'text/html' }) }; });
  for (const [path, method] of [['/api/sessions/1/report.docx', 'POST'], ['/api/sessions/1/report.docx', 'DELETE'],
    ['/api/sessions/1/report.docx?student=2', 'GET'], ['/api/sessions/1/report.docx/2', 'GET']]) {
    await assert.rejects(api.request(path, { method }), /Unsupported/);
  }
  assert.equal(calls, 0);
  await assert.rejects(api.request('/api/sessions/1/report.docx'), /invalid document/);
});

test('expired student login blocks every saved-report format while another account retains only its own record', async t => {
  const f = await fixture(t);
  const student = await f.client('student', 'student@example.com');
  const peer = await f.client('student', 'peer@example.com');
  f.runtime.db.prepare(`UPDATE login_sessions SET expires_at = 0
    WHERE json_extract(data, '$.user.role') = 'student' AND json_extract(data, '$.user.id') = 1`).run();
  const path = `/api/sessions/${f.id}`;
  for (const suffix of ['report', 'report.csv', 'report.docx', 'classroom']) {
    await assert.rejects(student.request(`${path}/${suffix}`), { status: 401 });
  }
  await assert.rejects(student.request(`${path}/report/email`, { method: 'POST' }), { status: 401 });
  const own = await peer.request(`${path}/report`);
  assert.equal(own.self.student_id, 2);
  assert.equal(own.students, undefined);
  assert.ok(!JSON.stringify(own).includes('student@example.com'));
  assert.equal(f.sent.length, 0);
});
