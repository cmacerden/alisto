// Phase 5 crash-test fixture. Only an explicit test-owned path is accepted;
// never load .env or fall back to the application database/server port.
const http = require('node:http');
const bcrypt = require('bcryptjs');
const { createApp } = require('../../lib/app');

async function main() {
  if (!process.send || !process.env.ALISTO_CRASH_TEST_DB) throw new Error('Run this fixture through the crash-recovery test only.');
  let at = 1_000_000;
  const runtime = createApp({ databasePath: process.env.ALISTO_CRASH_TEST_DB,
    sessionSecret: 'phase5-recovery-fixture-secret-at-least-32-characters', enableRateLimit: false, now: () => at,
    reportMailer: { send() { throw new Error('Mail is prohibited in the crash fixture.'); } } });
  const hash = bcrypt.hashSync('FixturePassword123!', 4);
  runtime.db.prepare('INSERT INTO teachers(id,name,email,password_hash) VALUES (1,?,?,?)').run('Teacher', 'teacher@example.com', hash);
  for (const [id, name] of [[1, 'Student'], [2, 'Peer']]) {
    runtime.db.prepare('INSERT INTO students(id,name,email,password_hash) VALUES (?,?,?,?)').run(id, name, `${name.toLowerCase()}@example.com`, hash);
  }
  runtime.db.exec("INSERT INTO classes(id,teacher_id,title,code) VALUES(1,1,'Recovery class','ABC234')");
  const presence = runtime.presence; const teacher = { role: 'teacher', id: 1 }; const student = { role: 'student', id: 1 };
  const id = presence.meet.start(1, 1, 'abc-defg-hij');
  const source = { meetCode: 'abc-defg-hij', sourceId: 'phase5_recovery_source_123456', state: 'in' };
  for (const studentId of [1, 2]) presence.meet.enroll(id, studentId, source.meetCode, source.sourceId, () => presence.checkpoint(id));
  for (let seconds = 0; seconds <= 70; seconds += 5) {
    at = 1_000_000 + seconds * 1000;
    for (const studentId of [1, 2]) presence.meet.observe(id, studentId, source, () => presence.checkpoint(id));
  }
  presence.classroom.postMessage(id, teacher, 'Committed discussion');
  const first = presence.classroom.openPrompt(id, teacher, { body: 'First prompt', durationSeconds: 60 });
  presence.classroom.respond(id, student, first.id, { body: 'COMMITTED PRIVATE RESPONSE', visibility: 'teacher' });
  presence.classroom.closePrompt(id, teacher, first.id);
  const second = presence.classroom.openPrompt(id, teacher, { body: 'Open at crash', durationSeconds: 60 });

  const server = http.createServer(runtime.app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  async function request(path, body, token) {
    const response = await fetch(base + path, { method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(5000),
      headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json', 'X-CSRF-Token': token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const saved = response.headers.get('set-cookie'); if (saved) cookie = saved.split(';')[0];
    if (!response.ok) throw new Error(`Fixture authentication failed: ${response.status}`);
    return response.json();
  }
  const csrf = await request('/api/auth/csrf');
  const login = await request('/api/auth/login', { role: 'student', email: 'student@example.com', password: 'FixturePassword123!' }, csrf.csrfToken);
  const cutoff = presence.session(id).checkpoint_at;
  // Leave both the later timing checkpoint and a later response uncommitted.
  // SIGKILL must roll them back together, not preserve partial participation.
  runtime.db.exec('BEGIN IMMEDIATE'); at += 5000;
  presence.classroom.respond(id, { role: 'student', id: 2 }, second.id, { body: 'UNCOMMITTED RESPONSE', visibility: 'teacher' });
  process.send({ type: 'ready', id, cutoff, secondPrompt: second.id, cookie, csrfToken: login.csrfToken });
}

main().catch(error => { console.error(error); process.exit(1); });
