const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const bcrypt = require('bcryptjs');
const { createApp } = require('../lib/app');
const { createExtensionApi } = require('../extension/api');
const { unzipSync, strFromU8 } = require('fflate');

test('Meet HTTP reconnect/outage/multiple-source lifecycle keeps exact timing and race-safe saved exports', async t => {
  let at = 1_000_000;
  let emails = 0;
  const runtime = createApp({ databasePath: ':memory:', sessionSecret: 'phase5-meet-reliability-secret-at-least-32-characters',
    enableRateLimit: false, now: () => at, reportMailer: { send() { emails++; throw new Error('No mail during reliability checks.'); } } });
  const hash = bcrypt.hashSync('FixturePassword123!', 4);
  runtime.db.prepare('INSERT INTO teachers(id,name,email,password_hash) VALUES(1,?,?,?)').run('Teacher', 'teacher@example.com', hash);
  for (const [id, name] of [[1, 'Student'], [2, 'Peer']]) runtime.db.prepare('INSERT INTO students(id,name,email,password_hash) VALUES(?,?,?,?)').run(id, name, `${name.toLowerCase()}@example.com`, hash);
  runtime.db.exec("INSERT INTO classes(id,teacher_id,title,code) VALUES(1,1,'Reliability class','ABC234')");
  const server = http.createServer(runtime.app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); runtime.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = () => {
    let cookie = '';
    return createExtensionApi(async (url, options) => {
      const response = await fetch(base + new URL(url).pathname, { ...options, headers: { ...options.headers, Cookie: cookie } });
      const saved = response.headers.get('set-cookie'); if (saved) cookie = saved.split(';')[0];
      return response;
    });
  };
  const teacher = client(), student = client(), peer = client();
  for (const [account, role, email] of [[teacher, 'teacher', 'teacher@example.com'], [student, 'student', 'student@example.com'], [peer, 'student', 'peer@example.com']]) {
    await account.request('/api/auth/login', { method: 'POST', body: { role, email, password: 'FixturePassword123!' } });
  }
  const post = body => ({ method: 'POST', body });
  const { session } = await teacher.request('/api/meet/classes/1/sessions', post({ meetCode: 'abc-defg-hij' }));
  const prefix = `/api/sessions/${session.id}`, meet = `/api/meet/sessions/${session.id}`;
  const source = name => ({ meetCode: 'abc-defg-hij', sourceId: `phase5_source_${name}_12345678` });
  const observe = (account, name, state) => account.request(`${meet}/observe`, post({ ...source(name), state }));
  const seconds = value => { at = 1_000_000 + value * 1000; };
  for (const name of ['A', 'B']) { await student.request(`${meet}/join`, post(source(name))); await observe(student, name, 'in'); }
  await peer.request(`${meet}/join`, post(source('peer'))); // URL alone is not eligibility.
  const first = await teacher.request(`${prefix}/prompts`, post({ body: 'First required prompt', durationSeconds: 60 }));
  seconds(5);
  const duplicates = await Promise.allSettled([
    student.request(`${prefix}/prompts/${first.id}/respond`, post({ body: 'PRIVATE RESPONSE A', visibility: 'teacher' })),
    student.request(`${prefix}/prompts/${first.id}/respond`, post({ body: 'PRIVATE RESPONSE B', visibility: 'teacher' }))
  ]);
  assert.equal(duplicates.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(duplicates.find(result => result.status === 'rejected').reason.status, 409);
  for (let value = 5; value <= 30; value += 5) { seconds(value); await observe(student, 'A', 'in'); await observe(student, 'B', 'in'); }
  await teacher.request(`${prefix}/prompts/${first.id}/close`, post());
  await observe(student, 'A', 'out');
  assert.equal((await observe(student, 'B', 'unknown')).self.measurement_started_at, null);
  for (let value = 35; value <= 105; value += 5) { seconds(value); await observe(student, 'B', 'in'); }
  let self = (await student.request(prefix)).self;
  const started = 1_095_000;
  assert.equal(self.measurement_started_at, started);
  assert.equal(self.active_seconds, 10); assert.equal(self.total_seconds, 10);
  assert.equal(self.excluded_seconds, 5); // Unknown from second 30 to 35, during grace.
  await observe(student, 'A', 'out');
  seconds(110); await observe(student, 'B', 'out');
  seconds(115); self = (await student.request(prefix)).self;
  assert.equal(self.status, 'Offline'); assert.equal(self.active_seconds, 15); assert.equal(self.total_seconds, 20);
  await observe(student, 'A', 'unknown');
  const second = await teacher.request(`${prefix}/prompts`, post({ body: 'Eligible while unknown', durationSeconds: 60 }));
  seconds(125); self = (await observe(student, 'B', 'in')).self;
  assert.equal(self.measurement_started_at, started); assert.equal(self.grace_remaining_ms, null);
  assert.equal(self.excluded_seconds, 15); // Grace uncertainty plus later 10-second outage.
  assert.equal(self.status, 'Active'); // Fresh in-call source wins over unknown sibling.
  await observe(peer, 'peer', 'in');
  await assert.rejects(peer.request(`${prefix}/prompts/${second.id}/respond`, post({ body: 'Joined after posting' })), { status: 403 });
  const peerChat = await peer.request(`${prefix}/classroom`);
  assert.equal(peerChat.self.eligible_count, 0);
  assert.ok(!JSON.stringify(peerChat).includes('PRIVATE RESPONSE'));
  assert.equal(peerChat.progress, undefined);
  seconds(130); await observe(student, 'A', 'in');
  seconds(135);
  const [response, end] = await Promise.allSettled([
    student.request(`${prefix}/prompts/${second.id}/respond`, post({ body: 'RACE RESPONSE', visibility: 'teacher' })),
    teacher.request(`${prefix}/end`, post())
  ]);
  assert.equal(end.status, 'fulfilled');
  if (response.status === 'rejected') assert.equal(response.reason.status, 409);
  const report = await student.request(`${prefix}/report`);
  assert.equal(report.self.measurement_started_at, started);
  assert.equal(report.self.active_seconds, 25); assert.equal(report.self.total_seconds, 30);
  assert.equal(report.self.excluded_seconds, 15);
  assert.ok(Math.abs(report.self.activity_rate - 25 / 30 * 100) < 1e-10);
  assert.equal(report.self.participation.eligible_count, 2);
  assert.equal(report.self.participation.responded_count, response.status === 'fulfilled' ? 2 : 1);
  assert.equal((await peer.request(`${prefix}/report`)).self.participation.participation_rate, null);
  const csv = await student.request(`${prefix}/report.csv`);
  const doc = await student.request(`${prefix}/report.docx`);
  const xml = strFromU8(unzipSync(new Uint8Array(doc.document))['word/document.xml']);
  assert.ok(xml.includes('0:00:25')); assert.ok(xml.includes('0:00:30')); assert.ok(xml.includes('0:00:15'));
  for (const output of [JSON.stringify(report), csv.csv, xml]) {
    assert.ok(!output.includes('PRIVATE RESPONSE')); assert.ok(!output.includes('RACE RESPONSE'));
    assert.ok(!output.includes('peer@example.com'));
  }
  seconds(3600); assert.deepEqual(await student.request(`${prefix}/report`), report);
  assert.equal((await student.request(`${prefix}/report.csv`)).csv, csv.csv);
  await assert.rejects(observe(student, 'A', 'in'), { status: 409 });
  assert.deepEqual(runtime.db.pragma('foreign_key_check'), []);
  assert.equal(emails, 0);
});
