const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { unzipSync, strFromU8 } = require('fflate');
const { createApp } = require('../lib/app');
const { createExtensionApi } = require('../extension/api');

test('abrupt process death rolls back uncommitted timing/response together and serves private recovered reports over HTTP', { timeout: 20000 }, async () => {
  const root = process.platform === 'win32' && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : os.tmpdir();
  fs.mkdirSync(root, { recursive: true });
  const folder = fs.mkdtempSync(path.join(root, 'alisto-phase5-crash-'));
  const filename = path.join(folder, 'crash.sqlite');
  let child, exited, runtime, server; let diagnostics = '';
  try {
    child = fork(path.join(__dirname, '../scripts/fixtures/recovery-child.js'), [], {
      env: { ...process.env, ALISTO_CRASH_TEST_DB: filename }, stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });
    exited = once(child, 'exit');
    child.stderr.on('data', data => { diagnostics += data.toString(); });
    const [state] = await Promise.race([
      once(child, 'message', { signal: AbortSignal.timeout(10000) }),
      exited.then(() => { throw new Error(`Crash fixture exited early: ${diagnostics}`); })
    ]);
    assert.equal(state.type, 'ready');
    child.kill('SIGKILL'); await exited;

    let now = state.cutoff + 900000; // Simulated restart after 15 minutes, no sleeps.
    let emails = 0;
    runtime = createApp({ databasePath: filename, sessionSecret: 'phase5-recovery-fixture-secret-at-least-32-characters',
      enableRateLimit: false, now: () => now, reportMailer: { send() { emails++; throw new Error('No mail during reliability tests.'); } } });
    server = http.createServer(runtime.app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const client = () => {
      let cookie = '';
      return createExtensionApi(async (url, options) => {
        const response = await fetch(base + new URL(url).pathname, { ...options, headers: { ...options.headers, Cookie: cookie } });
        const saved = response.headers.get('set-cookie'); if (saved) cookie = saved.split(';')[0];
        return response;
      });
    };
    const student = createExtensionApi((url, options) => fetch(base + new URL(url).pathname, { ...options, headers: { ...options.headers, Cookie: state.cookie } }));
    const teacher = client(); const peer = client();
    for (const [account, role, email] of [[teacher, 'teacher', 'teacher@example.com'], [peer, 'student', 'peer@example.com']]) {
      await account.request('/api/auth/login', { method: 'POST', body: { role, email, password: 'FixturePassword123!' } });
    }
    const prefix = `/api/sessions/${state.id}`;
    assert.equal((await student.request('/api/auth/me')).user.id, 1); // Login cookie survived the crash.
    const report = await student.request(`${prefix}/report`);
    assert.equal(report.completion_label, 'Ended due to interruption');
    assert.equal(report.session.ended_at, state.cutoff);
    assert.equal(report.self.active_seconds, 10); assert.equal(report.self.total_seconds, 10);
    assert.equal(report.self.excluded_seconds, 0); assert.equal(report.self.activity_rate, 100);
    assert.equal(report.self.participation.eligible_count, 2);
    assert.equal(report.self.participation.responded_count, 1);
    assert.equal(report.self.participation.participation_rate, 50);
    const mine = await student.request(`${prefix}/classroom`); const theirs = await peer.request(`${prefix}/classroom`);
    assert.ok(JSON.stringify(mine).includes('COMMITTED PRIVATE RESPONSE'));
    assert.ok(!JSON.stringify(theirs).includes('COMMITTED PRIVATE RESPONSE'));
    const teacherChat = await teacher.request(`${prefix}/classroom`);
    assert.equal(teacherChat.messages[0].body, 'Committed discussion');
    assert.equal(teacherChat.prompts[1].closed_at, state.cutoff);
    assert.equal(teacherChat.prompts[1].responses.length, 0);
    assert.ok(!JSON.stringify(teacherChat).includes('UNCOMMITTED RESPONSE'));
    assert.equal(theirs.self.responded_count, 0);
    assert.equal(theirs.self.eligible_count, 2);
    const csv = await student.request(`${prefix}/report.csv`);
    const doc = await student.request(`${prefix}/report.docx`);
    const xml = strFromU8(unzipSync(new Uint8Array(doc.document))['word/document.xml']);
    assert.ok(xml.includes('Ended due to interruption')); assert.ok(xml.includes('0:00:10'));
    for (const serialized of [JSON.stringify(report), csv.csv, xml]) {
      assert.ok(!serialized.includes('peer@example.com'));
      assert.ok(!serialized.includes('COMMITTED PRIVATE RESPONSE'));
      assert.ok(!serialized.includes('UNCOMMITTED RESPONSE'));
    }
    now += 3600000;
    assert.deepEqual(await student.request(`${prefix}/report`), report);
    assert.equal((await student.request(`${prefix}/report.csv`)).csv, csv.csv);
    for (const [path, body] of [['messages', { body: 'Too late' }], [`prompts/${state.secondPrompt}/respond`, { body: 'Too late' }]]) {
      await assert.rejects(student.request(`${prefix}/${path}`, { method: 'POST', body }), { status: 409 });
    }
    const newSession = await teacher.request('/api/meet/classes/1/sessions', { method: 'POST', body: { meetCode: 'abc-defg-hij' } });
    assert.ok(newSession.session.id > state.id);
    await assert.rejects(student.request(`/api/meet/sessions/${state.id}/observe`, { method: 'POST', body: {
      meetCode: 'abc-defg-hij', sourceId: 'phase5_recovery_source_123456', state: 'in'
    } }), { status: 409 });
    assert.equal(runtime.db.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(runtime.db.pragma('foreign_key_check'), []);
    assert.equal(emails, 0);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    runtime?.close();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
