'use strict';

importScripts('meet.js', 'api.js');
const api = createExtensionApi();
const KEY = 'meetTrackingV1';
const LOCAL_FRESH_MS = 12000;
let queue = Promise.resolve();

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(error => {
  console.error('Could not enable Alisto side panel:', error.message);
});

function serial(task) {
  const work = queue.then(task);
  queue = work.catch(() => {});
  return work;
}

async function groups() { return (await chrome.storage.session.get(KEY))[KEY] || {}; }
async function save(value) { await chrome.storage.session.set({ [KEY]: value }); }

function groupState(group, at = Date.now()) {
  const tabs = Object.values(group.tabs);
  if (tabs.some(tab => tab.state === 'in' && at - tab.at < LOCAL_FRESH_MS)) return 'in';
  if (!tabs.length || tabs.some(tab => tab.state === 'unknown' || at - tab.at >= LOCAL_FRESH_MS)) return 'unknown';
  return 'out';
}

async function publish(group, saved, key) {
  const { user } = await api.request('/api/auth/me');
  if (user.role !== 'student' || user.id !== group.ownerId) {
    delete saved[key]; await save(saved); return;
  }
  try {
    await api.request(`/api/meet/sessions/${group.sessionId}/observe`, { method: 'POST', body: {
      meetCode: group.meetCode, sourceId: group.sourceId, state: groupState(group)
    } });
  } catch (error) {
    if ([401, 404, 409].includes(error.status)) { delete saved[key]; await save(saved); }
    throw error;
  }
}

async function track(tabId) {
  if (!Number.isInteger(tabId)) throw new Error('Open the sidebar from a Google Meet tab.');
  const tab = await chrome.tabs.get(tabId);
  const { meetCode: code } = await meetTabContext(tab, chrome.tabs);
  if (!code) throw new Error('Cannot identify this Meet tab. Reload Alisto, refresh the Meet page, and check Alisto has site access on meet.google.com. Then use Find Meet tabs in the student sidebar.');
  const { user } = await api.request('/api/auth/me');
  if (user.role !== 'student') throw new Error('Only student accounts send call-presence observations.');
  const { session } = await api.request(`/api/meet/live/${code}`);
  const saved = await groups();
  const key = `${user.id}:${session.id}`;
  const group = saved[key] || { ownerId: user.id, sessionId: session.id, meetCode: code, sourceId: crypto.randomUUID(), tabs: {} };
  for (const [id, observation] of Object.entries(group.tabs)) if (observation.closed) delete group.tabs[id];
  await api.request(`/api/meet/sessions/${session.id}/join`, { method: 'POST', body: { meetCode: code, sourceId: group.sourceId } });
  // A tab can send observations to only one live session at a time.
  for (const [otherKey, other] of Object.entries(saved)) {
    if (otherKey !== key && other.tabs[tabId]) {
      other.tabs[tabId] = { state: 'unknown', at: Date.now() };
      await publish(other, saved, otherKey);
      delete other.tabs[tabId];
    }
  }
  group.tabs[tabId] = { state: 'unknown', at: Date.now() };
  saved[key] = group;
  await save(saved);
  let needsReload = false;
  try {
    const sample = verifiedMeetSample(await chrome.tabs.sendMessage(tabId, { type: 'ALISTO_MEET_SAMPLE' }, { frameId: 0 }));
    if (sample?.meetCode === code) {
      group.tabs[tabId] = { state: sample.state, at: Date.now() };
    } else needsReload = true;
  } catch { needsReload = true; }
  await save(saved);
  await publish(group, saved, key);
  return { sessionId: session.id, needsReload };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;
  const panel = sender.url === chrome.runtime.getURL('panel.html');
  const receivedAt = Date.now();
  let task;
  if (panel && message?.type === 'ALISTO_MEET_TRACK') task = () => track(message.tabId);
  else if (panel && message?.type === 'ALISTO_MEET_RESET') task = () => save({});
  else if (message?.type === 'ALISTO_MEET_OBSERVATION' && sender.frameId === 0 && Number.isInteger(sender.tab?.id)) {
    const code = meetCodeFromUrl(sender.url);
    if (!code || code !== message.meetCode || !['in', 'out', 'unknown'].includes(message.state)) return;
    task = async () => {
      const saved = await groups();
      const tab = await chrome.tabs.get(sender.tab.id);
      if (typeof tab.url === 'string' && meetCodeFromUrl(tab.url) !== code) return;
      for (const [key, group] of Object.entries(saved)) {
        if (group.meetCode !== code || !group.tabs[sender.tab.id]) continue;
        // A queued sample is not fresh evidence. Never backdate counters.
        let state = 'unknown';
        if (Date.now() - receivedAt < 7000 && typeof sender.documentId === 'string') {
          try {
            const current = verifiedMeetSample(await chrome.tabs.sendMessage(sender.tab.id, { type: 'ALISTO_MEET_SAMPLE' }, { documentId: sender.documentId, frameId: 0 }));
            if (current?.meetCode === code) state = current.state;
          } catch { /* Old document or refreshed tab: cannot verify. */ }
        }
        group.tabs[sender.tab.id] = { state, at: receivedAt };
        await save(saved);
        await publish(group, saved, key);
      }
    };
  } else return;
  serial(task).then(data => sendResponse({ ok: true, data })).catch(error => {
    sendResponse({ ok: false, error: error.message });
  });
  return true;
});

function tabChange(tabId, state) {
  serial(async () => {
    const saved = await groups();
    for (const [key, group] of Object.entries(saved)) {
      if (!group.tabs[tabId]) continue;
      group.tabs[tabId] = { state, at: Date.now(), ...(state === 'out' ? { closed: true } : {}) };
      if (state === 'out' && Object.keys(group.tabs).length > 1) delete group.tabs[tabId];
      await save(saved);
      await publish(group, saved, key);
    }
  }).catch(() => { /* Missing evidence expires server-side as Cannot verify. */ });
}
chrome.tabs.onRemoved.addListener(tabId => tabChange(tabId, 'out'));
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'loading') tabChange(tabId, 'unknown');
});
