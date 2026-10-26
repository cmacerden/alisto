const GRACE_MS = 60_000;
const { RequestError } = require('./request-error');
const { MeetPresence } = require('./meet-presence');
const { nextSessionId } = require('./session-ids');

function projectPresence(row, timestamp) {
  const result = { ...row };
  const at = Math.max(timestamp, row.updated_at);
  if (result.measurement_started_at === null && result.connected && result.grace_started_at !== null) {
    const graceEnds = result.grace_started_at + GRACE_MS;
    if (at >= graceEnds) result.measurement_started_at = graceEnds;
  }
  if (result.measurement_started_at !== null) {
    const elapsed = Math.max(0, at - Math.max(result.updated_at, result.measurement_started_at));
    result.total_ms += elapsed;
    if (result.connected) result.active_ms += elapsed;
  }
  result.updated_at = at;
  return result;
}

function activityRate(row) {
  return row.total_ms > 0 ? row.active_ms / row.total_ms * 100 : null;
}

class PresenceService {
  constructor(db, { now = Date.now } = {}) {
    this.db = db;
    this.now = now;
    this.connections = new Map();
    this.meet = new MeetPresence(db, { now });
    this.recoverInterrupted();
  }

  session(id) {
    const result = this.db.prepare(`SELECT s.*, c.title AS class_title, c.code, c.teacher_id
      FROM sessions s JOIN classes c ON c.id = s.class_id WHERE s.id = ?`).get(id);
    if (!result) throw new RequestError(404, 'Session not found.');
    return result;
  }

  requireLive(id) {
    const result = this.session(id);
    if (result.status !== 'live') throw new RequestError(409, 'This session has ended.');
    return result;
  }

  authorize(id, user) {
    const result = this.session(id);
    const table = result.source === 'meet' ? 'meet_students' : 'session_students';
    const allowed = user.role === 'teacher' ? result.teacher_id === user.id :
      this.db.prepare(`SELECT 1 FROM ${table} WHERE session_id = ? AND student_id = ?`).get(id, user.id);
    if (!allowed) throw new RequestError(404, 'Session not found.');
    return result;
  }

  start(classId, teacherId) {
    const classroom = this.db.prepare('SELECT * FROM classes WHERE id = ? AND teacher_id = ?').get(classId, teacherId);
    if (!classroom) throw new RequestError(404, 'Class not found.');
    const at = this.now();
    try {
      const id = this.db.transaction(() => {
        const id = nextSessionId(this.db);
        this.db.prepare('INSERT INTO sessions (id, class_id, started_at, checkpoint_at) VALUES (?, ?, ?, ?)').run(id, classId, at, at);
        return id;
      })();
      return this.session(id);
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') throw new RequestError(409, 'This class already has a live session.');
      throw error;
    }
  }

  resolveJoin(payload, studentId) {
    if (!payload || typeof payload !== 'object') throw new RequestError(400, 'Enter a six-character class code.');
    if (typeof payload.code === 'string') {
      const code = payload.code.trim().toUpperCase();
      if (!/^[A-Z0-9]{6}$/.test(code)) throw new RequestError(400, 'Enter a six-character class code.');
      const result = this.db.prepare(`SELECT s.id FROM sessions s JOIN classes c ON c.id = s.class_id
        WHERE c.code = ? AND s.status = 'live'`).get(code);
      if (!result) throw new RequestError(404, 'No live session was found for this code.');
      if (this.session(result.id).source === 'meet') throw new RequestError(409, 'Join this session through its Google Meet code in the extension.');
      return result.id;
    }
    if (!Number.isSafeInteger(payload.sessionId) || payload.sessionId < 1) throw new RequestError(400, 'Choose a valid session.');
    this.authorize(payload.sessionId, { id: studentId, role: 'student' });
    this.requireLive(payload.sessionId);
    if (this.session(payload.sessionId).source === 'meet') throw new RequestError(409, 'Use the Google Meet extension to connect to this session.');
    return payload.sessionId;
  }

  // All rows are advanced to the same cutoff inside the caller's transaction.
  checkpoint(id, timestamp = this.now()) {
    const session = this.requireLive(id);
    const at = Math.max(timestamp, session.checkpoint_at);
    const update = this.db.prepare(`UPDATE session_students SET measurement_started_at = ?,
      active_ms = ?, total_ms = ?, updated_at = ? WHERE session_id = ? AND student_id = ?`);
    if (session.source === 'meet') this.meet.checkpoint(id, at);
    for (const row of this.db.prepare('SELECT * FROM session_students WHERE session_id = ?').all(id)) {
      const next = projectPresence(row, at);
      update.run(next.measurement_started_at, next.active_ms, next.total_ms, at, id, row.student_id);
    }
    this.db.prepare('UPDATE sessions SET checkpoint_at = ? WHERE id = ?').run(at, id);
    return at;
  }

  checkpointAll() {
    const at = this.now();
    this.db.transaction(() => {
      for (const row of this.db.prepare("SELECT id FROM sessions WHERE status = 'live'").all()) this.checkpoint(row.id, at);
    })();
  }

  connect(id, studentId, connectionId) {
    if (this.requireLive(id).source === 'meet') throw new RequestError(409, 'Meet sessions require call membership observations.');
    const key = `${id}:${studentId}`;
    const connections = this.connections.get(key) || new Set();
    if (connections.has(connectionId)) return;
    this.db.transaction(() => {
      const at = this.checkpoint(id);
      const row = this.db.prepare('SELECT * FROM session_students WHERE session_id = ? AND student_id = ?').get(id, studentId);
      if (!row) {
        this.db.prepare(`INSERT INTO session_students
          (session_id, student_id, joined_at, connected, grace_started_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)`)
          .run(id, studentId, at, at, at);
      } else if (!row.connected) {
        this.db.prepare(`UPDATE session_students SET connected = 1, grace_started_at = ?
          WHERE session_id = ? AND student_id = ?`)
          .run(row.measurement_started_at === null ? at : row.grace_started_at, id, studentId);
      }
    })();
    connections.add(connectionId);
    this.connections.set(key, connections);
  }

  disconnect(id, studentId, connectionId) {
    const key = `${id}:${studentId}`;
    const connections = this.connections.get(key);
    if (!connections?.delete(connectionId) || connections.size) return;
    this.connections.delete(key);
    if (this.session(id).status !== 'live') return;
    this.db.transaction(() => {
      this.checkpoint(id);
      this.db.prepare(`UPDATE session_students SET connected = 0,
        grace_started_at = CASE WHEN measurement_started_at IS NULL THEN NULL ELSE grace_started_at END
        WHERE session_id = ? AND student_id = ?`).run(id, studentId);
    })();
  }

  finalize(id, status, at) {
    this.meet.finalize(id);
    this.db.prepare(`UPDATE session_students SET connected = 0, grace_started_at = NULL,
      final_rate = CASE WHEN total_ms > 0 THEN active_ms * 100.0 / total_ms ELSE NULL END
      WHERE session_id = ?`).run(id);
    this.db.prepare('UPDATE sessions SET status = ?, ended_at = ? WHERE id = ?').run(status, at, id);
    for (const key of this.connections.keys()) if (key.startsWith(`${id}:`)) this.connections.delete(key);
  }

  end(id, teacherId) {
    const session = this.authorize(id, { id: teacherId, role: 'teacher' });
    if (session.status !== 'live') throw new RequestError(409, 'This session has already ended.');
    this.db.transaction(() => {
      const at = this.checkpoint(id);
      this.finalize(id, 'ended', at);
    })();
    return this.session(id);
  }

  deleteEnded(id, teacherId) {
    try {
      return this.db.transaction(() => {
        const session = this.authorize(id, { id: teacherId, role: 'teacher' });
        if (session.status === 'live') throw new RequestError(409, 'End the Alisto session before deleting it.');
        const studentIds = this.db.prepare(`SELECT student_id FROM session_students WHERE session_id = ?
          UNION SELECT student_id FROM meet_students WHERE session_id = ?`).all(id, id).map(row => row.student_id);
        // Preserve a high-water mark for sessions created before the allocator.
        this.db.prepare(`INSERT INTO id_sequences (name, value) VALUES ('sessions', (SELECT MAX(id) FROM sessions))
          ON CONFLICT(name) DO UPDATE SET value = MAX(value, excluded.value)`).run();
        this.db.prepare('DELETE FROM meet_sources WHERE session_id = ?').run(id);
        this.db.prepare('DELETE FROM meet_students WHERE session_id = ?').run(id);
        this.db.prepare('DELETE FROM session_students WHERE session_id = ?').run(id);
        this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
        return { sessionId: session.id, teacherId: session.teacher_id, studentIds };
      })();
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_FOREIGNKEY' ||
          (error.code === 'SQLITE_CONSTRAINT_TRIGGER' && error.message === 'FOREIGN KEY constraint failed')) {
        throw new RequestError(409, 'This session has additional linked records and cannot be deleted. No records were removed.');
      }
      throw error;
    }
  }

  recoverInterrupted() {
    this.db.transaction(() => {
      for (const row of this.db.prepare("SELECT id, checkpoint_at FROM sessions WHERE status = 'live'").all()) {
        // Do not project to restart time: downtime must never become absence.
        this.finalize(row.id, 'interrupted', row.checkpoint_at);
      }
    })();
  }

  shutdown() {
    this.checkpointAll();
    this.recoverInterrupted();
  }

  list(user) {
    const condition = user.role === 'teacher' ? 'c.teacher_id = ?' :
      '(EXISTS (SELECT 1 FROM session_students ss WHERE ss.session_id = s.id AND ss.student_id = ?) OR EXISTS (SELECT 1 FROM meet_students ms WHERE ms.session_id = s.id AND ms.student_id = ?))';
    return this.db.prepare(`SELECT s.*, c.title AS class_title, c.code,
      ((SELECT count(*) FROM session_students ss WHERE ss.session_id = s.id) + (SELECT count(*) FROM meet_students ms WHERE ms.session_id = s.id)) AS student_count
      FROM sessions s JOIN classes c ON c.id = s.class_id WHERE ${condition} ORDER BY s.id DESC`).all(...(user.role === 'teacher' ? [user.id] : [user.id, user.id]))
      .map(({ student_count, ...row }) => user.role === 'teacher' ? { ...row, student_count } : row);
  }

  snapshot(id, user, timestamp = this.now()) {
    const session = this.authorize(id, user);
    const at = session.status === 'live' ? Math.max(timestamp, session.checkpoint_at) : session.ended_at;
    if (session.source === 'meet') return this.meet.snapshot(session, user, at);
    const rows = this.db.prepare(`SELECT ss.*, st.name, st.email FROM session_students ss
      JOIN students st ON st.id = ss.student_id WHERE ss.session_id = ? ${user.role === 'student' ? 'AND ss.student_id = ?' : ''}
      ORDER BY st.name COLLATE NOCASE, st.id`).all(...(user.role === 'student' ? [id, user.id] : [id]));
    const students = rows.map(row => {
      const next = session.status === 'live' ? projectPresence(row, at) : row;
      const result = {
        student_id: row.student_id, name: row.name, joined_at: row.joined_at,
        status: session.status === 'live' && next.connected ? 'Active' : 'Offline',
        measurement_started_at: next.measurement_started_at,
        grace_remaining_ms: session.status === 'live' && next.connected && next.measurement_started_at === null
          ? Math.max(0, next.grace_started_at + GRACE_MS - at) : null,
        active_seconds: next.active_ms / 1000, total_seconds: next.total_ms / 1000,
        activity_rate: session.status === 'live' ? activityRate(next) : next.final_rate
      };
      if (user.role === 'teacher') result.email = row.email;
      return result;
    });
    const { teacher_id, ...safeSession } = session;
    return { session: safeSession, server_time: at, ...(user.role === 'teacher' ? { students } : { self: students[0] }) };
  }
}

module.exports = { PresenceService, RequestError, projectPresence, activityRate, GRACE_MS };
