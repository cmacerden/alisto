const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { meetCodeFromUrl, meetCodeFromInput, currentMeetTab, meetTabContext, verifiedMeetSample, findMeetTabs } = require('../extension/meet');

test('Meet URL parsing also recognizes an explicit Google account route without accepting arbitrary nested paths', () => {
  assert.equal(meetCodeFromUrl('https://meet.google.com/u/0/abc-defg-hij?authuser=1'), 'abc-defg-hij');
  assert.equal(meetCodeFromUrl('https://meet.google.com/u/12/abc-defg-hij/'), 'abc-defg-hij');
  assert.equal(meetCodeFromUrl('https://meet.google.com/other/abc-defg-hij'), null);
  assert.equal(meetCodeFromUrl('https://meet.google.com/u/name/abc-defg-hij'), null);
});

test('reported /meet/code address is recognized without relaxing host or path validation', () => {
  const reported = 'https://meet.google.com/meet/bjt-yrbc-qqt';
  assert.equal(meetCodeFromUrl(reported), 'bjt-yrbc-qqt');
  assert.equal(meetCodeFromUrl(`${reported}/?authuser=1`), 'bjt-yrbc-qqt');
  assert.equal(meetCodeFromInput(reported), 'bjt-yrbc-qqt');
  for (const invalid of ['https://meet.google.com/other/meet/bjt-yrbc-qqt', `${reported}/other`,
    'https://meet.google.com.evil.example/meet/bjt-yrbc-qqt', 'http://meet.google.com/meet/bjt-yrbc-qqt']) {
    assert.equal(meetCodeFromUrl(invalid), null);
  }
});

test('active sidebar, Meet picker, and page-sample validation agree on /meet/code rooms', async () => {
  const tab = { id: 10, url: 'https://meet.google.com/meet/bjt-yrbc-qqt' };
  const expected = { tabId: 10, meetCode: 'bjt-yrbc-qqt' };
  const api = { query: async () => [tab] };
  assert.deepEqual(await currentMeetTab(api), expected);
  assert.deepEqual(await findMeetTabs(api), [expected]);
  const sample = { pageUrl: tab.url, meetCode: 'bjt-yrbc-qqt', state: 'unknown' };
  assert.equal(verifiedMeetSample(sample), sample);
});

test('withheld active-tab URL can be resolved using a validated top-frame content-script sample', async () => {
  const messages = [];
  const context = await currentMeetTab({
    query: async () => [{ id: 10 }],
    sendMessage: async (...args) => {
      messages.push(args);
      return { meetCode: 'abc-defg-hij', pageUrl: 'https://meet.google.com/abc-defg-hij', state: 'unknown' };
    }
  });
  assert.deepEqual(context, { tabId: 10, meetCode: 'abc-defg-hij' });
  assert.deepEqual(messages, [[10, { type: 'ALISTO_MEET_SAMPLE' }, { frameId: 0 }]]);
});

test('room proof rejects manual codes, lookalike domains, mismatched addresses, and invalid states', () => {
  const valid = { meetCode: 'abc-defg-hij', pageUrl: 'https://meet.google.com/abc-defg-hij', state: 'out' };
  assert.equal(verifiedMeetSample(valid), valid);
  for (const sample of [null, {}, { ...valid, pageUrl: undefined }, { ...valid, pageUrl: 'abc-defg-hij' },
    { ...valid, pageUrl: 'https://meet.google.com.evil.example/abc-defg-hij' },
    { ...valid, pageUrl: 'https://meet.google.com/xyz-abcd-efg' }, { ...valid, state: 'focused' }]) {
    assert.equal(verifiedMeetSample(sample), null);
  }
});

test('script fallback never overrides a known non-Meet address and missing scripts do not invent a room', async () => {
  let calls = 0;
  const api = { sendMessage: async () => { calls++; throw new Error('No script'); } };
  assert.deepEqual(await meetTabContext({ id: 10, url: 'https://example.com' }, api), { tabId: 10, meetCode: null });
  assert.equal(calls, 0);
  assert.deepEqual(await meetTabContext({ id: 10 }, api), { tabId: 10, meetCode: null });
  assert.equal(calls, 1);
});

test('explicit Meet picker searches only Meet URLs and returns identified tab IDs/codes, not page titles or activity', async () => {
  const queries = [];
  const contexts = await findMeetTabs({
    query: async options => {
      queries.push(options);
      return [{ id: 10, url: 'https://meet.google.com/abc-defg-hij', title: 'Private title' },
        { id: 11 }, { id: 12, url: 'https://example.com' }, { id: 13, url: 'https://meet.google.com/' }];
    },
    sendMessage: async () => ({ meetCode: 'xyz-abcd-efg', pageUrl: 'https://meet.google.com/xyz-abcd-efg', state: 'in' })
  });
  assert.deepEqual(queries, [{ url: 'https://meet.google.com/*' }]);
  assert.deepEqual(contexts, [{ tabId: 10, meetCode: 'abc-defg-hij' }, { tabId: 11, meetCode: 'xyz-abcd-efg' }]);
});

test('content script returns a fresh room sample with query/fragment stripped and never infers membership from a URL', async () => {
  let state = 'unknown'; let listener;
  const reports = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../extension/content.js'), 'utf8'), {
    location: { href: 'https://meet.google.com/abc-defg-hij?authuser=private@example.com#private', origin: 'https://meet.google.com', pathname: '/abc-defg-hij' },
    document: { documentElement: {} }, meetCodeFromUrl, detectMeetMembership: () => state,
    MutationObserver: class { observe() {} disconnect() {} },
    setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {},
    chrome: { runtime: { id: 'extension-id', sendMessage: async message => { reports.push(message); },
      onMessage: { addListener: fn => { listener = fn; } } } }
  });
  assert.equal(reports[0].state, 'unknown');
  assert.equal(reports[0].pageUrl, 'https://meet.google.com/abc-defg-hij');
  assert.ok(!JSON.stringify(reports).includes('private'));
  state = 'in'; let response;
  listener({ type: 'ALISTO_MEET_SAMPLE' }, { id: 'extension-id' }, value => { response = value; });
  assert.equal(response.state, 'in');
  response = null;
  listener({ type: 'ALISTO_MEET_SAMPLE' }, { id: 'another-extension' }, value => { response = value; });
  assert.equal(response, null);
});

test('content script recognizes the reported /meet/code path without awarding presence from its URL', () => {
  const reports = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../extension/content.js'), 'utf8'), {
    location: { href: 'https://meet.google.com/meet/bjt-yrbc-qqt', origin: 'https://meet.google.com', pathname: '/meet/bjt-yrbc-qqt' },
    document: { documentElement: {} }, meetCodeFromUrl, detectMeetMembership: () => 'unknown',
    MutationObserver: class { observe() {} disconnect() {} },
    setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {},
    chrome: { runtime: { id: 'extension-id', sendMessage: async message => { reports.push(message); }, onMessage: { addListener() {} } } }
  });
  assert.equal(reports[0].meetCode, 'bjt-yrbc-qqt');
  assert.equal(reports[0].pageUrl, 'https://meet.google.com/meet/bjt-yrbc-qqt');
  assert.equal(reports[0].state, 'unknown');
});
