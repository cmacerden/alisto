const session = require('express-session');

const MAX_AGE = 8 * 60 * 60 * 1000;

class SQLiteSessionStore extends session.Store {
  constructor(db) {
    super();
    this.db = db;
    this.cleanup = setInterval(() => {
      db.prepare('DELETE FROM login_sessions WHERE expires_at <= ?').run(Date.now());
    }, 15 * 60 * 1000);
    this.cleanup.unref();
  }

  get(sid, callback) {
    try {
      const row = this.db.prepare('SELECT data FROM login_sessions WHERE sid = ? AND expires_at > ?')
        .get(sid, Date.now());
      callback(null, row ? JSON.parse(row.data) : null);
    } catch (error) { callback(error); }
  }

  set(sid, value, callback = () => {}) {
    try {
      const expires = value.cookie?.expires ? new Date(value.cookie.expires).getTime() : Date.now() + MAX_AGE;
      this.db.prepare(`INSERT INTO login_sessions (sid, data, expires_at) VALUES (?, ?, ?)
        ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at`)
        .run(sid, JSON.stringify(value), expires);
      callback(null);
    } catch (error) { callback(error); }
  }

  touch(sid, value, callback = () => {}) {
    try {
      const expires = value.cookie?.expires ? new Date(value.cookie.expires).getTime() : Date.now() + MAX_AGE;
      this.db.prepare('UPDATE login_sessions SET expires_at = ? WHERE sid = ?').run(expires, sid);
      callback(null);
    } catch (error) { callback(error); }
  }

  destroy(sid, callback = () => {}) {
    try {
      this.db.prepare('DELETE FROM login_sessions WHERE sid = ?').run(sid);
      callback(null);
    } catch (error) { callback(error); }
  }

  close() { clearInterval(this.cleanup); }
}

module.exports = { SQLiteSessionStore, MAX_AGE };
