const { test } = require('node:test');
const assert = require('node:assert/strict');
const { unzipSync, strFromU8 } = require('fflate');
const { reportDocument, DOCUMENT_TYPE } = require('../lib/report-document');
const { openDatabase } = require('../lib/database');
const { PresenceService } = require('../lib/presence');
const { ReportService } = require('../lib/reports');

function report(overrides = {}) {
  return { session: { id: 42, source: 'meet', status: 'ended', meet_code: 'abc-defg-hij', class_title: 'Computing & <Science>', started_at: 1000000, ended_at: 2000000 },
    viewer: { role: 'student', id: 1 }, completion_label: 'Completed', measurement_label: 'Browser-reported Google Meet call time',
    notice: 'Final Offline status means the session is closed, not that the student left early. Rates are not attention. Unverifiable time is excluded.',
    self: { student_id: 1, name: 'Student & <Name> 😀\u0000\u0001', email: 'student@example.com', status: 'Offline',
      active_seconds: 5400, total_seconds: 7200, excluded_seconds: 60, activity_rate: 75,
      participation: { responded_count: 3, eligible_count: 4, participation_rate: 75, classification: 'Moderately Active' } }, ...overrides };
}

test('student DOCX is a genuine OOXML archive with escaped personal summary fields and no active content', async () => {
  const buffer = await reportDocument(report());
  assert.equal(buffer.subarray(0, 2).toString(), 'PK');
  assert.equal(DOCUMENT_TYPE, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  const archive = unzipSync(buffer);
  assert.ok(archive['[Content_Types].xml']);
  const xml = strFromU8(archive['word/document.xml']);
  for (const value of ['Alisto', 'Session Report', 'Computing &amp; &lt;Science&gt;', 'Student &amp; &lt;Name&gt; 😀',
    'student@example.com', 'abc-defg-hij', 'Completed', '1:30:00', '2:00:00', '0:01:00', '75.00%',
    'Responded prompts', 'Eligible prompts', 'Moderately Active', '1970-01-01T00:16:40.000Z',
    '1970-01-01T00:33:20.000Z', 'not that the student left early']) assert.ok(xml.includes(value), value);
  assert.ok(!xml.includes('\u0000')); assert.ok(!xml.includes('\u0001'));
  assert.ok(!xml.includes('<Name>'));
  assert.ok(!Object.keys(archive).some(name => /vbaProject|embeddings|activeX/.test(name)));
  const relationships = Object.entries(archive).filter(([name]) => name.endsWith('.rels')).map(([, data]) => strFromU8(data)).join('');
  assert.ok(!relationships.includes('TargetMode="External"'));
});

test('DOCX reports keep N/A, legacy source labels, and interruption cutoffs explicit', async () => {
  const value = report();
  value.session.source = 'website'; value.session.status = 'interrupted';
  value.completion_label = 'Ended due to interruption'; value.measurement_label = 'Legacy Alisto connection time (not Meet call time)';
  value.self.activity_rate = null; value.self.active_seconds = 0; value.self.total_seconds = 0;
  value.self.participation = { responded_count: 0, eligible_count: 0, participation_rate: null, classification: 'Not yet applicable' };
  const xml = strFromU8(unzipSync(await reportDocument(value))['word/document.xml']);
  for (const text of ['Ended due to interruption', 'Legacy Alisto connection time', 'Connected after grace', 'N/A (legacy connection measurement)', 'Not yet applicable', '0:00:00']) assert.ok(xml.includes(text), text);
  assert.ok(!xml.includes('Google Meet code'));
  assert.ok(!xml.includes('NaN')); assert.ok(!xml.includes('0.00%'));
});

test('DOCX renderer refuses teacher, peer, full-class, and live report objects', async () => {
  for (const value of [report({ viewer: { role: 'teacher', id: 1 } }), report({ viewer: { role: 'student', id: 2 } }),
    report({ students: [] }), report({ session: { ...report().session, status: 'live' } })]) {
    await assert.rejects(reportDocument(value), { status: 403 });
  }
});

test('DOCX reads finalized Meet totals without changing counters or including chat/private responses', async t => {
  const db = openDatabase(':memory:'); t.after(() => db.close());
  db.exec(`INSERT INTO teachers (id,name,email,password_hash) VALUES (1,'Teacher','t@example.com','hash');
    INSERT INTO students (id,name,email,password_hash) VALUES (1,'Student','s@example.com','hash'),(2,'Peer','peer@example.com','hash');
    INSERT INTO classes (id,teacher_id,title,code) VALUES (1,1,'Class','ABC234');`);
  let now = 1000000; const presence = new PresenceService(db, { now: () => now });
  const reports = new ReportService(presence); const student = { role: 'student', id: 1 }; const teacher = { role: 'teacher', id: 1 };
  const id = presence.meet.start(1, 1, 'abc-defg-hij');
  const source = { meetCode: 'abc-defg-hij', sourceId: 'document_profile_12345678', state: 'in' };
  for (const studentId of [1, 2]) {
    presence.meet.enroll(id, studentId, source.meetCode, source.sourceId, () => presence.checkpoint(id));
    presence.meet.observe(id, studentId, source, () => presence.checkpoint(id));
  }
  const prompt = presence.classroom.openPrompt(id, teacher, { body: 'PROMPT SECRET', durationSeconds: 60 });
  presence.classroom.respond(id, student, prompt.id, { body: 'MY RESPONSE SECRET', visibility: 'teacher' });
  presence.classroom.respond(id, { role: 'student', id: 2 }, prompt.id, { body: 'PEER RESPONSE SECRET', visibility: 'teacher' });
  presence.classroom.postMessage(id, teacher, 'CHAT SECRET');
  now += 20000; presence.end(id, 1);
  const before = reports.get(id, student); const changes = db.prepare('SELECT total_changes() AS n').get().n;
  const xml = strFromU8(unzipSync(await reportDocument(before))['word/document.xml']);
  now += 900000;
  assert.deepEqual(reports.get(id, student), before);
  assert.equal(db.prepare('SELECT total_changes() AS n').get().n, changes);
  for (const secret of ['PROMPT SECRET', 'MY RESPONSE SECRET', 'PEER RESPONSE SECRET', 'CHAT SECRET', 'peer@example.com']) assert.ok(!xml.includes(secret), secret);
  assert.ok(xml.includes('0:00:05')); // Evidence expired after 15 seconds; 5 seconds excluded.
  assert.ok(xml.includes('N/A')); // Grace never completed.
});
