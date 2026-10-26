const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const { openDatabase } = require('./database');
const { SQLiteSessionStore, MAX_AGE } = require('./session-store');
const { PresenceService } = require('./presence');
const { attachRealtime } = require('./realtime');

const publicPath = path.join(__dirname, '../public');
const tables = { teacher: 'teachers', student: 'students' };
const codeAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const dummyHash = bcrypt.hashSync('not-a-real-account-password', 12);

function createApp({ databasePath, sessionSecret, production = false, trustProxy = false, enableRateLimit = true, now = Date.now, cookieName = 'alisto.sid' }) {
  if (!sessionSecret || sessionSecret.length < 32) throw new Error('A session secret of at least 32 characters is required.');
  const db = openDatabase(databasePath);
  const store = new SQLiteSessionStore(db);
  const presence = new PresenceService(db, { now });
  let realtime;
  let stopping = false;
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    if (stopping) return res.status(503).json({ error: 'Alisto is restarting. Please reconnect shortly.' });
    next();
  });
  if (trustProxy) app.set('trust proxy', 1);
  app.use(helmet({
    // Local HTTP development must not be upgraded to HTTPS by the browser.
    strictTransportSecurity: production,
    contentSecurityPolicy: { directives: { 'upgrade-insecure-requests': production ? [] : null } }
  }));
  app.use(express.json({ limit: '16kb' }));
  const sessionMiddleware = session({
    name: cookieName, secret: sessionSecret, store,
    resave: false, saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: production, maxAge: MAX_AGE }
  });
  app.use(sessionMiddleware);
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  function csrfToken(req) {
    if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    return req.session.csrfToken;
  }

  app.get('/api/auth/csrf', (req, res) => res.json({ csrfToken: csrfToken(req) }));
  app.use('/api', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const sent = req.get('X-CSRF-Token');
    const expected = req.session.csrfToken;
    if (!sent || !expected || Buffer.byteLength(sent) !== Buffer.byteLength(expected) ||
        !crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(expected))) {
      return res.status(403).json({ error: 'Your security token expired. Refresh the page and try again.' });
    }
    next();
  });

  const authLimiter = enableRateLimit ? rateLimit({
    windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false,
    message: { error: 'Too many authentication attempts. Try again in 15 minutes.' }
  }) : (req, res, next) => next();

  function account(req) {
    const identity = req.session.user;
    if (!identity || !Object.hasOwn(tables, identity.role)) return null;
    const row = db.prepare(`SELECT id, name, email FROM ${tables[identity.role]} WHERE id = ?`).get(identity.id);
    return row ? { ...row, role: identity.role } : null;
  }

  function requireUser(role) {
    return (req, res, next) => {
      req.user = account(req);
      if (!req.user) return res.status(401).json({ error: 'Please log in to continue.' });
      if (role && req.user.role !== role) return res.status(403).json({ error: role === 'teacher' ? 'This action is available to teachers only.' : 'This action is available to students only.' });
      next();
    };
  }

  async function signIn(req, user) {
    realtime?.revoke(req.sessionID);
    await new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
    req.session.user = { id: user.id, role: user.role };
    csrfToken(req);
    await new Promise((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));
  }

  function credentials(body) {
    const { role, email, password } = body || {};
    if (!Object.hasOwn(tables, role)) return { error: 'Choose Student or Teacher/Admin.' };
    if (typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      return { error: 'Enter a valid email address.' };
    }
    if (typeof password !== 'string' || password.length < 8 || Buffer.byteLength(password, 'utf8') > 72) {
      return { error: 'Password must be at least 8 characters and at most 72 UTF-8 bytes.' };
    }
    return { role, email: email.trim().toLowerCase(), password };
  }

  app.post('/api/auth/register', authLimiter, async (req, res) => {
    const input = credentials(req.body);
    if (input.error) return res.status(400).json({ error: input.error });
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    if (!name || name.length > 100) return res.status(400).json({ error: 'Name must contain 1 to 100 characters.' });
    const hash = await bcrypt.hash(input.password, 12);
    let result;
    try {
      result = db.prepare(`INSERT INTO ${tables[input.role]} (name, email, password_hash) VALUES (?, ?, ?)`)
        .run(name, input.email, hash);
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'This email is already registered for this role.' });
      throw error;
    }
    const user = { id: Number(result.lastInsertRowid), name, email: input.email, role: input.role };
    await signIn(req, user);
    res.status(201).json({ user, csrfToken: csrfToken(req) });
  });

  app.post('/api/auth/login', authLimiter, async (req, res) => {
    const input = credentials(req.body);
    if (input.error) return res.status(400).json({ error: input.error });
    const row = db.prepare(`SELECT * FROM ${tables[input.role]} WHERE email = ?`).get(input.email);
    const matches = await bcrypt.compare(input.password, row?.password_hash || dummyHash);
    if (!row || !matches) return res.status(401).json({ error: 'Email or password is incorrect for the selected role.' });
    const user = { id: row.id, name: row.name, email: row.email, role: input.role };
    await signIn(req, user);
    res.json({ user, csrfToken: csrfToken(req) });
  });

  app.get('/api/auth/me', requireUser(), (req, res) => res.json({ user: req.user, csrfToken: csrfToken(req) }));
  app.post('/api/auth/logout', (req, res, next) => {
    const sid = req.sessionID;
    req.session.destroy(error => {
      if (error) return next(error);
      realtime?.revoke(sid);
      res.clearCookie(cookieName, { httpOnly: true, sameSite: 'lax', secure: production });
      res.json({ message: 'Logged out.' });
    });
  });

  app.get('/api/classes', requireUser('teacher'), (req, res) => {
    const classes = db.prepare(`SELECT c.id, c.title, c.code, c.created_at,
      (SELECT s.id FROM sessions s WHERE s.class_id = c.id AND s.status = 'live') AS live_session_id,
      EXISTS(SELECT 1 FROM sessions s WHERE s.class_id = c.id) AS has_sessions
      FROM classes c WHERE c.teacher_id = ? ORDER BY c.id DESC`).all(req.user.id);
    res.json({ classes });
  });
  app.get('/api/classes/:id', requireUser('teacher'), (req, res) => {
    const classroom = db.prepare('SELECT id, title, code, created_at FROM classes WHERE id = ? AND teacher_id = ?')
      .get(req.params.id, req.user.id);
    if (!classroom) return res.status(404).json({ error: 'Class not found.' });
    res.json({ class: classroom });
  });
  app.post('/api/classes', requireUser('teacher'), (req, res) => {
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    if (!title || title.length > 100) return res.status(400).json({ error: 'Class title must contain 1 to 100 characters.' });
    for (let attempt = 0; attempt < 10; attempt++) {
      const code = Array.from({ length: 6 }, () => codeAlphabet[crypto.randomInt(codeAlphabet.length)]).join('');
      try {
        const result = db.prepare('INSERT INTO classes (teacher_id, title, code) VALUES (?, ?, ?)').run(req.user.id, title, code);
        const classroom = db.prepare('SELECT id, title, code, created_at FROM classes WHERE id = ?').get(result.lastInsertRowid);
        return res.status(201).json({ class: classroom });
      } catch (error) {
        if (error.code !== 'SQLITE_CONSTRAINT_UNIQUE') throw error;
      }
    }
    res.status(503).json({ error: 'Could not allocate a class code. Please try again.' });
  });
  app.delete('/api/classes/:id', requireUser('teacher'), (req, res) => {
    try {
      const result = db.prepare('DELETE FROM classes WHERE id = ? AND teacher_id = ?')
        .run(req.params.id, req.user.id);
      if (!result.changes) return res.status(404).json({ error: 'Class not found.' });
      res.json({ message: 'Class deleted.' });
    } catch (error) {
      if (error.code === 'SQLITE_CONSTRAINT_FOREIGNKEY' ||
          (error.code === 'SQLITE_CONSTRAINT_TRIGGER' && error.message === 'FOREIGN KEY constraint failed')) {
        return res.status(409).json({ error: 'This class has linked records and cannot be deleted.' });
      }
      throw error;
    }
  });

  app.post('/api/classes/:id/sessions', requireUser('teacher'), (req, res) => {
    const session = presence.start(req.params.id, req.user.id);
    realtime?.notifySessions(session.id);
    res.status(201).json({ session });
  });
  app.get('/api/sessions', requireUser(), (req, res) => res.json({ sessions: presence.list(req.user) }));
  app.get('/api/sessions/:id', requireUser(), (req, res) => res.json(presence.snapshot(req.params.id, req.user)));
  app.delete('/api/sessions/:id', requireUser('teacher'), (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid session.' });
    if (req.body?.confirm !== true) return res.status(400).json({ error: 'Confirm permanent deletion of this session and its saved results.' });
    const deleted = presence.deleteEnded(id, req.user.id);
    realtime?.sessionDeleted(deleted);
    res.json({ message: 'Session and saved presence results permanently deleted.', sessionId: id });
  });
  app.post('/api/meet/classes/:id/sessions', requireUser('teacher'), (req, res) => {
    const id = presence.meet.start(req.params.id, req.user.id, req.body?.meetCode);
    realtime?.notifySessions(id);
    res.status(201).json({ session: presence.session(id) });
  });
  app.get('/api/meet/live/:code', requireUser(), (req, res) => {
    const session = presence.meet.live(req.params.code);
    res.json({ session });
  });
  app.post('/api/meet/sessions/:id/join', requireUser('student'), (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid session.' });
    presence.meet.enroll(id, req.user.id, req.body?.meetCode, req.body?.sourceId, () => presence.checkpoint(id));
    realtime?.notifySessions(id);
    res.json(presence.snapshot(id, req.user));
  });
  const observationLimiter = enableRateLimit ? rateLimit({
    windowMs: 60_000, limit: 240, standardHeaders: 'draft-8', legacyHeaders: false,
    keyGenerator: req => `student:${req.user.id}`,
    message: { error: 'Too many call observations. Retrying shortly.' }
  }) : (req, res, next) => next();
  app.post('/api/meet/sessions/:id/observe', requireUser('student'), observationLimiter, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid session.' });
    presence.authorize(id, req.user);
    presence.requireLive(id);
    presence.meet.observe(id, req.user.id, req.body, () => presence.checkpoint(id));
    res.json(presence.snapshot(id, req.user));
  });
  app.post('/api/sessions/:id/end', requireUser('teacher'), (req, res) => {
    const session = presence.end(req.params.id, req.user.id);
    realtime?.publish(session.id);
    realtime?.notifySessions(session.id);
    res.json(presence.snapshot(session.id, req.user));
  });

  for (const role of ['student', 'teacher']) {
    app.get(`/${role}.html`, (req, res) => {
      const user = account(req);
      res.set('Cache-Control', 'no-store');
      if (!user) return res.redirect(`/auth.html?role=${role}`);
      if (user.role !== role) return res.redirect(`/${user.role}.html`);
      res.sendFile(path.join(publicPath, `${role}.html`));
    });
  }
  app.use('/api', (req, res) => res.status(404).json({ error: 'API endpoint not found.' }));
  app.use(express.static(publicPath, { extensions: false }));
  app.use((req, res) => res.status(404).type('text').send('Page not found.'));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request body must be valid JSON.' });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Request body is too large.' });
    if (error.status && error.status >= 400 && error.status < 500) return res.status(error.status).json({ error: error.message });
    console.error(error);
    res.status(500).json({ error: 'The request could not be completed. Please try again.' });
  });

  return {
    app, db, presence,
    attach(server) {
      if (realtime) throw new Error('Real-time server already attached.');
      realtime = attachRealtime(server, { presence, sessionMiddleware, account, store, now });
      return realtime;
    },
    stopRealtime() {
      stopping = true;
      if (realtime) realtime.close();
      else presence.shutdown();
    },
    close() {
      this.stopRealtime();
      store.close(); db.close();
    }
  };
}

module.exports = { createApp };
