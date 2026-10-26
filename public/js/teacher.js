'use strict';

(async () => {
  const { api, status, requireUser, bindLogout } = Alisto;
  const list = document.querySelector('#class-list');
  const listStatus = document.querySelector('#list-status');
  const createStatus = document.querySelector('#create-status');
  const form = document.querySelector('#class-form');
  const button = document.querySelector('#create-button');
  bindLogout();
  let classes = [];
  let sessions = [];
  let selectedSessionId = null;
  let live;
  const sessionSelect = document.querySelector('#session-select');
  const endButton = document.querySelector('#end-session');
  const monitorStatus = document.querySelector('#monitor-status');

  function renderMonitor(snapshot) {
    if (snapshot.session.id !== selectedSessionId) return;
    const { session, students } = snapshot;
    document.querySelector('#monitor-content').hidden = false;
    document.querySelector('#session-title').textContent = session.class_title;
    document.querySelector('#session-details').textContent = `${AlistoLive.sessionLabel(session)} · ${new Date(session.started_at).toLocaleString()} · ${session.source === 'meet' ? 'Google Meet' : 'Alisto'} code: ${session.meet_code || session.code}`;
    endButton.hidden = session.status !== 'live';
    document.querySelector('#student-total').textContent = students.length;
    document.querySelector('#active-total').textContent = students.filter(student => student.status === 'Active').length;
    const offline = students.filter(student => student.status === 'Offline');
    document.querySelector('#offline-total').textContent = offline.length;
    const uncertain = students.filter(student => student.detection_notice);
    document.querySelector('#offline-names').textContent = (offline.length ? `Offline: ${offline.map(student => student.name).join(', ')}` : 'No confirmed offline students.')
      + (uncertain.length ? ` · Cannot verify: ${uncertain.map(student => student.name).join(', ')}` : '');
    const rows = document.querySelector('#presence-rows'); rows.replaceChildren();
    for (const student of students) {
      const row = document.createElement('tr');
      const name = document.createElement('td'); name.textContent = student.name;
      const email = document.createElement('small'); email.textContent = student.email; name.append(email);
      const state = document.createElement('td'); const badge = document.createElement('span');
      badge.className = `presence-badge${student.status !== 'Active' ? ' offline' : ''}`; badge.textContent = student.detection_notice || student.status; state.append(badge);
      const rate = document.createElement('td'); rate.textContent = AlistoLive.rate(student.activity_rate);
      if (session.source === 'meet') {
        const excluded = document.createElement('small'); excluded.textContent = `Cannot verify (excluded): ${AlistoLive.duration(student.excluded_seconds)}`; rate.append(excluded);
      }
      if (student.grace_remaining_ms !== null) {
        const grace = document.createElement('small'); grace.textContent = `Grace: ${Math.ceil(student.grace_remaining_ms / 1000)}s`; rate.append(grace);
      }
      const activeTime = document.createElement('td'); activeTime.textContent = AlistoLive.duration(student.active_seconds);
      const totalTime = document.createElement('td'); totalTime.textContent = AlistoLive.duration(student.total_seconds);
      row.append(name, state, rate, activeTime, totalTime); rows.append(row);
    }
    if (!students.length) {
      const row = document.createElement('tr'); const cell = document.createElement('td'); cell.colSpan = 5;
      cell.textContent = 'No students have joined this session yet.'; row.append(cell); rows.append(row);
    }
    document.querySelector('#session-cutoff').textContent = session.status === 'live'
      ? (session.source === 'meet' ? 'Browser-reported Google Meet call time. Unverifiable intervals are excluded, not counted as absence.' : 'Live Alisto connection measurements. Saved checkpoints are written every 5 seconds and on connection changes.')
      : `Presence results locked at ${new Date(session.ended_at).toLocaleString()}.${session.status === 'interrupted' ? ' Server downtime after this saved cutoff is excluded.' : ''} Full reports and exports arrive in Phase 4.`;
  }

  async function selectSession(id) {
    selectedSessionId = id; sessionSelect.value = id ? String(id) : '';
    status(monitorStatus, '');
    if (!id) { document.querySelector('#monitor-content').hidden = true; endButton.hidden = true; return; }
    try {
      const snapshot = live?.socket.connected
        ? await live.request('session:watch', { sessionId: id }) : await api(`/api/sessions/${id}`);
      renderMonitor(snapshot);
    } catch (error) { status(monitorStatus, error.message, true); }
  }

  async function refreshLists() {
    const [classResult, sessionResult] = await Promise.all([api('/api/classes'), api('/api/sessions')]);
    if (JSON.stringify(classes) !== JSON.stringify(classResult.classes)) { classes = classResult.classes; renderClasses(); }
    sessions = sessionResult.sessions;
    sessionSelect.replaceChildren();
    if (!sessions.length) {
      const option = document.createElement('option'); option.value = ''; option.textContent = 'No sessions yet'; sessionSelect.append(option);
    }
    for (const session of sessions) {
      const option = document.createElement('option'); option.value = session.id;
      option.textContent = `${session.class_title} · ${AlistoLive.sessionLabel(session)} · ${new Date(session.started_at).toLocaleString()}`;
      sessionSelect.append(option);
    }
    if (!sessions.some(session => session.id === selectedSessionId)) {
      selectedSessionId = (sessions.find(session => session.status === 'live') || sessions[0])?.id || null;
    }
    sessionSelect.value = selectedSessionId ? String(selectedSessionId) : '';
  }

  sessionSelect.addEventListener('change', () => selectSession(Number(sessionSelect.value) || null));
  endButton.addEventListener('click', async () => {
    const id = selectedSessionId;
    if (!id) return;
    endButton.disabled = true;
    try {
      const snapshot = await api(`/api/sessions/${id}/end`, { method: 'POST' });
      renderMonitor(snapshot); await refreshLists(); status(monitorStatus, 'Session ended. Presence results are locked.');
    } catch (error) { status(monitorStatus, error.message, true); }
    finally { endButton.disabled = false; }
  });

  function renderClasses() {
    list.replaceChildren();
    document.querySelector('#class-count').textContent = classes.length;
    if (!classes.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      const title = document.createElement('h3');
      title.textContent = 'Your first class starts here';
      const hint = document.createElement('p');
      hint.textContent = 'Create a class to get its permanent join code.';
      empty.append(title, hint); list.append(empty); return;
    }
    for (const classroom of classes) {
      const card = document.createElement('article'); card.className = 'panel class-card';
      const heading = document.createElement('h3'); heading.textContent = classroom.title;
      const label = document.createElement('p'); label.className = 'eyebrow'; label.textContent = 'Permanent class code';
      const code = document.createElement('span'); code.className = 'class-code'; code.textContent = classroom.code;
      const note = document.createElement('p'); note.className = 'input-help';
      note.textContent = classroom.live_session_id ? 'A live session is running. Share this code with your students.'
        : classroom.has_sessions ? 'Session history is saved. Deletion is disabled to protect these records.' : 'Start a session before students use this code.';
      const codeRow = document.createElement('div'); codeRow.className = 'code-row';
      const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'quiet-button'; copy.textContent = 'Copy code';
      copy.setAttribute('aria-label', `Copy code for ${classroom.title}`);
      codeRow.append(code, copy);
      const actions = document.createElement('div'); actions.className = 'class-actions';
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'quiet-button danger-outline'; remove.textContent = 'Delete class';
      remove.setAttribute('aria-label', `Delete class ${classroom.title}`);
      remove.setAttribute('aria-expanded', 'false');
      remove.disabled = Boolean(classroom.has_sessions);
      if (classroom.has_sessions) remove.title = 'Classes with session history cannot be deleted.';
      const confirmation = document.createElement('div'); confirmation.className = 'delete-confirmation'; confirmation.hidden = true;
      confirmation.id = `delete-class-${classroom.id}`;
      remove.setAttribute('aria-controls', confirmation.id);
      const explanation = document.createElement('p');
      explanation.textContent = `Delete “${classroom.title}”? This permanently removes the class and its code. This cannot be undone.`;
      const confirmActions = document.createElement('div'); confirmActions.className = 'class-actions';
      const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'quiet-button'; cancel.textContent = 'Cancel';
      const confirm = document.createElement('button'); confirm.type = 'button'; confirm.className = 'button danger-button'; confirm.textContent = 'Yes, delete class';
      const start = document.createElement('button'); start.type = 'button'; start.className = 'button';
      start.textContent = classroom.live_session_id ? 'Monitor session' : 'Start session';
      start.addEventListener('click', async () => {
        start.disabled = true;
        try {
          const id = classroom.live_session_id || (await api(`/api/classes/${classroom.id}/sessions`, { method: 'POST' })).session.id;
          selectedSessionId = id;
          await refreshLists(); await selectSession(id);
          status(listStatus, classroom.live_session_id ? 'Session selected.' : `Session started. Share class code ${classroom.code}.`);
          document.querySelector('#monitor-heading').scrollIntoView({ block: 'nearest' });
        } catch (error) { status(listStatus, error.message, true); }
        finally { start.disabled = false; }
      });
      confirmActions.append(cancel, confirm); confirmation.append(explanation, confirmActions); actions.append(start, remove);
      const feedback = document.createElement('p'); feedback.className = 'form-status'; feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite');

      copy.addEventListener('click', async () => {
        try {
          const copying = Alisto.copyText(classroom.code);
          copy.disabled = true;
          if (!await copying) throw new Error('Clipboard unavailable');
          copy.textContent = 'Copied!'; status(feedback, 'Class code copied.');
        } catch {
          copy.textContent = 'Copy code';
          const range = document.createRange(); range.selectNodeContents(code);
          const selection = window.getSelection();
          if (selection) { selection.removeAllRanges(); selection.addRange(range); }
          status(feedback, 'Your browser blocked automatic copying. Code selected: press Ctrl+C or Cmd+C to copy.');
        } finally { copy.disabled = false; }
      });
      remove.addEventListener('click', () => {
        confirmation.hidden = false; remove.hidden = true; remove.setAttribute('aria-expanded', 'true');
        status(feedback, ''); cancel.focus();
      });
      cancel.addEventListener('click', () => {
        confirmation.hidden = true; remove.hidden = false; remove.setAttribute('aria-expanded', 'false'); remove.focus();
      });
      confirm.addEventListener('click', async () => {
        confirm.disabled = true; cancel.disabled = true;
        status(feedback, 'Deleting class…');
        try {
          await api(`/api/classes/${classroom.id}`, { method: 'DELETE' });
          classes = classes.filter(item => item.id !== classroom.id);
          renderClasses(); status(createStatus, '');
          status(listStatus, `Deleted ${classroom.title}.`);
          (list.querySelector('button') || document.querySelector('#class-title')).focus();
        } catch (error) { status(feedback, error.message, true); }
        finally { confirm.disabled = false; cancel.disabled = false; }
      });
      card.append(heading, label, codeRow, note, actions, confirmation, feedback); list.append(card);
    }
  }

  form.addEventListener('submit', async event => {
    event.preventDefault(); button.disabled = true; status(createStatus, 'Creating class…');
    try {
      const result = await api('/api/classes', { method: 'POST', body: { title: form.elements.title.value } });
      classes.unshift(result.class); renderClasses(); form.reset();
      status(createStatus, `Created ${result.class.title}. Code: ${result.class.code}`);
    } catch (error) { status(createStatus, error.message, true); }
    finally { button.disabled = false; }
  });

  try {
    const user = await requireUser('teacher'); if (!user) return;
    document.querySelector('#greeting').textContent = `Welcome, ${user.name}`;
    live = AlistoLive.create({
      onUpdate: renderMonitor,
      onSessionDeleted({ sessionId }) {
        if (selectedSessionId !== sessionId) return;
        selectedSessionId = null;
        document.querySelector('#monitor-content').hidden = true;
        document.querySelector('#presence-rows').replaceChildren();
        endButton.hidden = true;
        status(monitorStatus, 'This session was permanently deleted.');
      },
      onState(connected, message) {
        status(document.querySelector('#connection-status'), message);
        if (connected) refreshLists().then(() => selectSession(selectedSessionId)).catch(error => status(monitorStatus, error.message, true));
      },
      onSessionsChanged() { refreshLists().then(() => selectSession(selectedSessionId)).catch(error => status(monitorStatus, error.message, true)); }
    });
    await refreshLists(); renderClasses(); await selectSession(selectedSessionId);
    status(listStatus, ''); button.disabled = false; live.socket.connect();
  } catch { status(listStatus, 'Could not load your classes. Refresh this page to try again.', true); }
})();
