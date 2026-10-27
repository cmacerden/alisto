// UI-only preview with mocked Chrome APIs and an isolated in-memory backend.
// This does not test Chrome extension permissions, cookies, or sidePanel APIs.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const bcrypt = require('bcryptjs');
const { createApp } = require('../lib/app');

const runtime = createApp({
  databasePath: ':memory:', sessionSecret: 'extension-preview-only-secret-at-least-32-characters',
  cookieName: 'alisto.extension-preview.sid', enableRateLimit: false,
  reportMailer: { async send() {
    return { mode: 'preview', message: 'Mocked preview only — no email was generated or delivered. Real SMTP/Ethereal is not used by this UI preview.' };
  } }
});
const hash = bcrypt.hashSync('ExtensionTest123!', 12);
runtime.db.prepare('INSERT INTO teachers (id, name, email, password_hash) VALUES (1, ?, ?, ?)')
  .run('Preview Teacher', 'teacher@preview.example', hash);
runtime.db.prepare('INSERT INTO students (id, name, email, password_hash) VALUES (1, ?, ?, ?)')
  .run('Preview Student', 'student@preview.example', hash);
runtime.db.prepare('INSERT INTO classes (id, teacher_id, title, code) VALUES (1, 1, ?, ?)')
  .run('Preview Computing', 'ABC234');
const session = runtime.presence.start(1, 1);
runtime.presence.connect(session.id, 1, 'preview-only');
runtime.presence.end(session.id, 1);

function fixture() {
  window.fixtureMeetUrl = 'https://meet.google.com/abc-defg-hij';
  window.fixturePageUrl = window.fixtureMeetUrl;
  window.fixtureEvents = {};
  window.fixtureCallState = 'in';
  window.chrome = { tabs: {
    query: async () => [{ id: 10, url: window.fixtureMeetUrl }],
    get: async () => ({ id: 10, url: window.fixtureMeetUrl }),
    sendMessage: async () => ({ meetCode: meetCodeFromUrl(window.fixturePageUrl),
      pageUrl: window.fixturePageUrl, state: window.fixtureCallState }),
    onActivated: { addListener: fn => { window.fixtureEvents.activate = fn; } },
    onUpdated: { addListener: fn => { window.fixtureEvents.update = fn; } }
  }, runtime: { async sendMessage(message) {
    if (message.type === 'ALISTO_MEET_RESET') { window.fixtureTracking = null; return { ok: true }; }
    if (message.type !== 'ALISTO_MEET_TRACK') return { ok: false, error: 'Unsupported preview message.' };
    try {
      const api = createExtensionApi();
      const { meetCode: code } = await meetTabContext(await chrome.tabs.get(message.tabId), chrome.tabs);
      const { session } = await api.request(`/api/meet/live/${code}`);
      const source = { meetCode: code, sourceId: 'preview_profile_12345678' };
      await api.request(`/api/meet/sessions/${session.id}/join`, { method: 'POST', body: source });
      window.fixtureTracking = { id: session.id, source };
      await api.request(`/api/meet/sessions/${session.id}/observe`, { method: 'POST', body: { ...source, state: window.fixtureCallState } });
      return { ok: true, data: { sessionId: session.id, needsReload: false } };
    } catch (error) { return { ok: false, error: error.message }; }
  } } };
  const originalFetch = window.fetch.bind(window);
  window.fixtureRequests = [];
  window.fetch = (url, options) => {
    window.fixtureRequests.push({ path: new URL(url, location.href).pathname, method: options?.method || 'GET' });
    return originalFetch(url.replace('http://localhost:3000', location.origin), options);
  };
  setInterval(async () => {
    if (!window.fixtureTracking) return;
    const { id, source } = window.fixtureTracking;
    try {
      await createExtensionApi().request(`/api/meet/sessions/${id}/observe`, { method: 'POST', body: { ...source, state: window.fixtureCallState } });
    } catch { window.fixtureTracking = null; }
  }, 5000);
}

const root = path.join(__dirname, '../extension');
const app = express();
app.get('/fixture.js', (req, res) => res.type('js').send(`(${fixture.toString()})();`));
app.get('/panel.html', (req, res) => res.type('html').send(
  fs.readFileSync(path.join(root, 'panel.html'), 'utf8')
    .replace('<head>', '<head><script src="/fixture.js"></script>')
));
app.use(express.static(root));
app.use(runtime.app);
const server = http.createServer(app);
server.listen(3002, '127.0.0.1', () => {
  console.log('UI preview only (mocked Chrome): http://127.0.0.1:3002/panel.html');
  console.log('Preview accounts: teacher@preview.example or student@preview.example; password: ExtensionTest123!');
  console.log('In-memory preview data only. Actual application accounts/database are not used.');
});
server.on('error', error => { console.error(error.message); runtime.close(); process.exitCode = 1; });
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close(() => { runtime.close(); process.exit(0); });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
