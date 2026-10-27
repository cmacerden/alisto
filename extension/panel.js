'use strict';

(() => {
  const api = createExtensionApi();
  const $ = selector => document.querySelector(selector);
  let user = null;
  let loading = false;
  let requestGeneration = 0;
  let contextGeneration = 0;
  let activeTabId = null;
  let activeMeetCode = null;
  let selectedMeetTabId = null;
  let liveSessionId = null;
  let savedSessionId = null;
  let pollRunning = false;
  const classroom = createClassroomPanel({ container: '#live-classroom', overview: '#live-overview', api, getUser: () => user, onError: fail });
  const savedClassroom = createClassroomPanel({ container: '#saved-classroom', overview: '#result-content', api, getUser: () => user, onError: fail });

  function status(message, error = false) {
    $('#status').textContent = message;
    $('#status').classList.toggle('error', error);
  }

  function clearAccount() {
    user = null;
    classroom.reset(); savedClassroom.reset();
    requestGeneration++;
    $('#account').hidden = true;
    $('#auth').hidden = false;
    $('#teacher-tools').hidden = true;
    $('#result').hidden = true;
    $('#live-session').hidden = true;
    $('#student-meet').hidden = true;
    liveSessionId = null;
    savedSessionId = null;
    selectedMeetTabId = null;
    $('#student-meet-tab').replaceChildren(new Option('Use the selected browser tab', ''));
    $('#teacher-meet-code').value = '';
    for (const selector of ['#classes', '#history', '#result-content', '#live-students']) $(selector).replaceChildren();
    $('#account-heading').textContent = '';
    $('#account-role').textContent = '';
    renderMeetContext();
  }

  function fail(error) {
    if (error.status === 401) clearAccount();
    status(error.message, true);
  }

  async function busy(task) {
    if (loading) return;
    loading = true;
    const buttons = [...document.querySelectorAll('button')].map(button => ({ button, disabled: button.disabled }));
    buttons.forEach(({ button }) => { button.disabled = true; });
    try { await task(); } catch (error) { fail(error); }
    finally {
      loading = false;
      buttons.forEach(({ button, disabled }) => { button.disabled = disabled; });
    }
  }

  async function updateMeetContext() {
    const generation = ++contextGeneration;
    try {
      const context = user?.role === 'student' && selectedMeetTabId !== null
        ? await meetTabContext(await chrome.tabs.get(selectedMeetTabId), chrome.tabs) : await currentMeetTab(chrome.tabs);
      if (generation !== contextGeneration) return;
      activeTabId = context.tabId;
      activeMeetCode = context.meetCode;
      renderMeetContext();
    } catch {
      if (generation !== contextGeneration) return;
      activeTabId = null; activeMeetCode = null;
      renderMeetContext();
    }
  }

  function renderMeetContext() {
    const manual = user?.role === 'teacher' ? meetCodeFromInput($('#teacher-meet-code').value) : null;
    $('#meet-context').textContent = activeMeetCode ? `Actual Google Meet code: ${activeMeetCode}`
      : manual ? `Teacher-entered Meet code: ${manual} · Not automatically detected`
        : user?.role === 'student' ? 'No Meet code detected yet. Refresh the Meet page, then use Find Meet tabs below.'
          : 'No Meet code detected from the selected tab. Teachers can paste the actual meeting link/code above their classes.';
  }

  function paragraph(text, className = 'muted') {
    const element = document.createElement('p'); element.className = className; element.textContent = text; return element;
  }

  function label(session) {
    return session.status === 'live' ? (session.source === 'meet' ? 'Live · Google Meet' : 'Live · legacy website session') : session.status === 'interrupted' ? 'Ended due to interruption' : 'Ended';
  }

  function rate(value) { return value == null ? 'N/A' : `${value.toFixed(2)}%`; }
  function duration(seconds) { return formatDuration(seconds); }

  async function showSaved(id) {
    const identity = await api.request('/api/auth/me');
    setAccount(identity.user);
    const generation = requestGeneration;
    const snapshot = await api.request(`/api/sessions/${id}/report`);
    if (generation !== requestGeneration) return;
    if (snapshot.viewer.id !== user.id || snapshot.viewer.role !== user.role) { clearAccount(); throw new Error('Account changed. Log in again to open the report.'); }
    if (snapshot.session.status === 'live') throw new Error('Only ended presence results can be viewed in this build.');
    const content = $('#result-content'); content.replaceChildren();
    $('#result-source').textContent = snapshot.session.source === 'meet'
      ? `Google Meet ${snapshot.session.meet_code}: browser-reported call time. Unverifiable intervals are excluded; this is not proof of attention.`
      : 'Legacy result: Alisto connection time, not Google Meet call time.';
    content.append(paragraph(`${snapshot.session.class_title} · ${snapshot.completion_label}`));
    content.append(paragraph(`Session ${snapshot.session.id} · ${new Date(snapshot.session.started_at).toLocaleString()}`));
    content.append(paragraph(`Locked at ${new Date(snapshot.session.ended_at).toLocaleString()}`));
    content.append(paragraph(snapshot.notice));
    const students = user.role === 'teacher' ? snapshot.students : [snapshot.self];
    if (!students.length) content.append(paragraph('No students joined this session.'));
    for (const student of students) {
      const item = document.createElement('article'); item.className = 'item';
      const title = document.createElement('h4'); title.textContent = student.name;
      item.append(title, paragraph(student.email), paragraph(`Activity Rate: ${rate(student.activity_rate)} · Final status: ${student.status}`),
        paragraph(`${snapshot.session.source === 'meet' ? 'In call' : 'Connected'} after grace: ${duration(student.active_seconds)} · Measured: ${duration(student.total_seconds)}`));
      if (snapshot.session.source === 'meet') item.append(paragraph(`Cannot verify (excluded since enrollment): ${duration(student.excluded_seconds)}`));
      if (student.participation) item.append(participationLine(student.participation));
      content.append(item);
    }
    addReportControls(content, id);
    $('#result').hidden = false;
    savedSessionId = id;
    await savedClassroom.refresh(id);
    $('#result').scrollIntoView({ block: 'nearest' });
  }

  function addReportControls(content, id) {
    const viewer = `${user.role}:${user.id}`;
    const valid = () => user && `${user.role}:${user.id}` === viewer && savedSessionId === id && download.isConnected;
    const download = document.createElement('button'); download.type = 'button'; download.className = 'secondary';
    download.textContent = user.role === 'teacher' ? 'Download full-class CSV' : 'Download my CSV';
    download.addEventListener('click', () => busy(async () => {
      const result = await api.request(`/api/sessions/${id}/report.csv`);
      if (!valid()) return;
      if (result.viewer !== viewer) { clearAccount(); throw new Error('Account changed. Log in again before downloading.'); }
      const url = URL.createObjectURL(new Blob(['\uFEFF', result.csv], { type: 'text/csv;charset=utf-8' }));
      const anchor = document.createElement('a'); anchor.href = url;
      anchor.download = `alisto-session-${id}-${user.role === 'teacher' ? 'class' : 'student-' + user.id}.csv`;
      document.body.append(anchor); anchor.click(); anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      status('CSV download requested. Check your browser downloads.');
    }));
    content.append(download);
    if (user.role !== 'student') return;
    const documentDownload = document.createElement('button'); documentDownload.type = 'button'; documentDownload.className = 'secondary';
    documentDownload.textContent = 'Download my report (.docx)';
    documentDownload.addEventListener('click', () => busy(async () => {
      const result = await api.request(`/api/sessions/${id}/report.docx`);
      if (!valid()) return;
      if (result.viewer !== viewer) { clearAccount(); throw new Error('Account changed. Log in again before downloading.'); }
      const url = URL.createObjectURL(new Blob([result.document], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }));
      const anchor = document.createElement('a'); anchor.href = url;
      anchor.download = `alisto-session-${id}-student-${user.id}.docx`;
      document.body.append(anchor); anchor.click(); anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      status('Document download requested. Open it in Word, LibreOffice, or upload it to Google Docs.');
    }));
    content.append(documentDownload);
    const email = document.createElement('button'); email.type = 'button'; email.className = 'secondary';
    email.textContent = 'Email my report / create preview';
    const outcome = paragraph('Uses your registered email. Without SMTP, your report is stored on the Ethereal test service for preview only; no inbox delivery.', 'notice');
    outcome.setAttribute('role', 'status');
    email.addEventListener('click', () => busy(async () => {
      outcome.replaceChildren(document.createTextNode('Sending report request… Do not retry while it is in progress.'));
      try {
        const result = await api.request(`/api/sessions/${id}/report/email`, { method: 'POST' });
        if (!valid()) return;
        if (`${result.viewer?.role}:${result.viewer?.id}` !== viewer) { clearAccount(); throw new Error('Account changed. Log in again to view the email result.'); }
        outcome.textContent = result.message;
        if (result.mode === 'preview' && result.preview_url) {
          const url = new URL(result.preview_url);
          if (url.protocol !== 'https:' || url.hostname !== 'ethereal.email') throw new Error('Invalid preview link.');
          const link = document.createElement('a'); link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer';
          link.textContent = 'Open preview (not delivered)'; outcome.append(document.createTextNode(' '), link);
        }
      } catch (error) {
        if (valid()) outcome.textContent = error.message;
        throw error;
      }
    }));
    content.append(email, outcome);
  }

  function setAccount(identity) {
    if (!user || user.id !== identity.id || user.role !== identity.role) clearAccount();
    user = identity;
    $('#auth').hidden = true;
    $('#account').hidden = false;
    $('#teacher-tools').hidden = user.role !== 'teacher';
    $('#student-meet').hidden = user.role !== 'student';
    $('#account-heading').textContent = `Welcome, ${user.name}`;
    $('#account-role').textContent = user.role === 'teacher' ? 'Teacher / Admin' : 'Student';
    renderMeetContext();
  }

  async function refresh() {
    // Another Alisto tab can change this profile's shared login.
    const identity = await api.request('/api/auth/me');
    setAccount(identity.user);
    const generation = ++requestGeneration;
    const [history, classes] = await Promise.all([
      api.request('/api/sessions'), user.role === 'teacher' ? api.request('/api/classes') : Promise.resolve(null)
    ]);
    if (generation !== requestGeneration) return;
    if (savedSessionId && !history.sessions.some(session => session.id === savedSessionId)) {
      savedSessionId = null; $('#result').hidden = true; $('#result-content').replaceChildren();
      savedClassroom.reset();
    }
    if (liveSessionId && !history.sessions.some(session => session.id === liveSessionId)) {
      liveSessionId = null; $('#live-session').hidden = true; $('#live-students').replaceChildren();
      classroom.reset();
    }
    $('#history').replaceChildren();
    if (!history.sessions.length) $('#history').append(paragraph('No sessions yet. Connect to your teacher’s live Meet session to begin.'));
    for (const session of history.sessions) {
      const item = document.createElement('article'); item.className = 'item';
      const title = document.createElement('h4'); title.textContent = session.class_title;
      item.append(title, paragraph(`${label(session)} · ${new Date(session.started_at).toLocaleString()}`));
      if (session.status !== 'live') {
        const open = document.createElement('button'); open.type = 'button'; open.className = 'secondary'; open.textContent = 'View saved session';
        open.addEventListener('click', () => busy(() => showSaved(session.id))); item.append(open);
        if (user.role === 'teacher') addDeleteControl(item, session);
      } else if (session.source === 'meet') {
        item.append(paragraph(`Meet code: ${session.meet_code}`));
        const open = document.createElement('button'); open.type = 'button'; open.className = 'secondary'; open.textContent = 'Show live presence';
        open.addEventListener('click', () => busy(async () => { liveSessionId = session.id; await refreshLive(); })); item.append(open);
      } else item.append(paragraph('Manage this existing session in the legacy website. This panel does not join it or affect its timing.'));
      $('#history').append(item);
    }
    $('#classes').replaceChildren();
    if (classes) {
      if (!classes.classes.length) $('#classes').append(paragraph('Create your first class below.'));
      for (const classroom of classes.classes) {
        const item = document.createElement('article'); item.className = 'item';
        const title = document.createElement('h4'); title.textContent = classroom.title; item.append(title);
        const start = document.createElement('button'); start.type = 'button'; start.textContent = classroom.live_session_id ? 'Show live session' : 'Start Meet session';
        start.addEventListener('click', () => busy(async () => {
          if (classroom.live_session_id) {
            const existing = history.sessions.find(session => session.id === classroom.live_session_id);
            if (existing?.source !== 'meet') throw new Error('This class has a legacy website session. End it there before starting a Meet session.');
            liveSessionId = classroom.live_session_id;
          } else {
            await updateMeetContext();
            const meetCode = teacherMeetCode($('#teacher-meet-code').value, activeMeetCode);
            const result = await api.request(`/api/meet/classes/${classroom.id}/sessions`, { method: 'POST', body: { meetCode } });
            liveSessionId = result.session.id;
          }
          await refresh(); await refreshLive(); status('Meet session ready. Students can connect from the matching Google Meet tab.');
        }));
        item.append(start); addClassDeleteControl(item, classroom); $('#classes').append(item);
      }
    }
    if (!liveSessionId) liveSessionId = history.sessions.find(session => session.source === 'meet' && session.status === 'live')?.id || null;
    if (liveSessionId) await refreshLive();
  }

  function addDeleteControl(item, session) {
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'danger secondary'; remove.textContent = 'Delete session';
    const confirmation = document.createElement('div'); confirmation.className = 'delete-confirmation'; confirmation.hidden = true;
    confirmation.id = `delete-session-${session.id}`;
    remove.setAttribute('aria-controls', confirmation.id); remove.setAttribute('aria-expanded', 'false');
    confirmation.append(paragraph(`Permanently delete “${session.class_title}” (${new Date(session.started_at).toLocaleString()}) and all saved presence results for its students? This cannot be undone.`, 'notice'));
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'secondary'; cancel.textContent = 'Cancel';
    const confirm = document.createElement('button'); confirm.type = 'button'; confirm.className = 'danger'; confirm.textContent = 'Permanently delete session';
    remove.addEventListener('click', () => {
      if (loading) return;
      confirmation.hidden = false; remove.hidden = true; remove.setAttribute('aria-expanded', 'true'); cancel.focus();
    });
    cancel.addEventListener('click', () => {
      if (loading) return;
      confirmation.hidden = true; remove.hidden = false; remove.setAttribute('aria-expanded', 'false'); remove.focus();
    });
    confirm.addEventListener('click', () => busy(async () => {
      await api.request(`/api/sessions/${session.id}`, { method: 'DELETE', body: { confirm: true } });
      requestGeneration++;
      await refresh();
      status('Session permanently deleted from teacher and student history. The class and Google Meet call were not deleted.');
      $('#refresh').focus();
    }));
    confirmation.append(cancel, confirm); item.append(remove, confirmation);
  }

  function addClassDeleteControl(item, classroom) {
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'danger secondary'; remove.textContent = 'Delete class';
    remove.disabled = Boolean(classroom.has_sessions || classroom.live_session_id);
    const confirmation = document.createElement('div'); confirmation.className = 'delete-confirmation'; confirmation.hidden = true;
    confirmation.id = `delete-class-${classroom.id}`;
    remove.setAttribute('aria-controls', confirmation.id); remove.setAttribute('aria-expanded', 'false');
    if (remove.disabled) {
      remove.title = 'End any live session and delete this class’s saved sessions first.';
      item.append(paragraph('Class protected: end any live session, then delete its sessions from Session history before deleting this class.'));
    }
    confirmation.append(paragraph(`Permanently delete the class “${classroom.title}”? This cannot be undone. Its Google Meet meeting and your account will not be deleted.`, 'notice'));
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'secondary'; cancel.textContent = 'Cancel';
    const confirm = document.createElement('button'); confirm.type = 'button'; confirm.className = 'danger'; confirm.textContent = 'Permanently delete class';
    remove.addEventListener('click', () => {
      if (loading || remove.disabled) return;
      confirmation.hidden = false; remove.hidden = true; remove.setAttribute('aria-expanded', 'true'); cancel.focus();
    });
    cancel.addEventListener('click', () => {
      if (loading) return;
      confirmation.hidden = true; remove.hidden = false; remove.setAttribute('aria-expanded', 'false'); remove.focus();
    });
    confirm.addEventListener('click', () => busy(async () => {
      await api.request(`/api/classes/${classroom.id}`, { method: 'DELETE', body: { confirm: true } });
      requestGeneration++; await refresh();
      status('Class permanently deleted. Your account and Google Meet meeting were not deleted.');
      $('#class-title').focus();
    }));
    confirmation.append(cancel, confirm); item.append(remove, confirmation);
  }

  async function refreshLive() {
    if (!user || !liveSessionId) return;
    const id = liveSessionId;
    const identity = await api.request('/api/auth/me');
    if (identity.user.id !== user.id || identity.user.role !== user.role) { setAccount(identity.user); return; }
    const generation = requestGeneration;
    const snapshot = await api.request(`/api/sessions/${id}`);
    if (generation !== requestGeneration || liveSessionId !== id) return;
    if (snapshot.session.source !== 'meet') return;
    $('#live-session').hidden = false;
    $('#live-details').textContent = `${snapshot.session.class_title} · ${snapshot.session.meet_code} · ${label(snapshot.session)}`;
    $('#end-meet').hidden = user.role !== 'teacher' || snapshot.session.status !== 'live';
    const content = $('#live-students'); content.replaceChildren();
    const students = user.role === 'teacher' ? snapshot.students : [snapshot.self];
    if (!students.length) content.append(paragraph('No students have connected yet.'));
    if (user.role === 'teacher') {
      content.append(paragraph(`Offline students: ${students.filter(student => student.status === 'Offline').map(student => student.name).join(', ') || 'None'}`));
    }
    for (const student of students) {
      const item = document.createElement('article'); item.className = 'item';
      const title = document.createElement('h4'); title.textContent = student.name;
      const state = student.detection_notice || (student.call_state === 'in' ? 'Active · detected in call' : student.call_state === 'out' ? 'Offline · detected out of call' : 'Offline · session ended');
      item.append(title, paragraph(state), paragraph(`Activity Rate: ${rate(student.activity_rate)}`),
        paragraph(`In call after grace: ${duration(student.active_seconds)} · Measured: ${duration(student.total_seconds)}`),
        paragraph(`Cannot verify (excluded since enrollment): ${duration(student.excluded_seconds)}`));
      if (student.grace_remaining_ms !== null) item.append(paragraph(`Grace: ${duration(Math.ceil(student.grace_remaining_ms / 1000))} remaining`));
      if (student.participation) item.append(participationLine(student.participation));
      content.append(item);
    }
    $('#live-status').textContent = `Updated ${new Date(snapshot.server_time).toLocaleTimeString()}`;
    await classroom.refresh(id);
  }

  function participationLine(summary) {
    return paragraph(`Participation Rate: ${rate(summary.participation_rate)} · ${summary.classification} · ${summary.responded_count}/${summary.eligible_count} eligible prompts`);
  }

  async function showAccount(identity) {
    setAccount(identity);
    await refresh();
    status('Account connected. Use the actual Meet tab to start or connect to a class session.');
  }

  async function initialize() {
    $('#retry').hidden = true;
    status('Connecting to Alisto…');
    try {
      const result = await api.request('/api/auth/me');
      await showAccount(result.user);
    } catch (error) {
      if (error.status === 401) { clearAccount(); status('Choose your account access below.'); }
      else { $('#retry').hidden = false; throw error; }
    }
  }

  $('#mode').addEventListener('change', () => {
    const register = $('#mode').value === 'register';
    $('#name-field').hidden = !register;
    $('#name').disabled = !register; $('#name').required = register;
    $('#password').autocomplete = register ? 'new-password' : 'current-password';
    $('#auth-submit').textContent = register ? 'Create account' : 'Log in';
  });
  $('#auth-form').addEventListener('submit', event => {
    event.preventDefault();
    busy(async () => {
      const mode = $('#mode').value;
      const body = { role: $('#role').value, email: $('#email').value, password: $('#password').value };
      if (mode === 'register') body.name = $('#name').value;
      const result = await api.request(`/api/auth/${mode}`, { method: 'POST', body });
      $('#password').value = '';
      await showAccount(result.user);
    });
  });
  $('#logout').addEventListener('click', () => busy(async () => {
    await api.request('/api/auth/logout', { method: 'POST' });
    clearAccount(); $('#password').value = ''; status('Logged out.');
    if (chrome.runtime?.sendMessage) await chrome.runtime.sendMessage({ type: 'ALISTO_MEET_RESET' }).catch(() => {});
  }));
  $('#class-form').addEventListener('submit', event => {
    event.preventDefault();
    busy(async () => {
      await api.request('/api/classes', { method: 'POST', body: { title: $('#class-title').value } });
      $('#class-title').value = ''; await refresh(); status('Class created. Open a Meet tab to start its session.');
    });
  });
  $('#refresh').addEventListener('click', () => busy(async () => { await refresh(); status('Session history refreshed.'); }));
  $('#retry').addEventListener('click', () => busy(initialize));
  $('#teacher-meet-code').addEventListener('input', renderMeetContext);
  $('#find-meet-tabs').addEventListener('click', () => busy(async () => {
    const contexts = await findMeetTabs(chrome.tabs);
    const select = $('#student-meet-tab'); select.replaceChildren(new Option('Use the selected browser tab', ''));
    for (const context of contexts) select.append(new Option(`${context.meetCode} · tab ${context.tabId}`, String(context.tabId)));
    if (contexts.length === 1) selectedMeetTabId = contexts[0].tabId;
    else if (!contexts.some(context => context.tabId === selectedMeetTabId)) selectedMeetTabId = null;
    select.value = selectedMeetTabId === null ? '' : String(selectedMeetTabId);
    await updateMeetContext();
    status(contexts.length ? 'Meet tabs found. Choose your teacher’s meeting code, then click Connect this Meet tab.'
      : 'No readable Meet tabs found. Refresh the Meet page after reloading Alisto, check its site access on meet.google.com, and enable Allow in Incognito if applicable.', !contexts.length);
  }));
  $('#student-meet-tab').addEventListener('change', () => {
    selectedMeetTabId = Number($('#student-meet-tab').value) || null;
    updateMeetContext();
  });
  $('#connect-meet').addEventListener('click', () => busy(async () => {
    await updateMeetContext();
    if (!activeMeetCode) throw new Error('Cannot identify a Meet tab yet. Refresh the Meet page, click Find Meet tabs, select your teacher’s code, and try Connect again.');
    const result = await chrome.runtime.sendMessage({ type: 'ALISTO_MEET_TRACK', tabId: activeTabId });
    if (!result?.ok) throw new Error(result?.error || 'Cannot connect this meeting. Reload the extension and Meet tab.');
    liveSessionId = result.data.sessionId;
    await refresh();
    status(result.data.needsReload ? 'Connected, but refresh the Meet tab once to load the detector. Until then: Cannot verify.' : 'Meeting connected. Detection does not require camera or microphone use.');
  }));
  $('#end-meet').addEventListener('click', () => busy(async () => {
    await api.request(`/api/sessions/${liveSessionId}/end`, { method: 'POST' });
    await refresh(); status('Alisto session ended and results locked. The Google Meet call is unchanged.');
  }));
  setInterval(async () => {
    if (loading || pollRunning || !user || !liveSessionId) return;
    pollRunning = true;
    try { await refreshLive(); }
    catch (error) {
      if (error.status === 401) clearAccount();
      else if (error.status === 404) {
        liveSessionId = null; $('#live-session').hidden = true; $('#live-students').replaceChildren();
        classroom.reset();
        try { await refresh(); status('The selected session is no longer available. History updated.'); } catch (refreshError) { fail(refreshError); }
      } else $('#live-status').textContent = 'Updates unavailable; last snapshot may be stale. Retry Refresh.';
    }
    finally { pollRunning = false; }
  }, 5000);
  chrome.tabs.onActivated.addListener(updateMeetContext);
  chrome.tabs.onUpdated.addListener((_tabId, change, tab) => {
    if (tab.active && (change.url || change.status === 'complete')) updateMeetContext();
  });
  updateMeetContext();
  busy(initialize);
})();
