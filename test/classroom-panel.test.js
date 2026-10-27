const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { formatDuration } = require('../extension/time');

// Minimal DOM adapter: exercise the actual panel controller without Chrome or
// a new browser-test dependency. Real layout/HTML escaping is checked in preview.
function fixture() {
  const elements = new Map(); const timers = []; const errors = []; const requests = [];
  let at = 0; let user = { id: 1, role: 'student' }; let handler;
  function element() {
    return { hidden: false, disabled: false, value: '', textContent: '', children: [],
      scrollTop: 0, clientHeight: 100, scrollHeight: 100, events: {}, attributes: {},
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
      addEventListener(type, callback) { this.events[type] = callback; }, reset() {},
      setAttribute(name, value) { this.attributes[name] = value; }, focus() { this.focused = true; } };
  }
  const get = selector => {
    if (!elements.has(selector)) elements.set(selector, element());
    return elements.get(selector);
  };
  const forms = ['[data-message-form]', '[data-prompt-form]', '[data-response-form]'];
  const controls = ['[name="message"]', '[name="prompt"]', '[name="minutes"]', '[name="response"]', '[name="visibility"]',
    '[data-message-form] button', '[data-prompt-form] button', '[data-response-form] button', '[data-close-prompt]'];
  get('[data-message-form]').reset = () => { get('[name="message"]').value = ''; };
  get('[data-prompt-form]').reset = () => { get('[name="prompt"]').value = ''; get('[name="minutes"]').value = '1'; };
  get('[data-response-form]').reset = () => { get('[name="response"]').value = ''; get('[name="visibility"]').value = 'everyone'; };
  const root = { ...element(), querySelector: get, querySelectorAll: selector => (selector === 'form' ? forms : controls).map(get) };
  const document = { querySelector: selector => selector === '#root' ? root : { content: { cloneNode: () => ({}) } }, createElement: element };
  const api = { async request(url, options) { requests.push({ url, options }); return handler(url, options); } };
  const context = vm.createContext({ document, formatDuration, performance: { now: () => at }, setInterval: callback => { timers.push(callback); } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../extension/classroom.js'), 'utf8'), context);
  const panel = context.createClassroomPanel({ container: '#root', api, getUser: () => user, onError: error => errors.push(error) });
  function snapshot(overrides = {}) {
    return { session_id: 7, session_status: 'live', viewer: { id: 1, role: 'student' }, server_time: 100000,
      messages: [], prompts: [{ id: 1, body: 'Question', sender_name: 'Teacher', created_at: 100000,
        open: true, remaining_ms: 60000, eligible: true, responded: false, responses: [] }],
      self: { participation_rate: 0, classification: 'No Participation', responded_count: 0, eligible_count: 1 }, ...overrides };
  }
  handler = () => snapshot();
  return { panel, root, get, errors, requests, snapshot,
    handle(fn) { handler = fn; }, user(value) { user = value; }, tick(ms) { at += ms; timers.forEach(callback => callback()); },
    submit(selector) { get(selector).events.submit({ preventDefault() {} }); },
    async settle() { await new Promise(resolve => setImmediate(resolve)); } };
}

test('classroom UI preserves drafts during refresh, resets visibility for a new prompt, and submits the selected visibility', async () => {
  const f = fixture(); await f.panel.refresh(7);
  assert.equal(f.get('[name="visibility"]').value, 'everyone');
  f.get('[name="response"]').value = 'Draft'; f.get('[name="visibility"]').value = 'teacher';
  await f.panel.refresh(7);
  assert.equal(f.get('[name="response"]').value, 'Draft');
  assert.equal(f.get('[name="visibility"]').value, 'teacher');
  f.submit('[data-response-form]'); await f.settle();
  const sent = f.requests.find(request => request.options?.method === 'POST');
  assert.equal(sent.url, '/api/sessions/7/prompts/1/respond');
  assert.equal(sent.options.body.visibility, 'teacher');
  assert.equal(sent.options.body.body, 'Draft');
  const next = f.snapshot(); next.prompts[0].id = 2;
  f.handle(() => next); await f.panel.refresh(7);
  assert.equal(f.get('[name="visibility"]').value, 'everyone');
  assert.equal(f.get('[name="response"]').value, '');
});

test('Overview hides chats by default; tab switching preserves drafts and the selected view through polling', async () => {
  const f = fixture(); await f.panel.refresh(7);
  assert.equal(f.get('[data-tab-panel="overview"]').hidden, false);
  assert.equal(f.get('[data-tab-panel="general"]').hidden, true);
  assert.equal(f.get('[data-tab-panel="participation"]').hidden, true);
  assert.equal(f.get('[data-tab="overview"]').attributes['aria-selected'], 'true');
  f.get('[data-tab="participation"]').events.click();
  f.get('[name="response"]').value = 'Draft in separate tab';
  assert.equal(f.get('[data-tab-panel="overview"]').hidden, true);
  assert.equal(f.get('[data-tab-panel="participation"]').hidden, false);
  f.get('[data-tab="general"]').events.click();
  assert.equal(f.get('[data-tab-panel="participation"]').hidden, true);
  assert.equal(f.get('[data-tab-panel="general"]').hidden, false);
  await f.panel.refresh(7);
  assert.equal(f.get('[data-tab-panel="general"]').hidden, false);
  assert.equal(f.get('[name="response"]').value, 'Draft in separate tab');
  f.get('[data-tab="participation"]').events.click();
  assert.equal(f.get('[name="response"]').value, 'Draft in separate tab');
  f.panel.reset();
  assert.equal(f.get('[data-tab-panel="overview"]').hidden, false);
  assert.equal(f.get('[data-tab-panel="participation"]').hidden, true);
  assert.equal(f.get('[name="response"]').value, '');
});

test('classroom tabs support arrow/Home/End navigation and linked tab/panel IDs', async () => {
  const f = fixture(); await f.panel.refresh(7);
  let prevented = false;
  f.get('[data-tab="overview"]').events.keydown({ key: 'ArrowRight', preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(f.get('[data-tab="general"]').focused, true);
  assert.equal(f.get('[data-tab="general"]').tabIndex, 0);
  assert.equal(f.get('[data-tab="overview"]').tabIndex, -1);
  f.get('[data-tab="general"]').events.keydown({ key: 'End', preventDefault() {} });
  assert.equal(f.get('[data-tab-panel="participation"]').hidden, false);
  f.get('[data-tab="participation"]').events.keydown({ key: 'Home', preventDefault() {} });
  assert.equal(f.get('[data-tab-panel="overview"]').hidden, false);
  assert.equal(f.get('[data-tab="overview"]').attributes['aria-controls'], 'root-overview-panel');
  assert.equal(f.get('[data-tab-panel="overview"]').attributes['aria-labelledby'], 'root-overview-tab');
});

test('classroom countdown uses H:MM:SS, hides expired response forms, and disables stale live controls', async () => {
  const f = fixture(); await f.panel.refresh(7);
  assert.equal(f.get('[data-countdown]').textContent, 'Time remaining: 0:01:00');
  f.tick(16000);
  assert.equal(f.get('[data-message-form] button').disabled, true);
  assert.match(f.get('[data-chat-status]').textContent, /stale/);
  f.tick(44000);
  assert.equal(f.get('[data-countdown]').textContent, 'Prompt closed');
  assert.equal(f.get('[data-response-form]').hidden, true);
  f.submit('[data-response-form]'); await f.settle();
  assert.equal(f.requests.filter(request => request.options?.method === 'POST').length, 0);
});

test('saved classroom stays read-only and never becomes stale while the page remains open', async () => {
  const f = fixture();
  const saved = f.snapshot({ session_status: 'ended' }); saved.prompts[0].open = false; saved.prompts[0].remaining_ms = 0;
  f.handle(() => saved); await f.panel.refresh(7); f.tick(600000);
  assert.equal(f.get('[data-chat-status]').textContent, 'Saved chat and participation · read only');
  assert.equal(f.get('[data-message-form]').hidden, true);
  assert.equal(f.get('[data-response-form]').hidden, true);
});

test('logout/reset and switching sessions discard delayed private snapshots and drafts', async () => {
  const f = fixture(); let resolve;
  f.handle(() => new Promise(done => { resolve = done; }));
  const pending = f.panel.refresh(7); f.panel.reset(); resolve(f.snapshot()); await pending;
  assert.equal(f.root.hidden, true);
  assert.equal(f.get('[data-prompts]').children.length, 0);
  f.handle(() => f.snapshot()); await f.panel.refresh(7);
  f.get('[name="response"]').value = 'Private draft';
  f.handle(() => f.snapshot({ session_id: 8 })); await f.panel.refresh(8);
  assert.equal(f.get('[name="response"]').value, '');
  assert.equal(f.get('[name="visibility"]').value, 'everyone');
});

test('a mismatched shared-profile account snapshot is discarded, not rendered under the previous user', async () => {
  const f = fixture();
  f.handle(() => f.snapshot({ viewer: { id: 2, role: 'student' } }));
  await f.panel.refresh(7);
  assert.equal(f.root.hidden, true);
  assert.equal(f.get('[data-prompts]').children.length, 0);
});

test('failed submissions preserve drafts for retry and report the error', async () => {
  const f = fixture(); await f.panel.refresh(7);
  f.get('[name="response"]').value = 'Keep my answer';
  f.handle((url, options) => { if (options?.method === 'POST') throw new Error('Network failed'); return f.snapshot(); });
  f.submit('[data-response-form]'); await f.settle();
  assert.equal(f.get('[name="response"]').value, 'Keep my answer');
  assert.equal(f.errors[0].message, 'Network failed');
});

test('a delayed live snapshot cannot renew freshness or extend the displayed prompt deadline', async () => {
  const f = fixture(); let finish;
  f.handle(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.panel.refresh(7);
  f.tick(20000); finish(f.snapshot()); await pending;
  assert.equal(f.get('[data-countdown]').textContent, 'Time remaining: 0:00:40');
  assert.equal(f.get('[data-message-form] button').disabled, true);
  assert.match(f.get('[data-chat-status]').textContent, /stale/);
});

test('reset/reopen isolates an old submission from a fresh context even with the same account/session', async () => {
  const f = fixture(); await f.panel.refresh(7); let finish;
  f.get('[name="message"]').value = 'Old context message';
  f.handle((url, options) => options?.method === 'POST' ? new Promise(resolve => { finish = resolve; }) : f.snapshot());
  f.submit('[data-message-form]');
  f.panel.reset(); await f.panel.refresh(7);
  assert.equal(f.get('[data-message-form] button').disabled, false);
  f.get('[name="message"]').value = 'New context draft';
  const count = f.requests.length;
  finish({ id: 1 }); await f.settle();
  assert.equal(f.get('[name="message"]').value, 'New context draft');
  assert.equal(f.requests.length, count); // No stale refresh of the reopened view.
});

test('an old submission completion cannot enable controls while a new-context write is pending', async () => {
  const f = fixture(); await f.panel.refresh(7); const finishes = [];
  f.handle((url, options) => options?.method === 'POST' ? new Promise(resolve => finishes.push(resolve)) : f.snapshot());
  f.get('[name="message"]').value = 'First'; f.submit('[data-message-form]');
  f.panel.reset(); await f.panel.refresh(7);
  f.get('[name="message"]').value = 'Second'; f.submit('[data-message-form]');
  assert.equal(finishes.length, 2);
  finishes[0]({}); await f.settle();
  assert.equal(f.get('[data-message-form] button').disabled, true);
  finishes[1]({}); await f.settle();
  assert.equal(f.get('[data-message-form] button').disabled, false);
});
