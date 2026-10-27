const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../lib/database');
const { PresenceService } = require('../lib/presence');
const { ReportService, csvCell, duration } = require('../lib/reports');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function fixture(t) {
  const db = openDatabase(':memory:'); t.after(() => db.close());
  db.exec(`INSERT INTO teachers VALUES (1, 'Teacher', 't@example.com', 'hash', 'now'), (2, 'Other', 'o@example.com', 'hash', 'now');
    INSERT INTO students VALUES (1, '=FORMULA(),"Name"', 's@example.com', 'hash', 'now'),
      (2, 'Peer', 'p@example.com', 'hash', 'now'), (3, 'Stranger', 'x@example.com', 'hash', 'now');
    INSERT INTO classes (id,teacher_id,title,code) VALUES (1,1,'Class','ABC234');`);
  let now = 1_000_000;
  const presence = new PresenceService(db, { now: () => now });
  const reports = new ReportService(presence);
  const teacher = { role: 'teacher', id: 1 }; const student = { role: 'student', id: 1 };
  return { db, presence, reports, teacher, student, advance(ms) { now += ms; } };
}

test('final reports preserve exact Meet measurements, uncertainty, eligibility totals, and privacy', t => {
  const f = fixture(t); const { presence: p, reports, teacher, student } = f;
  const id = p.meet.start(1, 1, 'abc-defg-hij');
  const source = { meetCode: 'abc-defg-hij', sourceId: 'profile_report_12345678', state: 'in' };
  for (const studentId of [1, 2]) {
    p.meet.enroll(id, studentId, source.meetCode, source.sourceId, () => p.checkpoint(id));
    p.meet.observe(id, studentId, source, () => p.checkpoint(id));
  }
  const prompt = p.classroom.openPrompt(id, teacher, { body: 'PROMPT CONTENT SECRET', durationSeconds: 60 });
  p.classroom.respond(id, student, prompt.id, { body: 'PRIVATE RESPONSE SECRET', visibility: 'teacher' });
  p.classroom.postMessage(id, teacher, 'CHAT CONTENT SECRET');
  for (let n = 0; n < 7; n++) {
    f.advance(10000); p.meet.observe(id, 1, source, () => p.checkpoint(id));
  }
  p.meet.observe(id, 1, { ...source, state: 'out' }, () => p.checkpoint(id));
  f.advance(5000);
  p.meet.observe(id, 1, { ...source, state: 'unknown' }, () => p.checkpoint(id));
  f.advance(5000); p.end(id, 1);
  const changes = f.db.prepare('SELECT total_changes() AS n').get().n;
  const report = reports.get(id, student);
  assert.equal(report.self.active_seconds, 10);
  assert.equal(report.self.total_seconds, 15);
  assert.equal(report.self.excluded_seconds, 5);
  assert.equal(report.self.activity_rate, 100 * 10 / 15);
  assert.equal(report.self.participation.participation_rate, 100);
  assert.equal(report.self.email, 's@example.com');
  assert.equal(report.self.status, 'Offline');
  assert.equal(report.completion_label, 'Completed');
  assert.equal(report.students, undefined);
  const full = reports.get(id, teacher);
  assert.equal(full.students.length, 2);
  assert.equal(full.students[1].participation.participation_rate, 0);
  const csv = reports.csv(full);
  for (const secret of ['PRIVATE RESPONSE SECRET', 'PROMPT CONTENT SECRET', 'CHAT CONTENT SECRET']) {
    assert.ok(!JSON.stringify(full).includes(secret)); assert.ok(!csv.includes(secret));
  }
  assert.ok(csv.includes('Cannot Verify Excluded Seconds'));
  assert.ok(csv.includes('"\'=FORMULA(),""Name"""'));
  assert.ok(!reports.csv(report).includes('p@example.com'));
  const savedCsv = reports.csv(report); f.advance(900000);
  assert.deepEqual(reports.get(id, student), report);
  assert.equal(reports.csv(reports.get(id, student)), savedCsv);
  assert.equal(f.db.prepare('SELECT total_changes() AS n').get().n, changes);
});

test('reports reject live, unknown, unjoined, and foreign-owned sessions before exporting', t => {
  const f = fixture(t); const id = f.presence.start(1, 1).id;
  assert.throws(() => f.reports.get(id, f.teacher), { status: 409 });
  f.presence.end(id, 1);
  assert.throws(() => f.reports.get(id, f.student), { status: 404 });
  assert.throws(() => f.reports.get(id, { role: 'teacher', id: 2 }), { status: 404 });
  assert.throws(() => f.reports.get(999, f.teacher), { status: 404 });
  assert.equal(f.reports.get(id, f.teacher).students.length, 0);
  assert.equal(f.reports.csv(f.reports.get(id, f.teacher)).split('\r\n').length, 2);
});

test('unverified Meet enrollment has N/A rates and remains eligible for its own saved report', t => {
  const f = fixture(t); const id = f.presence.meet.start(1, 1, 'abc-defg-hij');
  f.presence.meet.enroll(id, 1, 'abc-defg-hij', 'profile_report_12345678', () => f.presence.checkpoint(id));
  f.advance(12000); f.presence.end(id, 1);
  const report = f.reports.get(id, f.student);
  assert.equal(report.self.joined_at, null);
  assert.equal(report.self.activity_rate, null);
  assert.equal(report.self.excluded_seconds, 12);
  assert.equal(report.self.participation.participation_rate, null);
  assert.equal(report.self.participation.classification, 'Not yet applicable');
});

test('legacy and recovered reports retain source meaning and consistent interruption cutoff', t => {
  const f = fixture(t); const p = f.presence; const id = p.start(1, 1).id;
  p.connect(id, 1, 'tab'); f.advance(70000); p.checkpointAll();
  const cutoff = p.session(id).checkpoint_at;
  f.advance(900000);
  const recovered = new PresenceService(f.db, { now: () => cutoff + 900000 });
  const reports = new ReportService(recovered); const report = reports.get(id, f.student);
  assert.equal(report.completion_label, 'Ended due to interruption');
  assert.match(report.measurement_label, /Legacy Alisto connection/);
  assert.equal(report.session.ended_at, cutoff);
  assert.equal(report.self.active_seconds, 10);
  assert.equal(report.self.total_seconds, 10);
  assert.equal(report.self.excluded_seconds, undefined);
  assert.equal(report.self.participation.eligible_count, 0);
  assert.equal(report.self.activity_rate, 100);
  assert.match(reports.csv(report), /N\/A/);
});

test('CSV fields escape delimiters, quotes, line breaks, and spreadsheet formulas including leading whitespace', () => {
  assert.equal(csvCell('a,"b"\nc'), '"a,""b""\nc"');
  for (const value of ['=1+1', '+SUM(A1)', '-1+1', '@SUM(A1)', '  =1', '\t=1', '\rtext', '\ntext', '\u0001=1']) {
    assert.ok(csvCell(value).startsWith('"\''), value);
  }
  assert.equal(csvCell(null), '"N/A"');
  assert.equal(csvCell(0), '"0"');
  assert.equal(duration(5400), '1:30:00');
  assert.equal(duration(90061), '25:01:01');
});

test('finalized reports survive database close/reopen unchanged with schema v5 and no restart downtime', () => {
  const root = process.platform === 'win32' && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : os.tmpdir();
  fs.mkdirSync(root, { recursive: true });
  const folder = fs.mkdtempSync(path.join(root, 'alisto-reports-'));
  const filename = path.join(folder, 'reports.sqlite');
  let db;
  try {
    db = openDatabase(filename);
    db.exec(`INSERT INTO teachers (id,name,email,password_hash) VALUES (1,'Teacher','t@example.com','hash');
      INSERT INTO students (id,name,email,password_hash) VALUES (1,'Student','s@example.com','hash');
      INSERT INTO classes (id,teacher_id,title,code) VALUES (1,1,'Class','ABC234');`);
    let at = 1000000;
    let presence = new PresenceService(db, { now: () => at });
    const id = presence.start(1, 1).id; presence.connect(id, 1, 'tab');
    const student = { id: 1, role: 'student' }; const teacher = { id: 1, role: 'teacher' };
    const prompt = presence.classroom.openPrompt(id, teacher, { body: 'Question', durationSeconds: 60 });
    presence.classroom.respond(id, student, prompt.id, { body: 'Private', visibility: 'teacher' });
    at += 70000; presence.end(id, 1);
    const reports = new ReportService(presence); const saved = reports.get(id, student); const csv = reports.csv(saved);
    db.close(); at += 900000;
    db = openDatabase(filename); presence = new PresenceService(db, { now: () => at });
    const reopened = new ReportService(presence);
    assert.equal(db.pragma('user_version', { simple: true }), 5);
    assert.deepEqual(reopened.get(id, student), saved);
    assert.equal(reopened.csv(reopened.get(id, student)), csv);
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally {
    if (db?.open) db.close();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
