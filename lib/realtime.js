const crypto = require('node:crypto');
const { Server } = require('socket.io');
const { RequestError } = require('./presence');

function validToken(sent, expected) {
  return typeof sent === 'string' && typeof expected === 'string' &&
    Buffer.byteLength(sent) === Buffer.byteLength(expected) &&
    crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(expected));
}

function attachRealtime(server, { presence, sessionMiddleware, account, store, now = Date.now }) {
  const io = new Server(server, {
    maxHttpBufferSize: 8192, pingInterval: 10000, pingTimeout: 10000,
    allowRequest(req, done) {
      try {
        done(null, !req.headers.origin || new URL(req.headers.origin).host.toLowerCase() === req.headers.host?.toLowerCase());
      } catch { done(null, false); }
    }
  });
  let closing = false;
  io.engine.use(sessionMiddleware);
  io.use((socket, next) => {
    const user = account(socket.request);
    if (!user || !validToken(socket.handshake.auth?.csrfToken, socket.request.session.csrfToken)) {
      return next(new Error('Please log in again to connect.'));
    }
    socket.data.user = user;
    socket.data.sid = socket.request.sessionID;
    next();
  });

  function currentUser(socket) {
    let saved;
    store.get(socket.data.sid, (error, value) => { if (!error) saved = value; });
    if (!saved || saved.user?.id !== socket.data.user.id || saved.user?.role !== socket.data.user.role) return null;
    return account({ session: saved });
  }

  function publish(id) {
    const session = presence.session(id);
    const at = now();
    io.to(`teacher:${id}`).emit('presence:update', presence.snapshot(id, { id: session.teacher_id, role: 'teacher' }, at));
    for (const row of presence.db.prepare('SELECT student_id FROM session_students WHERE session_id = ? UNION SELECT student_id FROM meet_students WHERE session_id = ?').all(id, id)) {
      io.to(`student:${id}:${row.student_id}`).emit('presence:update', presence.snapshot(id, { id: row.student_id, role: 'student' }, at));
    }
  }

  function notifySessions(id) {
    const session = presence.session(id);
    io.to(`account:teacher:${session.teacher_id}`).emit('sessions:changed');
    for (const row of presence.db.prepare('SELECT student_id FROM session_students WHERE session_id = ? UNION SELECT student_id FROM meet_students WHERE session_id = ?').all(id, id)) {
      io.to(`account:student:${row.student_id}`).emit('sessions:changed');
    }
  }

  function detach(socket) {
    const id = socket.data.sessionId;
    if (!id) return;
    socket.data.sessionId = null;
    const user = socket.data.user;
    socket.leave(user.role === 'teacher' ? `teacher:${id}` : `student:${id}:${user.id}`);
    if (user.role === 'student') presence.disconnect(id, user.id, socket.id);
    publish(id);
  }

  io.on('connection', socket => {
    socket.join(`login:${socket.data.sid}`);
    socket.join(`account:${socket.data.user.role}:${socket.data.user.id}`);
    let windowStart = now();
    let actions = 0;
    function action(event, handler) {
      socket.on(event, (payload, acknowledge) => {
        const ack = typeof acknowledge === 'function' ? acknowledge : () => {};
        try {
          if (closing) throw new RequestError(503, 'The server is restarting.');
          const user = currentUser(socket);
          if (!user) { ack({ ok: false, status: 401, error: 'Please log in again.' }); socket.disconnect(true); return; }
          if (now() - windowStart >= 10000) { windowStart = now(); actions = 0; }
          if (++actions > 30) throw new RequestError(429, 'Too many requests. Try again in 10 seconds.');
          const data = handler(payload, user);
          ack({ ok: true, data });
        } catch (error) {
          if (!error.status) console.error(error);
          ack({ ok: false, status: error.status || 500, error: error.status ? error.message : 'Could not update the session.' });
        }
      });
    }

    action('session:watch', (payload, user) => {
      if (user.role !== 'teacher') throw new RequestError(403, 'This action is available to teachers only.');
      if (!Number.isSafeInteger(payload?.sessionId) || payload.sessionId < 1) throw new RequestError(400, 'Choose a valid session.');
      presence.authorize(payload.sessionId, user);
      detach(socket);
      socket.data.sessionId = payload.sessionId;
      socket.join(`teacher:${payload.sessionId}`);
      return presence.snapshot(payload.sessionId, user);
    });
    action('session:join', (payload, user) => {
      if (user.role !== 'student') throw new RequestError(403, 'Only students can join as participants.');
      const id = presence.resolveJoin(payload, user.id);
      if (socket.data.sessionId !== id) detach(socket);
      presence.connect(id, user.id, socket.id);
      socket.data.sessionId = id;
      socket.join(`student:${id}:${user.id}`);
      publish(id);
      notifySessions(id);
      return presence.snapshot(id, user);
    });
    action('session:leave', (payload, user) => {
      if (user.role !== 'student') throw new RequestError(403, 'Only students can leave as participants.');
      detach(socket);
      return { message: 'Left this session in this tab.' };
    });
    socket.on('disconnect', () => { if (!closing) detach(socket); });
  });

  let lastCheckpoint = now();
  const timer = setInterval(() => {
    if (closing) return;
    try {
      // Connection checks also enforce logout and login-session expiration.
      for (const socket of io.sockets.sockets.values()) if (!currentUser(socket)) socket.disconnect(true);
      if (now() - lastCheckpoint >= 5000) { presence.checkpointAll(); lastCheckpoint = now(); }
      for (const row of presence.db.prepare("SELECT id FROM sessions WHERE status = 'live'").all()) publish(row.id);
    } catch (error) { console.error('Presence update failed:', error); }
  }, 1000);
  timer.unref();

  return {
    io, publish, notifySessions,
    sessionDeleted({ sessionId, teacherId, studentIds }) {
      // Clear subscriptions before any later leave/disconnect can reference a
      // row that no longer exists. Do not call detach(), which reads that row.
      for (const socket of io.sockets.sockets.values()) {
        if (socket.data.sessionId !== sessionId) continue;
        socket.data.sessionId = null;
        const user = socket.data.user;
        socket.leave(user.role === 'teacher' ? `teacher:${sessionId}` : `student:${sessionId}:${user.id}`);
      }
      const accounts = [`account:teacher:${teacherId}`, ...studentIds.map(id => `account:student:${id}`)];
      for (const room of accounts) {
        io.to(room).emit('session:deleted', { sessionId });
        io.to(room).emit('sessions:changed');
      }
    },
    revoke(sid) { io.in(`login:${sid}`).disconnectSockets(true); },
    close() {
      if (closing) return;
      closing = true;
      clearInterval(timer);
      presence.shutdown();
      io.disconnectSockets(true);
      io.engine.close();
    }
  };
}

module.exports = { attachRealtime, validToken };
