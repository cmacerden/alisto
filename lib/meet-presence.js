const { RequestError } = require('./request-error');
const { nextSessionId } = require('./session-ids');

const MEET_GRACE_MS = 60_000;
const EVIDENCE_MS = 15_000;
const CODE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;

function requireMeetCode(value) {
  if (typeof value !== 'string' || !CODE.test(value)) throw new RequestError(400, 'Use the actual Google Meet code, for example abc-defg-hij.');
  return value;
}

function evidenceState(sources, at) {
  if (sources.some(source => source.state === 'in' && source.expires_at > at)) return 'in';
  if (!sources.length || sources.some(source => source.state === 'unknown' || source.expires_at <= at)) return 'unknown';
  return 'out';
}

function projectMeet(row, sources, timestamp) {
  const result = { ...row };
  const at = Math.max(row.updated_at, timestamp);
  const cuts = [...new Set([row.updated_at, ...sources.map(source => source.expires_at)
    .filter(expiry => expiry > row.updated_at && expiry < at), at])].sort((a, b) => a - b);
  for (let index = 0; index < cuts.length - 1; index++) {
    const from = cuts[index]; const to = cuts[index + 1];
    const state = evidenceState(sources, from);
    if (state === 'unknown') result.unknown_ms += to - from;
    if (result.measurement_started_at === null) {
      if (state === 'in') {
        if (result.grace_started_at === null) result.grace_started_at = from;
        if (to >= result.grace_started_at + MEET_GRACE_MS) result.measurement_started_at = result.grace_started_at + MEET_GRACE_MS;
      } else result.grace_started_at = null;
    }
    if (result.measurement_started_at !== null && state !== 'unknown') {
      const elapsed = Math.max(0, to - Math.max(from, result.measurement_started_at));
      result.total_ms += elapsed;
      if (state === 'in') result.active_ms += elapsed;
    }
  }
  const state = evidenceState(sources, at);
  if (result.measurement_started_at === null) {
    if (state !== 'in') result.grace_started_at = null;
    else if (result.grace_started_at === null) result.grace_started_at = at;
  }
  result.updated_at = at;
  return { ...result, call_state: state };
}

class MeetPresence {
  constructor(db, { now = Date.now } = {}) { this.db = db; this.now = now; }

  start(classId, teacherId, code) {
    requireMeetCode(code);
    if (!this.db.prepare('SELECT 1 FROM classes WHERE id = ? AND teacher_id = ?').get(classId, teacherId)) {
      throw new RequestError(404, 'Class not found.');
    }
    const at = this.now();
    try {
      return this.db.transaction(() => {
        const id = nextSessionId(this.db);
        this.db.prepare(`INSERT INTO sessions (id, class_id, started_at, checkpoint_at, source, meet_code)
          VALUES (?, ?, ?, ?, 'meet', ?)`).run(id, classId, at, at, code);
        return id;
      })();
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') throw new RequestError(409, 'This class or Google Meet code already has a live Alisto session.');
      throw error;
    }
  }

  live(code) {
    requireMeetCode(code);
    const session = this.db.prepare(`SELECT s.*, c.title AS class_title FROM sessions s JOIN classes c ON c.id = s.class_id
      WHERE s.source = 'meet' AND s.status = 'live' AND s.meet_code = ?`).get(code);
    if (!session) throw new RequestError(404, 'No teacher has started an Alisto session for this Google Meet code.');
    return session;
  }

  sources(id, studentId) {
    return this.db.prepare('SELECT * FROM meet_sources WHERE session_id = ? AND student_id = ?').all(id, studentId);
  }

  checkpoint(id, at) {
    const update = this.db.prepare(`UPDATE meet_students SET grace_started_at = ?, measurement_started_at = ?,
      active_ms = ?, total_ms = ?, unknown_ms = ?, updated_at = ? WHERE session_id = ? AND student_id = ?`);
    for (const row of this.db.prepare('SELECT * FROM meet_students WHERE session_id = ?').all(id)) {
      const next = projectMeet(row, this.sources(id, row.student_id), at);
      update.run(next.grace_started_at, next.measurement_started_at, next.active_ms, next.total_ms,
        next.unknown_ms, next.updated_at, id, row.student_id);
    }
  }

  enroll(id, studentId, code, sourceId, checkpoint) {
    this.validateSource(sourceId);
    requireMeetCode(code);
    const session = this.live(code);
    if (session.id !== id) throw new RequestError(409, 'This meeting no longer matches that live Alisto session.');
    this.db.transaction(() => {
      const at = checkpoint();
      const existing = this.sources(id, studentId);
      if (existing.length >= 8 && !existing.some(source => source.source_id === sourceId)) {
        throw new RequestError(409, 'Too many extension sources for this session. Reuse an already connected Chrome profile.');
      }
      this.db.prepare(`INSERT OR IGNORE INTO meet_students (session_id, student_id, enrolled_at, updated_at)
        VALUES (?, ?, ?, ?)`).run(id, studentId, at, at);
      this.db.prepare(`INSERT INTO meet_sources (session_id, student_id, source_id, state, expires_at)
        VALUES (?, ?, ?, 'unknown', ?) ON CONFLICT(session_id, student_id, source_id) DO NOTHING`).run(id, studentId, sourceId, at);
    })();
  }

  validateSource(sourceId) {
    if (typeof sourceId !== 'string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(sourceId)) throw new RequestError(400, 'Invalid extension observation source.');
  }

  observe(id, studentId, { meetCode, sourceId, state } = {}, checkpoint) {
    this.validateSource(sourceId);
    if (!['in', 'out', 'unknown'].includes(state)) throw new RequestError(400, 'Invalid call membership signal.');
    if (this.live(meetCode).id !== id) throw new RequestError(409, 'Wrong meeting for this session.');
    if (!this.db.prepare('SELECT 1 FROM meet_sources WHERE session_id = ? AND student_id = ? AND source_id = ?')
      .get(id, studentId, sourceId)) throw new RequestError(404, 'Connect this meeting from the extension first.');
    this.db.transaction(() => {
      const at = checkpoint();
      this.db.prepare(`UPDATE meet_sources SET state = ?, expires_at = ?
        WHERE session_id = ? AND student_id = ? AND source_id = ?`).run(state, at + EVIDENCE_MS, id, studentId, sourceId);
      if (state === 'in') this.db.prepare('UPDATE meet_students SET joined_at = COALESCE(joined_at, ?) WHERE session_id = ? AND student_id = ?')
        .run(at, id, studentId);
      // Apply the state transition at the exact server receipt time as well.
      this.checkpoint(id, at);
    })();
  }

  finalize(id) {
    this.db.prepare(`UPDATE meet_students SET grace_started_at = NULL,
      final_rate = CASE WHEN total_ms > 0 THEN active_ms * 100.0 / total_ms ELSE NULL END WHERE session_id = ?`).run(id);
  }

  snapshot(session, user, at) {
    const teacher = user.role === 'teacher';
    const rows = this.db.prepare(`SELECT m.*, st.name, st.email FROM meet_students m JOIN students st ON st.id = m.student_id
      WHERE m.session_id = ? ${teacher ? '' : 'AND m.student_id = ?'} ORDER BY st.name COLLATE NOCASE, st.id`)
      .all(...(teacher ? [session.id] : [session.id, user.id]));
    const students = rows.map(row => {
      const live = session.status === 'live';
      const next = live ? projectMeet(row, this.sources(session.id, row.student_id), at) : row;
      return {
        student_id: row.student_id, name: row.name, ...(teacher ? { email: row.email } : {}), joined_at: row.joined_at,
        status: !live ? 'Offline' : next.call_state === 'unknown' ? null : next.call_state === 'in' ? 'Active' : 'Offline',
        call_state: live ? next.call_state : 'ended',
        detection_notice: live && next.call_state === 'unknown' ? 'Cannot verify' : null,
        measurement_started_at: next.measurement_started_at,
        grace_remaining_ms: live && next.call_state === 'in' && next.measurement_started_at === null
          ? Math.max(0, next.grace_started_at + MEET_GRACE_MS - at) : null,
        active_seconds: next.active_ms / 1000, total_seconds: next.total_ms / 1000, excluded_seconds: next.unknown_ms / 1000,
        activity_rate: live ? (next.total_ms > 0 ? next.active_ms / next.total_ms * 100 : null) : next.final_rate
      };
    });
    const { teacher_id, code, ...safeSession } = session;
    return { session: safeSession, server_time: at, ...(teacher ? { students } : { self: students[0] }) };
  }
}

module.exports = { MeetPresence, projectMeet, evidenceState, requireMeetCode, EVIDENCE_MS };
