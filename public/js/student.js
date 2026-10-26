'use strict';

(async () => {
  const { api, status } = Alisto;
  Alisto.bindLogout();
  const message = document.querySelector('#page-status');
  const joinStatus = document.querySelector('#join-status');
  const form = document.querySelector('#join-form');
  const joinButton = document.querySelector('#join-button');
  const leaveButton = document.querySelector('#leave-session');
  let live;
  let sessions = [];
  let selectedSessionId = null;
  let currentSnapshot;
  let savedSessionId = null;
  let storageKey;
  let joining = false;

  function saveSelection(id) {
    try { if (id) localStorage.setItem(storageKey, String(id)); else localStorage.removeItem(storageKey); } catch { /* Selection still works without local storage. */ }
  }

  function renderPresence(snapshot) {
    if (snapshot.session.id !== selectedSessionId) return;
    currentSnapshot = snapshot;
    const { session, self } = snapshot;
    document.querySelector('#current-session').hidden = false;
    document.querySelector('#current-title').textContent = session.class_title;
    document.querySelector('#session-label').textContent = AlistoLive.sessionLabel(session);
    document.querySelector('#session-details').textContent = `${new Date(session.started_at).toLocaleString()} · Code: ${session.code}`;
    document.querySelector('#presence-status').textContent = self.status;
    document.querySelector('#activity-rate').textContent = AlistoLive.rate(self.activity_rate);
    document.querySelector('#connected-time').textContent = AlistoLive.duration(self.active_seconds);
    document.querySelector('#measured-time').textContent = AlistoLive.duration(self.total_seconds);
    document.querySelector('#grace-status').textContent = self.grace_remaining_ms !== null
      ? `Grace period · ${Math.ceil(self.grace_remaining_ms / 1000)}s remaining`
      : self.measurement_started_at === null ? 'Not yet measured' : session.status === 'live' ? 'Measurement started' : 'Measurement complete';
    leaveButton.hidden = session.status !== 'live';
    document.querySelector('#session-cutoff').textContent = session.status === 'live'
      ? 'Connected time and total measured time start after grace. Disconnected time after grace still counts toward total measured time.'
      : `Presence result locked at ${new Date(session.ended_at).toLocaleString()}.${session.status === 'interrupted' ? ' Server downtime after this saved cutoff is excluded.' : ''}`;
  }

  function renderSaved(snapshot) {
    const { session, self } = snapshot;
    savedSessionId = session.id;
    document.querySelector('#saved-presence').hidden = false;
    document.querySelector('#saved-title').textContent = session.class_title;
    const details = document.querySelector('#saved-details'); details.replaceChildren();
    const lines = [
      session.source === 'meet' ? `Google Meet ${session.meet_code}: browser-reported call time; unverifiable intervals excluded.` : 'Legacy Alisto connection time, not Google Meet call time.',
      `${AlistoLive.sessionLabel(session)} · ${new Date(session.started_at).toLocaleString()}`,
      `Final status: ${self.status} · Activity Rate: ${AlistoLive.rate(self.activity_rate)}`,
      `${session.source === 'meet' ? 'In call' : 'Connected'} after grace: ${AlistoLive.duration(self.active_seconds)} · Total measured: ${AlistoLive.duration(self.total_seconds)}`,
      `Locked at ${new Date(session.ended_at).toLocaleString()}.${session.status === 'interrupted' ? ' Subsequent server downtime is excluded.' : ''}`
    ];
    if (session.source === 'meet') lines.push(`Cannot verify (excluded since enrollment): ${AlistoLive.duration(self.excluded_seconds)}`);
    for (const text of lines) { const line = document.createElement('p'); line.className = 'muted'; line.textContent = text; details.append(line); }
  }

  async function refreshHistory() {
    sessions = (await api('/api/sessions')).sessions;
    const history = document.querySelector('#session-history'); history.replaceChildren();
    if (!sessions.length) {
      const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = 'No sessions yet. Join a live class to get started.'; history.append(empty);
    }
    for (const session of sessions) {
      const item = document.createElement('article'); item.className = 'history-item';
      const title = document.createElement('h3'); title.textContent = session.class_title;
      const details = document.createElement('p'); details.className = 'input-help';
      details.textContent = `${AlistoLive.sessionLabel(session)} · ${new Date(session.started_at).toLocaleString()}`;
      const open = document.createElement('button'); open.type = 'button'; open.className = 'quiet-button';
      open.textContent = session.status === 'live' ? 'Rejoin session' : 'View presence result';
      open.addEventListener('click', async () => {
        open.disabled = true;
        try {
          if (session.status === 'live') await join({ sessionId: session.id });
          else renderSaved(await api(`/api/sessions/${session.id}`));
        } catch (error) { status(joinStatus, error.message, true); }
        finally { open.disabled = false; }
      });
      item.append(title, details, open); history.append(item);
    }
  }

  async function join(payload) {
    joining = true; joinButton.disabled = true;
    try {
      const snapshot = await live.request('session:join', payload);
      selectedSessionId = snapshot.session.id; saveSelection(selectedSessionId);
      renderPresence(snapshot); status(joinStatus, `Joined ${snapshot.session.class_title}.`);
      await refreshHistory();
    } finally { joining = false; joinButton.disabled = !live.socket.connected; }
  }

  async function restoreSelected() {
    if (!selectedSessionId || joining) return;
    const id = selectedSessionId;
    const snapshot = await api(`/api/sessions/${id}`);
    if (selectedSessionId !== id) return;
    if (snapshot.session.status === 'live') await join({ sessionId: id });
    else renderPresence(snapshot);
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (joining) return;
    status(joinStatus, 'Joining session…');
    try { await join({ code: form.elements.code.value }); }
    catch (error) { status(joinStatus, error.message, true); }
  });
  leaveButton.addEventListener('click', async () => {
    leaveButton.disabled = true;
    try {
      if (live.socket.connected) await live.request('session:leave', {});
      selectedSessionId = null; currentSnapshot = null; saveSelection(null);
      document.querySelector('#current-session').hidden = true;
      status(joinStatus, 'Left the session in this tab. Other connected tabs remain Active.');
      await refreshHistory();
    } catch (error) { status(joinStatus, error.message, true); }
    finally { leaveButton.disabled = false; }
  });

  try {
    const user = await Alisto.requireUser('student'); if (!user) return;
    document.querySelector('#greeting').textContent = `Welcome, ${user.name}`;
    storageKey = `alisto:selected-session:student:${user.id}`;
    try { selectedSessionId = Number(localStorage.getItem(storageKey)) || null; } catch { /* Optional persistence. */ }
    live = AlistoLive.create({
      onUpdate: renderPresence,
      onSessionDeleted({ sessionId }) {
        if (savedSessionId === sessionId) {
          savedSessionId = null;
          document.querySelector('#saved-presence').hidden = true;
          document.querySelector('#saved-details').replaceChildren();
        }
        if (selectedSessionId === sessionId) {
          selectedSessionId = null; currentSnapshot = null; saveSelection(null);
          document.querySelector('#current-session').hidden = true;
        }
        status(message, 'A saved session was permanently deleted by its teacher.');
      },
      onState(connected, text) {
        status(document.querySelector('#connection-status'), text);
        joinButton.disabled = !connected || joining;
        if (connected) restoreSelected().catch(error => status(joinStatus, error.message, true));
        else if (currentSnapshot?.session.status === 'live') document.querySelector('#presence-status').textContent = 'Offline';
      },
      onSessionsChanged() { refreshHistory().catch(error => status(message, error.message, true)); }
    });
    await refreshHistory();
    if (selectedSessionId && !sessions.some(session => session.id === selectedSessionId)) { selectedSessionId = null; saveSelection(null); }
    if (selectedSessionId) renderPresence(await api(`/api/sessions/${selectedSessionId}`));
    status(message, 'Your presence and saved measurements are visible only to you and your teacher.');
    live.socket.connect();
  } catch { status(message, 'Could not load your account. Refresh this page to try again.', true); }
})();
