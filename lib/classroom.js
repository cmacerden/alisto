const { RequestError } = require('./request-error');

function classification(rate) {
  if (rate === null) return 'Not yet applicable';
  if (rate >= 80) return 'Highly Active';
  if (rate >= 50) return 'Moderately Active';
  if (rate > 0) return 'Low Participation';
  return 'No Participation';
}

function text(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 2000) {
    throw new RequestError(400, 'Enter 1 to 2000 characters.');
  }
  return value.trim();
}

class ClassroomService {
  constructor(presence) { this.presence = presence; this.db = presence.db; }

  authorize(id, user, teacherOnly = false) {
    if (teacherOnly && user.role !== 'teacher') throw new RequestError(403, 'Only the owning teacher can manage prompts.');
    const session = this.presence.authorize(id, user);
    if (user.role === 'student') {
      const table = session.source === 'meet' ? 'meet_students' : 'session_students';
      const row = this.db.prepare(`SELECT joined_at FROM ${table} WHERE session_id = ? AND student_id = ?`).get(id, user.id);
      if (row?.joined_at == null) throw new RequestError(403, 'Join the matching call before opening class chat.');
    }
    return session;
  }

  // Called inside the presence checkpoint/finalization transaction.
  expire(id, at, ending = false) {
    this.db.prepare(`UPDATE participation_activities SET closed_at = MIN(deadline_at, ?)
      WHERE session_id = ? AND closed_at IS NULL ${ending ? '' : 'AND deadline_at <= ?'}`)
      .run(...(ending ? [at, id] : [at, id, at]));
  }

  write(id, user, task, teacherOnly = false) {
    this.authorize(id, user, teacherOnly);
    return this.db.transaction(() => {
      const at = this.presence.checkpoint(id);
      return task(at);
    })();
  }

  postMessage(id, user, body) {
    const content = text(body);
    return this.write(id, user, at => {
      const result = this.db.prepare(`INSERT INTO messages(session_id, teacher_id, student_id, body, created_at)
        VALUES (?, ?, ?, ?, ?)`).run(id, user.role === 'teacher' ? user.id : null, user.role === 'student' ? user.id : null, content, at);
      return { id: Number(result.lastInsertRowid) };
    });
  }

  openPrompt(id, user, { body, durationSeconds } = {}) {
    const content = text(body);
    if (!Number.isInteger(durationSeconds) || durationSeconds < 5 || durationSeconds > 3600) {
      throw new RequestError(400, 'Prompt duration must be 5 to 3600 seconds.');
    }
    return this.write(id, user, at => {
      if (this.db.prepare('SELECT 1 FROM participation_activities WHERE session_id = ? AND closed_at IS NULL').get(id)) {
        throw new RequestError(409, 'Close the current prompt before posting another.');
      }
      const result = this.db.prepare(`INSERT INTO participation_activities(session_id, teacher_id, body, created_at, deadline_at)
        VALUES (?, ?, ?, ?, ?)`).run(id, user.id, content, at, at + durationSeconds * 1000);
      const activityId = Number(result.lastInsertRowid);
      const table = this.presence.session(id).source === 'meet' ? 'meet_students' : 'session_students';
      this.db.prepare(`INSERT INTO participation_eligibility(activity_id, student_id)
        SELECT ?, student_id FROM ${table} WHERE session_id = ? AND joined_at IS NOT NULL`).run(activityId, id);
      return { id: activityId };
    }, true);
  }

  prompt(id, activityId) {
    if (!Number.isSafeInteger(activityId) || activityId < 1) throw new RequestError(400, 'Invalid prompt.');
    const prompt = this.db.prepare('SELECT * FROM participation_activities WHERE id = ? AND session_id = ?').get(activityId, id);
    if (!prompt) throw new RequestError(404, 'Prompt not found.');
    return prompt;
  }

  closePrompt(id, user, activityId) {
    return this.write(id, user, at => {
      const prompt = this.prompt(id, activityId);
      if (prompt.closed_at !== null) throw new RequestError(409, 'This prompt is already closed.');
      this.db.prepare('UPDATE participation_activities SET closed_at = ? WHERE id = ?').run(Math.min(at, prompt.deadline_at), activityId);
      return { id: activityId };
    }, true);
  }

  respond(id, user, activityId, { body, visibility = 'everyone' } = {}) {
    if (user.role !== 'student') throw new RequestError(403, 'Only students can respond to participation prompts.');
    const content = text(body);
    if (!['everyone', 'teacher'].includes(visibility)) throw new RequestError(400, 'Choose Everyone or Teacher only.');
    return this.write(id, user, at => {
      const prompt = this.prompt(id, activityId);
      if (prompt.closed_at !== null || at >= prompt.deadline_at) throw new RequestError(409, 'This prompt is closed.');
      if (!this.db.prepare('SELECT 1 FROM participation_eligibility WHERE activity_id = ? AND student_id = ?').get(activityId, user.id)) {
        throw new RequestError(403, 'This prompt was posted before your first call join and is not eligible.');
      }
      if (this.db.prepare('SELECT 1 FROM participation_responses WHERE activity_id = ? AND student_id = ?').get(activityId, user.id)) {
        throw new RequestError(409, 'Your first response already earned credit.');
      }
      this.db.prepare(`INSERT INTO participation_responses(activity_id, student_id, body, visibility, received_at)
        VALUES (?, ?, ?, ?, ?)`).run(activityId, user.id, content, visibility, at);
      return { id: activityId };
    });
  }

  summary(id, studentId) {
    const row = this.db.prepare(`SELECT COUNT(*) AS eligible_count, COUNT(r.student_id) AS responded_count
      FROM participation_eligibility e JOIN participation_activities a ON a.id = e.activity_id
      LEFT JOIN participation_responses r ON r.activity_id = e.activity_id AND r.student_id = e.student_id
      WHERE a.session_id = ? AND e.student_id = ?`).get(id, studentId);
    const rate = row.eligible_count ? row.responded_count / row.eligible_count * 100 : null;
    return { ...row, participation_rate: rate, classification: classification(rate) };
  }

  snapshot(id, user) {
    this.authorize(id, user);
    const presence = this.presence.snapshot(id, user);
    const teacher = user.role === 'teacher';
    const at = presence.server_time;
    const messages = this.db.prepare(`SELECT m.id, m.body, m.created_at,
      CASE WHEN m.teacher_id IS NOT NULL THEN 'teacher' ELSE 'student' END AS sender_role,
      COALESCE(t.name, s.name) AS sender_name FROM messages m
      LEFT JOIN teachers t ON t.id = m.teacher_id LEFT JOIN students s ON s.id = m.student_id
      WHERE m.session_id = ? ORDER BY m.id DESC LIMIT 100`).all(id).reverse();
    const prompts = this.db.prepare(`SELECT a.id, a.body, a.created_at, a.deadline_at, a.closed_at, t.name AS sender_name,
      'teacher' AS sender_role FROM participation_activities a JOIN teachers t ON t.id = a.teacher_id
      WHERE a.session_id = ? ORDER BY a.id`).all(id).map(prompt => {
      const closesAt = prompt.closed_at ?? prompt.deadline_at;
      const open = presence.session.status === 'live' && at < closesAt;
      const responses = this.db.prepare(`SELECT r.student_id, s.name AS sender_name, 'student' AS sender_role, r.body, r.visibility, r.received_at
        FROM participation_responses r JOIN students s ON s.id = r.student_id
        WHERE r.activity_id = ? ${teacher ? '' : "AND (r.visibility = 'everyone' OR r.student_id = ?)"}
        ORDER BY r.received_at, r.student_id`).all(...(teacher ? [prompt.id] : [prompt.id, user.id]));
      const eligible = !teacher && !!this.db.prepare('SELECT 1 FROM participation_eligibility WHERE activity_id = ? AND student_id = ?').get(prompt.id, user.id);
      return { ...prompt, closed_at: open ? null : closesAt, open, remaining_ms: open ? closesAt - at : 0,
        responses, ...(!teacher ? { eligible, responded: responses.some(response => response.student_id === user.id) } : {}) };
    });
    const current = prompts.at(-1) || null;
    const result = { session_id: Number(id), session_status: presence.session.status, server_time: at,
      viewer: { id: user.id, role: user.role }, messages, prompts,
      ...(!teacher ? { self: presence.self.participation } : {}) };
    if (teacher) {
      const eligibleIds = new Set(current ? this.db.prepare('SELECT student_id FROM participation_eligibility WHERE activity_id = ?').all(current.id).map(row => row.student_id) : []);
      const respondedIds = new Set(current?.responses.map(row => row.student_id) || []);
      const buckets = { Participated: [], Disconnected: [], Pending: [], 'No Participation': [], 'Cannot verify': [] };
      for (const student of presence.students) {
        if (!eligibleIds.has(student.student_id)) continue;
        const bucket = respondedIds.has(student.student_id) ? 'Participated' : student.status === 'Offline' ? 'Disconnected'
          : student.status === null ? 'Cannot verify' : current.open ? 'Pending' : 'No Participation';
        buckets[bucket].push({ student_id: student.student_id, name: student.name });
      }
      result.progress = { eligible_count: eligibleIds.size, responded_count: respondedIds.size, buckets };
    }
    return result;
  }
}

module.exports = { ClassroomService, classification };
