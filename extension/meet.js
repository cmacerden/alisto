'use strict';

// A matching URL identifies a room, NOT membership in its call.
function meetCodeFromUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'meet.google.com' || url.port || url.username || url.password) return null;
    // Meet may use /code, /meet/code, or /u/<account-number>/code.
    const match = /^\/(?:(?:u\/\d+|meet)\/)?([a-z]{3}-[a-z]{4}-[a-z]{3})\/?$/.exec(url.pathname);
    return match ? match[1] : null;
  } catch { return null; }
}

// Manual teacher binding is room selection only; never use this parser to
// infer a student's tab URL or to submit call-presence observations.
function meetCodeFromInput(value) {
  if (typeof value !== 'string') return null;
  const input = value.trim();
  if (/^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i.test(input)) return input.toLowerCase();
  return meetCodeFromUrl(input.startsWith('meet.google.com/') ? `https://${input}` : input);
}

function teacherMeetCode(input, detectedCode) {
  const manual = typeof input === 'string' ? input.trim() : '';
  if (!manual) {
    if (detectedCode) return detectedCode;
    throw new Error('Cannot read the current Meet tab. Paste its actual Google Meet link or code in the field above your classes, then try again.');
  }
  const code = meetCodeFromInput(manual);
  if (!code) throw new Error('Enter a Google Meet link or code such as https://meet.google.com/abc-defg-hij or abc-defg-hij.');
  if (detectedCode && code !== detectedCode) throw new Error('The pasted Meet code does not match the current Meet tab. Clear the field to use the detected code, or paste the matching link.');
  return code;
}

async function currentMeetTab(tabsApi) {
  let tab;
  try { [tab] = await tabsApi.query({ active: true, currentWindow: true }); } catch { /* Try the focused window when panel context has no window. */ }
  if (!tab) [tab] = await tabsApi.query({ active: true, lastFocusedWindow: true });
  return meetTabContext(tab, tabsApi);
}

function verifiedMeetSample(sample) {
  return sample && meetCodeFromUrl(sample.pageUrl) === sample.meetCode &&
    typeof sample.meetCode === 'string' && ['in', 'out', 'unknown'].includes(sample.state) ? sample : null;
}

async function meetTabContext(tab, tabsApi) {
  const context = { tabId: tab?.id ?? null, meetCode: meetCodeFromUrl(tab?.url) };
  // Do not override a known non-Meet address or substitute a manual code.
  if (context.meetCode || typeof tab?.url === 'string' || !Number.isInteger(tab?.id)) return context;
  try {
    const sample = verifiedMeetSample(await tabsApi.sendMessage(tab.id, { type: 'ALISTO_MEET_SAMPLE' }, { frameId: 0 }));
    if (sample) context.meetCode = sample.meetCode;
  } catch { /* The page script may need a Meet-tab refresh or host permission. */ }
  return context;
}

async function findMeetTabs(tabsApi) {
  const tabs = await tabsApi.query({ url: 'https://meet.google.com/*' });
  const contexts = await Promise.all(tabs.map(tab => meetTabContext(tab, tabsApi)));
  return contexts.filter(context => context.meetCode && Number.isInteger(context.tabId));
}

if (typeof module !== 'undefined') module.exports = { meetCodeFromUrl, meetCodeFromInput, teacherMeetCode, currentMeetTab, meetTabContext, verifiedMeetSample, findMeetTabs };
