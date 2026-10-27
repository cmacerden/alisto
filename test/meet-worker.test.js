const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { meetCodeFromUrl, meetTabContext, verifiedMeetSample } = require('../extension/meet');

function worker(options = {}) {
  let saved = structuredClone(options.saved || {});
  let time = options.time ?? 100000;
  let user = { id: 1, role: 'student' };
  let nextSource = 0;
  const events = {};
  const calls = [];
  let requestHandler;
  const tabs = new Map([[10, { id: 10, url: 'https://meet.google.com/abc-defg-hij', state: 'in' }],
    [11, { id: 11, url: 'https://meet.google.com/abc-defg-hij', state: 'out' }]]);
  const context = vm.createContext({
    console, importScripts() {}, meetCodeFromUrl, meetTabContext, verifiedMeetSample,
    crypto: { randomUUID: () => `profile_source_${++nextSource}_12345678` },
    Date: class extends Date { static now() { return time; } },
    createExtensionApi: () => ({ async request(url, options) {
       calls.push({ url, options: options ? structuredClone(options) : undefined });
       if (requestHandler) {
         const result = await requestHandler(url, options);
         if (result !== undefined) return result;
       }
      if (url === '/api/auth/me') return { user };
      if (url.startsWith('/api/meet/live/')) return { session: { id: 7 } };
      return {};
    } }),
    chrome: {
      sidePanel: { setPanelBehavior: async () => {} },
      storage: { session: {
        get: async () => structuredClone(saved), set: async value => { saved = structuredClone(value); }
      } },
      runtime: { id: 'test-extension', getURL: value => `chrome-extension://test-extension/${value}`,
        onMessage: { addListener: fn => { events.message = fn; } } },
      tabs: {
        get: async id => { if (!tabs.has(id)) throw new Error('No tab'); return tabs.get(id); },
        sendMessage: async (id, message, options) => {
          const tab = tabs.get(id);
          if (!tab || tab.noScript || options?.documentId === 'old-document') throw new Error('No content script');
          const pageUrl = tab.pageUrl || tab.url;
          return { meetCode: meetCodeFromUrl(pageUrl), pageUrl, state: tab.state };
        },
        onRemoved: { addListener: fn => { events.remove = fn; } },
        onUpdated: { addListener: fn => { events.update = fn; } }
      }
    }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/background.js'), 'utf8'), context);
  const panel = { id: 'test-extension', url: 'chrome-extension://test-extension/panel.html' };
  function dispatch(message, sender = panel) {
    return new Promise(resolve => {
      const pending = events.message(message, sender, resolve);
      if (pending !== true) resolve(undefined);
    });
  }
  return {
    tabs, calls, events, dispatch,
    saved: () => saved,
    advance(ms) { time += ms; },
    user(identity) { user = identity; },
    handle(fn) { requestHandler = fn; },
    observe: (tab = 10, overrides = {}) => {
      const url = overrides.url ?? tabs.get(tab)?.url;
      return dispatch({ type: 'ALISTO_MEET_OBSERVATION', meetCode: meetCodeFromUrl(url) || 'abc-defg-hij', state: 'in' },
        { id: 'test-extension', url, tab: { id: tab }, frameId: 0, documentId: 'current-document', ...overrides });
    },
    observations: () => calls.filter(call => call.url.endsWith('/observe')),
    idle: () => vm.runInContext('queue', context)
  };
}

test('worker requires explicit student connection, validates sender, and never treats untracked tabs as attendance', async () => {
  const w = worker();
  await w.observe();
  assert.equal(w.observations().length, 0);
  assert.equal(await w.dispatch({ type: 'ALISTO_MEET_TRACK', tabId: 10 }, { id: 'evil-extension', url: 'https://evil.example' }), undefined);
  const tracked = await w.dispatch({ type: 'ALISTO_MEET_TRACK', tabId: 10 });
  assert.equal(tracked.ok, true);
  assert.equal(tracked.data.sessionId, 7);
  assert.equal(w.observations().at(-1).options.body.state, 'in');
  const count = w.observations().length;
  await w.observe(10, { frameId: 1 });
  await w.observe(10, { id: 'evil-extension' });
  assert.equal(w.observations().length, count);
  const stored = JSON.stringify(w.saved());
  assert.ok(!/password|csrf|cookie|token|email/i.test(stored));
});

test('worker refuses teacher tracking and non-Meet tabs', async () => {
  const w = worker();
  w.user({ id: 1, role: 'teacher' });
  assert.equal((await w.dispatch({ type: 'ALISTO_MEET_TRACK', tabId: 10 })).ok, false);
  w.tabs.set(12, { id: 12, url: 'https://evil.example/abc-defg-hij' });
  assert.equal((await w.dispatch({ type: 'ALISTO_MEET_TRACK', tabId: 12 })).ok, false);
  assert.equal(w.observations().length, 0);
});

test('worker aggregates same-room tabs once and continues when the sidebar is closed', async () => {
  const w = worker();
  await w.dispatch({ type: 'ALISTO_MEET_TRACK', tabId: 10 });
  await w.dispatch({ type: 'ALISTO_MEET_TRACK', tabId: 11 });
  assert.equal(w.observations().at(-1).options.body.state, 'in');
  const ids = w.observations().map(call => call.options.body.sourceId);
  assert.equal(new Set(ids).size, 1);
  w.tabs.get(10).state = 'out'; await w.observe(10);
  assert.equal(w.observations().at(-1).options.body.state, 'out');
  // No panel action: content-script messages alone refresh call evidence.
  w.tabs.get(11).state = 'in'; await w.observe(11);
  assert.equal(w.observations().at(-1).options.body.state, 'in');
});

test('worker sends Cannot verify for refreshed/destroyed documents and expired local evidence', async () => {
  const w = worker();
  await w.dispatch({ type: 'ALISTO_MEET_TRACK', tabId: 10 });
  await w.observe(10, { documentId: 'old-document' });
  assert.equal(w.observations().at(-1).options.body.state, 'unknown');
  w.events.update(10, { status: 'loading' }); await w.idle();
  assert.equal(w.observations().at(-1).options.body.state, 'unknown');
  w.tabs.get(10).noScript = true;
  const tracked = await w.dispatch({ type: 'ALISTO_MEET_TRACK', tabId: 10 });
  assert.equal(tracked.data.needsReload, true);
  assert.equal(w.observations().at(-1).options.body.state, 'unknown');
  w.tabs.get(10).noScript = false;
  await w.dispatch({ type: 'ALISTO_MEET_TRACK', tabId: 10 });
  await w.dispatch({ type: 'ALISTO_MEET_TRACK', tabId: 11 });
  w.advance(13000); await w.observe(11);
  assert.equal(w.observations().at(-1).options.body.state, 'unknown');
});

test('worker rechecks account identity before observations and removes stale account bindings', async () => {
  const w = worker();
  await w.dispatch({ type: 'ALISTO_MEET_TRACK', tabId: 10 });
  const before = w.observations().length;
  w.user({ id: 2, role: 'student' }); await w.observe();
  assert.equal(w.observations().length, before);
  assert.equal(Object.keys(w.saved().meetTrackingV1).length, 0);
});

test('closing one tracked Meet tab does not override another fresh in-call tab', async () => {
  const w = worker();
  await w.dispatch({ type: 'ALISTO_MEET_TRACK', tabId: 10 });
  w.tabs.get(11).state = 'in'; await w.dispatch({ type: 'ALISTO_MEET_TRACK', tabId: 11 });
  w.tabs.delete(10); w.events.remove(10); await w.idle();
  assert.equal(w.observations().at(-1).options.body.state, 'in');
  w.tabs.delete(11); w.events.remove(11); await w.idle();
  assert.equal(w.observations().at(-1).options.body.state, 'out');
  await w.dispatch({ type: 'ALISTO_MEET_RESET' });
  assert.equal(Object.keys(w.saved().meetTrackingV1).length, 0);
});

test('closed tabs do not leave permanent unknown siblings when another tab still reports out-of-call', async () => {
  const w = worker();
  await w.dispatch({ type: 'ALISTO_MEET_TRACK', tabId: 10 });
  await w.dispatch({ type: 'ALISTO_MEET_TRACK', tabId: 11 });
  w.tabs.delete(10); w.events.remove(10); await w.idle();
  w.advance(13000); await w.observe(11);
  assert.equal(w.observations().at(-1).options.body.state, 'out');
});

test('worker can enroll and refresh evidence for a real Meet document when tab URL is withheld', async () => {
  const w = worker();
  w.tabs.set(10, { id: 10, pageUrl: 'https://meet.google.com/abc-defg-hij', state: 'in' });
  const tracked = await w.dispatch({ type: 'ALISTO_MEET_TRACK', tabId: 10 });
  assert.equal(tracked.ok, true);
  assert.equal(w.observations().at(-1).options.body.state, 'in');
  w.tabs.get(10).state = 'out';
  await w.observe(10, { url: 'https://meet.google.com/abc-defg-hij' });
  assert.equal(w.observations().at(-1).options.body.state, 'out');
  await w.observe(10, { url: 'https://meet.google.com/abc-defg-hij', documentId: 'old-document' });
  assert.equal(w.observations().at(-1).options.body.state, 'unknown');
});

test('worker rejects withheld URLs without valid Meet-page proof instead of substituting a teacher code', async () => {
  const w = worker();
  w.tabs.set(10, { id: 10, pageUrl: 'https://example.com/abc-defg-hij', state: 'in' });
  assert.equal((await w.dispatch({ type: 'ALISTO_MEET_TRACK', tabId: 10 })).ok, false);
  assert.equal(w.observations().length, 0);
  assert.equal(w.calls.length, 0);
});

test('worker enrolls the reported /meet/code room and accepts current-document observations for it', async () => {
  const w = worker();
  w.tabs.set(10, { id: 10, url: 'https://meet.google.com/meet/bjt-yrbc-qqt', state: 'in' });
  const tracked = await w.dispatch({ type: 'ALISTO_MEET_TRACK', tabId: 10 });
  assert.equal(tracked.ok, true);
  assert.ok(w.calls.some(call => call.url === '/api/meet/live/bjt-yrbc-qqt'));
  assert.equal(w.observations().at(-1).options.body.meetCode, 'bjt-yrbc-qqt');
  w.tabs.get(10).state = 'out'; await w.observe();
  assert.equal(w.observations().at(-1).options.body.state, 'out');
});

test('worker resumes persisted bindings without crediting stale sibling evidence after suspension', async () => {
  const original = worker();
  await original.dispatch({ type: 'ALISTO_MEET_TRACK', tabId: 10 });
  await original.dispatch({ type: 'ALISTO_MEET_TRACK', tabId: 11 });
  const source = original.observations().at(-1).options.body.sourceId;
  const resumed = worker({ saved: original.saved(), time: 200000 });
  await resumed.observe(11);
  assert.equal(resumed.observations().at(-1).options.body.state, 'unknown');
  assert.equal(resumed.observations().at(-1).options.body.sourceId, source);
  assert.equal(resumed.calls.filter(call => call.url.endsWith('/join')).length, 0);
  await resumed.observe(10);
  assert.equal(resumed.observations().at(-1).options.body.state, 'in');
});

test('worker survives a backend outage and resamples without losing its source or inventing fresh queued evidence', async () => {
  const w = worker(); await w.dispatch({ type: 'ALISTO_MEET_TRACK', tabId: 10 });
  const source = w.observations().at(-1).options.body.sourceId;
  w.handle(url => { if (url.endsWith('/observe')) throw new Error('Backend unavailable'); });
  assert.equal((await w.observe()).ok, false);
  assert.equal(Object.keys(w.saved().meetTrackingV1).length, 1);
  w.advance(20000); w.handle(null); w.tabs.get(10).state = 'out';
  assert.equal((await w.observe()).ok, true);
  assert.equal(w.observations().at(-1).options.body.sourceId, source);
  assert.equal(w.observations().at(-1).options.body.state, 'out');
});

test('a queued content message ages into unknown instead of renewing in-call evidence', async () => {
  const w = worker(); await w.dispatch({ type: 'ALISTO_MEET_TRACK', tabId: 10 });
  let finish;
  w.handle(url => url === '/api/auth/me' ? new Promise(resolve => { finish = resolve; }) : undefined);
  const first = w.observe();
  await new Promise(resolve => setImmediate(resolve));
  const queued = w.observe(); w.advance(20000); w.handle(null);
  finish({ user: { id: 1, role: 'student' } });
  await first; await queued;
  assert.equal(w.observations().at(-1).options.body.state, 'unknown');
});
