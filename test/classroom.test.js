const { test } = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../lib/database');
const { PresenceService } = require('../lib/presence');
const { classification } = require('../lib/classroom');

function fixture(t, legacy = false) {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  db.exec(`INSERT INTO teachers (id, name, email, password_hash) VALUES (1, 'Teacher', 't@example.com', 'hash'), (2, 'Other', 'other@example.com', 'hash');
    INSERT INTO students (id, name, email, password_hash) VALUES (1, 'Student', 's@example.com', 'hash'), (2, 'Peer', 'p@example.com', 'hash'), (3, 'Late', 'l@example.com', 'hash');
    INSERT INTO classes (id, teacher_id, title, code) VALUES (1, 1, 'Class', 'ABC234');`);
  let time = 1_000_000;
  const presence = new PresenceService(db, { now: () => time });
  const id = legacy ? presence.start(1, 1).id : presence.meet.start(1, 1, 'abc-defg-hij');
  const teacher = { id: 1, role: 'teacher' };
  const student = number => ({ id: number, role: 'student' });
  const classroom = presence.classroom;
  const observe = (number, state = 'in') => presence.meet.observe(id, number, {
    meetCode: 'abc-defg-hij', sourceId: `profile_source_${number}_123456`, state
  }, () => presence.checkpoint(id));
  const enroll = number => presence.meet.enroll(id, number, 'abc-defg-hij', `profile_source_${number}_123456`, () => presence.checkpoint(id));
  return { db, presence, classroom, id, teacher, student, enroll, observe,
    join(number) { if (legacy) presence.connect(id, number, `tab_${number}`); else { enroll(number); observe(number); } },
    advance(ms) { time += ms; },
    open(body = 'Explain the idea', durationSeconds = 60) { return classroom.openPrompt(id, teacher, { body, durationSeconds }).id; },
    respond(prompt, number = 1, visibility = 'everyone', body = 'My answer') { return classroom.respond(id, student(number), prompt, { body, visibility }); },
    view(number) { return classroom.snapshot(id, number ? student(number) : teacher); }
  };
}

test('room enrollment alone grants no chat or participation eligibility; actual join does', t => {
  const f = fixture(t); f.enroll(1);
  assert.throws(() => f.view(1), { status: 403 });
  const beforeJoin = f.open();
  f.observe(1);
  assert.equal(f.view(1).self.eligible_count, 0);
  assert.equal(f.view(1).self.participation_rate, null);
  assert.throws(() => f.respond(beforeJoin), { status: 403 });
  f.classroom.closePrompt(f.id, f.teacher, beforeJoin);
  f.open();
  assert.equal(f.view(1).self.eligible_count, 1);
});

test('Everyone is the default and Teacher only is filtered before peer serialization with identical credit', t => {
  const f = fixture(t); f.join(1); f.join(2);
  const prompt = f.open();
  f.respond(prompt, 1, 'teacher', 'PRIVATE RESPONSE SENTINEL');
  f.classroom.respond(f.id, f.student(2), prompt, { body: 'Public answer' });
  assert.equal(f.view().prompts[0].responses.length, 2);
  assert.equal(f.view(1).prompts[0].responses.length, 2);
  const peer = f.view(2);
  assert.equal(peer.prompts[0].responses.length, 1);
  assert.equal(peer.prompts[0].responses[0].visibility, 'everyone');
  assert.ok(!JSON.stringify(peer).includes('PRIVATE RESPONSE SENTINEL'));
  assert.equal(f.view(1).self.participation_rate, 100);
  assert.deepEqual(f.view(1).self, f.view(2).self);
  assert.equal(peer.progress, undefined);
});

test('eligibility snapshots distinguish late joins in the same millisecond and retain later offline eligibility', t => {
  const f = fixture(t); f.join(1);
  const first = f.open(); f.join(2);
  assert.equal(f.view(2).prompts[0].eligible, false);
  assert.throws(() => f.respond(first, 2), { status: 403 });
  f.classroom.closePrompt(f.id, f.teacher, first);
  f.observe(1, 'out');
  const second = f.open();
  assert.equal(f.view(1).self.eligible_count, 2);
  assert.equal(f.view(2).self.eligible_count, 1);
  assert.equal(f.view().progress.buckets.Disconnected.length, 1);
  f.respond(second); // Responding in Alisto does not mark the call Active.
  assert.equal(f.presence.snapshot(f.id, f.student(1)).self.status, 'Offline');
});

test('one open prompt, exact deadline, duplicate tabs, and foreign prompt IDs are enforced', t => {
  const f = fixture(t); f.join(1); f.join(2);
  const prompt = f.open('Timed', 5);
  assert.throws(() => f.open(), { status: 409 });
  f.advance(4999); f.respond(prompt);
  assert.throws(() => f.respond(prompt), { status: 409 });
  f.advance(1);
  assert.throws(() => f.respond(prompt, 2), { status: 409 });
  assert.equal(f.view().prompts[0].open, false);
  const next = f.open();
  assert.ok(next > prompt);
  assert.throws(() => f.respond(999), { status: 404 });
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM participation_responses').get().n, 1);
});

test('teacher buckets prioritize responses and never call uncertain Meet evidence disconnected', t => {
  const f = fixture(t); f.join(1); f.join(2); f.join(3);
  const prompt = f.open(); f.respond(prompt); f.observe(1, 'out'); f.observe(2, 'out');
  let progress = f.view().progress;
  assert.equal(progress.responded_count, 1);
  assert.equal(progress.eligible_count, 3);
  assert.equal(progress.buckets.Participated[0].student_id, 1);
  assert.equal(progress.buckets.Disconnected[0].student_id, 2);
  assert.equal(progress.buckets.Pending[0].student_id, 3);
  f.observe(3, 'unknown');
  assert.equal(f.view().progress.buckets['Cannot verify'][0].student_id, 3);
  f.observe(3); f.classroom.closePrompt(f.id, f.teacher, prompt);
  assert.equal(f.view().progress.buckets['No Participation'][0].student_id, 3);
  progress = f.view().progress;
  assert.equal(Object.values(progress.buckets).flat().length, progress.eligible_count);
});

test('classification uses unrounded rates and no eligible prompts are N/A', () => {
  for (const [rate, expected] of [[null, 'Not yet applicable'], [0, 'No Participation'],
    [0.1, 'Low Participation'], [49.999, 'Low Participation'], [50, 'Moderately Active'],
    [79.999, 'Moderately Active'], [80, 'Highly Active'], [100, 'Highly Active']]) {
    assert.equal(classification(rate), expected);
  }
});

test('general chat persists sender role/name/time, validates inputs, and never changes Activity Rate', t => {
  const f = fixture(t); f.join(1);
  const before = f.presence.snapshot(f.id, f.student(1));
  f.classroom.postMessage(f.id, f.teacher, 'Teacher discussion');
  f.classroom.postMessage(f.id, f.student(1), '<img src=x onerror=alert(1)>');
  const messages = f.view(1).messages;
  assert.equal(messages.length, 2);
  assert.equal(messages[0].sender_role, 'teacher');
  assert.equal(messages[1].sender_name, 'Student');
  assert.equal(messages[1].body, '<img src=x onerror=alert(1)>');
  assert.ok(messages[1].created_at >= before.server_time);
  assert.deepEqual(f.presence.snapshot(f.id, f.student(1)), before);
  for (const value of ['', ' ', null, 'x'.repeat(2001)]) {
    assert.throws(() => f.classroom.postMessage(f.id, f.student(1), value), { status: 400 });
  }
  assert.equal(f.view(1).self.eligible_count, 0);
});

test('authorization, role restrictions, invalid durations, and unsupported visibility are rejected', t => {
  const f = fixture(t); f.join(1);
  const other = { role: 'teacher', id: 2 };
  assert.throws(() => f.classroom.snapshot(f.id, other), { status: 404 });
  assert.throws(() => f.view(2), { status: 404 });
  assert.throws(() => f.classroom.postMessage(f.id, other, 'Hi'), { status: 404 });
  assert.throws(() => f.classroom.openPrompt(f.id, f.student(1), { body: 'Hi', durationSeconds: 60 }), { status: 403 });
  for (const seconds of [null, 0, 4, 3601, 5.5, '60']) {
    assert.throws(() => f.open('Prompt', seconds), { status: 400 });
  }
  const prompt = f.open();
  assert.throws(() => f.respond(prompt, 1, 'secret'), { status: 400 });
  assert.throws(() => f.classroom.respond(f.id, f.teacher, prompt, { body: 'Hi' }), { status: 403 });
  assert.throws(() => f.classroom.closePrompt(f.id, other, prompt), { status: 404 });
});

test('ending closes prompts immediately, freezes results, and rejects every subsequent write', t => {
  const f = fixture(t); f.join(1); f.join(2);
  const prompt = f.open(); f.respond(prompt, 1, 'teacher');
  f.advance(1000); f.presence.end(f.id, 1);
  const saved = f.view(1);
  assert.equal(saved.prompts[0].remaining_ms, 0);
  assert.equal(saved.prompts[0].closed_at, saved.server_time);
  assert.equal(saved.self.participation_rate, 100);
  assert.equal(f.view(2).self.participation_rate, 0);
  f.advance(90000);
  assert.deepEqual(f.view(1), saved);
  assert.throws(() => f.respond(prompt, 2), { status: 409 });
  assert.throws(() => f.open(), { status: 409 });
  assert.throws(() => f.classroom.postMessage(f.id, f.teacher, 'Late'), { status: 409 });
});

test('crash recovery uses the last atomic chat/response checkpoint without counting downtime', t => {
  const f = fixture(t); f.join(1); f.join(2);
  const prompt = f.open(); f.advance(2000); f.respond(prompt, 1, 'teacher');
  const cutoff = f.presence.session(f.id).checkpoint_at;
  f.advance(600000);
  const recovered = new PresenceService(f.db, { now: () => cutoff + 600000 });
  const snapshot = recovered.classroom.snapshot(f.id, f.teacher);
  assert.equal(snapshot.session_status, 'interrupted');
  assert.equal(snapshot.server_time, cutoff);
  assert.equal(snapshot.prompts[0].closed_at, cutoff);
  assert.equal(snapshot.prompts[0].responses.length, 1);
  assert.equal(recovered.classroom.summary(f.id, 1).participation_rate, 100);
  assert.equal(recovered.classroom.summary(f.id, 2).participation_rate, 0);
});

test('explicit session deletion removes chats and participation transactionally; linked records still roll back', t => {
  const f = fixture(t); f.join(1);
  f.classroom.postMessage(f.id, f.teacher, 'Hello');
  const prompt = f.open(); f.respond(prompt);
  f.presence.end(f.id, 1);
  f.db.exec(`CREATE TABLE linked_report (session_id INTEGER REFERENCES sessions(id) ON DELETE RESTRICT);
    INSERT INTO linked_report VALUES (${f.id});`);
  const saved = f.view();
  assert.throws(() => f.presence.deleteEnded(f.id, 1), { status: 409 });
  assert.deepEqual(f.view(), saved);
  f.db.exec('DELETE FROM linked_report');
  f.presence.deleteEnded(f.id, 1);
  for (const table of ['messages', 'participation_activities', 'participation_eligibility', 'participation_responses']) {
    assert.equal(f.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0);
  }
  assert.deepEqual(f.db.pragma('foreign_key_check'), []);
});

test('legacy sessions retain connection-based presence while using the same independent participation rules', t => {
  const f = fixture(t, true); f.join(1);
  const prompt = f.open(); f.respond(prompt);
  assert.equal(f.view(1).self.participation_rate, 100);
  const self = f.presence.snapshot(f.id, f.student(1)).self;
  assert.equal(self.status, 'Active');
  assert.equal(self.activity_rate, null);
});

test('clock rollback cannot reopen a prompt or backdate a chat response', t => {
  const f = fixture(t); f.join(1);
  const prompt = f.open('Timed', 5);
  f.advance(5000); f.presence.checkpointAll(); f.advance(-4000);
  assert.equal(f.view().prompts[0].open, false);
  assert.throws(() => f.respond(prompt), { status: 409 });
});
