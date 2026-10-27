'use strict';

function createClassroomPanel({ container, overview, api, getUser, onError }) {
  const root = document.querySelector(container);
  root.append(document.querySelector('#classroom-template').content.cloneNode(true));
  const $ = selector => root.querySelector(selector);
  if (overview) $('[data-tab-panel="overview"]').append(document.querySelector(overview));
  const views = ['overview', 'general', 'participation'];
  let selectedView = 'overview';
  let sessionId = null;
  let generation = 0;
  let contextGeneration = 0;
  let data = null;
  let receivedAt = 0;
  let submitting = false;
  let fresh = false;
  let responsePromptId = null;

  function selectView(view, focus = false) {
    selectedView = view;
    for (const name of views) {
      const selected = name === view;
      const tab = $(`[data-tab="${name}"]`);
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      $(`[data-tab-panel="${name}"]`).hidden = !selected;
      if (selected && focus) tab.focus();
    }
  }
  for (const name of views) {
    const tab = $(`[data-tab="${name}"]`);
    const panel = $(`[data-tab-panel="${name}"]`);
    tab.id = `${container.slice(1)}-${name}-tab`;
    panel.id = `${container.slice(1)}-${name}-panel`;
    tab.setAttribute('aria-controls', panel.id);
    panel.setAttribute('aria-labelledby', tab.id);
    tab.addEventListener('click', () => selectView(name));
    tab.addEventListener('keydown', event => {
      const index = views.indexOf(name);
      const next = event.key === 'ArrowRight' ? views[(index + 1) % views.length]
        : event.key === 'ArrowLeft' ? views[(index + views.length - 1) % views.length]
          : event.key === 'Home' ? views[0] : event.key === 'End' ? views.at(-1) : null;
      if (next) { event.preventDefault(); selectView(next, true); }
    });
  }

  function node(tag, text, className) {
    const element = document.createElement(tag);
    element.textContent = text;
    if (className) element.className = className;
    return element;
  }
  function reset() {
    contextGeneration++; submitting = false;
    generation++; sessionId = null; data = null; fresh = false; responsePromptId = null;
    root.hidden = true;
    for (const selector of ['[data-messages]', '[data-prompts]', '[data-buckets]']) $(selector).replaceChildren();
    for (const form of root.querySelectorAll('form')) form.reset();
    $('[data-prompt-body]').textContent = '';
    $('[data-self-rate]').textContent = '';
    $('[data-progress-label]').textContent = '';
    $('[data-response-notice]').textContent = '';
    $('[data-current-prompt]').hidden = true;
    $('[data-progress]').hidden = true;
    $('[data-chat-status]').textContent = '';
    selectView('overview');
    controls();
  }
  function current() { return data?.prompts.at(-1); }
  function remaining() {
    return Math.max(0, (current()?.remaining_ms || 0) - (performance.now() - receivedAt));
  }
  function controls() {
    const teacher = getUser()?.role === 'teacher';
    const live = data?.session_status === 'live';
    const open = current()?.open && remaining() > 0;
    $('[data-message-form]').hidden = !live;
    $('[data-prompt-form]').hidden = !teacher || !live;
    $('[data-close-prompt]').hidden = !teacher || !live || !open;
    $('[data-response-form]').hidden = teacher || !live || !open || !current()?.eligible || current()?.responded;
    for (const element of root.querySelectorAll('form button, form textarea, form input, form select, [data-close-prompt]')) {
      element.disabled = submitting || !fresh || !live;
    }
    $('[data-prompt-form] button').disabled ||= !!open;
  }
  function tick() {
    if (!data || root.hidden) return;
    if (data.session_status === 'live' && performance.now() - receivedAt > 15000) {
      fresh = false;
      $('[data-chat-status]').textContent = 'Chat updates are stale. Refresh before sending; drafts are preserved.';
    }
    const prompt = current();
    $('[data-countdown]').textContent = prompt?.open && remaining() > 0
      ? `Time remaining: ${formatDuration(Math.ceil(remaining() / 1000))}` : 'Prompt closed';
    controls();
  }
  function scrollList(selector, children) {
    const list = $(selector);
    const bottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 20;
    const top = list.scrollTop;
    list.replaceChildren(...children);
    list.scrollTop = bottom ? list.scrollHeight : top;
  }
  function render() {
    root.hidden = false;
    $('[data-chat-status]').textContent = data.session_status === 'live'
      ? 'Chat updates approximately every 5 seconds. Deadlines use server receipt time.' : 'Saved chat and participation · read only';
    const messages = data.messages.map(message => {
      const item = node('article', '', 'item');
      item.append(node('strong', `${message.sender_name} · ${message.sender_role === 'teacher' ? 'Teacher' : 'Student'}`),
        node('p', message.body, 'message-body'), node('small', new Date(message.created_at).toLocaleString(), 'muted'));
      return item;
    });
    scrollList('[data-messages]', messages.length ? messages : [node('p', 'No discussion yet.', 'muted')]);
    const prompt = current();
    if (responsePromptId !== (prompt?.id ?? null)) {
      $('[data-response-form]').reset(); responsePromptId = prompt?.id ?? null;
    }
    $('[data-current-prompt]').hidden = !prompt;
    $('[data-prompt-body]').textContent = prompt?.body || '';
    $('[data-response-notice]').textContent = getUser()?.role === 'teacher' ? '' : !prompt ? ''
      : prompt.responded ? 'Response received. Participation credit earned.'
        : !prompt.eligible ? 'Posted before your first call join: not counted toward your rate.'
          : prompt.open ? 'Your first valid response received before closure counts once.' : 'This eligible prompt closed without a response.';
    const self = data.self;
    $('[data-self-rate]').textContent = self
      ? `Participation Rate: ${self.participation_rate === null ? 'N/A' : `${self.participation_rate.toFixed(2)}%`} · ${self.classification} · ${self.responded_count}/${self.eligible_count} eligible prompts` : '';
    const prompts = [...data.prompts].reverse().map(activity => {
      const item = node('article', '', 'item');
      item.append(node('strong', activity.body, 'message-body'), node('p', `${activity.sender_name} · Teacher · ${activity.open ? 'Open' : 'Closed'} · ${new Date(activity.created_at).toLocaleString()}`, 'muted'));
      for (const response of activity.responses) {
        item.append(node('p', `${response.sender_name} · ${response.visibility === 'teacher' ? 'Teacher only' : 'Everyone'} · ${new Date(response.received_at).toLocaleString()}`, 'muted'), node('p', response.body, 'message-body'));
      }
      if (!activity.responses.length) item.append(node('p', 'No responses visible to you yet.', 'muted'));
      return item;
    });
    scrollList('[data-prompts]', prompts.length ? prompts : [node('p', 'No participation prompts yet.', 'muted')]);
    $('[data-progress]').hidden = !data.progress;
    if (data.progress) {
      const { responded_count: responded, eligible_count: eligible, buckets } = data.progress;
      $('[data-progress-label]').textContent = `Current prompt: ${responded}/${eligible} eligible students responded`;
      $('progress').max = eligible || 1; $('progress').value = responded;
      $('[data-buckets]').replaceChildren(...Object.entries(buckets).map(([name, students]) =>
        node('p', `${name} (${students.length}): ${students.map(student => student.name).join(', ') || '—'}`, 'muted')));
    }
    tick();
    selectView(selectedView);
  }

  async function refresh(id) {
    if (sessionId !== id) { reset(); sessionId = id; }
    const token = ++generation;
    const viewer = getUser();
    const requestedAt = performance.now();
    try {
      const result = await api.request(`/api/sessions/${id}/classroom`);
      if (token !== generation || sessionId !== id || viewer?.id !== getUser()?.id || viewer?.role !== getUser()?.role) return;
      if (result.viewer.id !== viewer.id || result.viewer.role !== viewer.role) { reset(); return; }
      // Conservatively include the request round trip: a late response must
      // not restart freshness or give the countdown extra time.
      data = result; receivedAt = requestedAt; fresh = true; render();
    } catch (error) {
      if (token !== generation || sessionId !== id) return;
      fresh = false; controls();
      if (error.status === 403) {
        reset(); sessionId = id; root.hidden = false;
        $('[data-chat-status]').textContent = error.message;
      } else {
        root.hidden = false;
        $('[data-chat-status]').textContent = 'Chat unavailable. Refresh to retry; drafts are preserved.';
        if ([401, 404].includes(error.status)) { reset(); throw error; }
      }
    }
  }
  async function submit(path, body, after) {
    if (submitting || !fresh || !data || data.session_status !== 'live') return;
    const id = sessionId;
    const viewer = getUser();
    const context = contextGeneration;
    submitting = true; controls();
    try {
      await api.request(`/api/sessions/${id}/${path}`, { method: 'POST', body });
      if (context !== contextGeneration || sessionId !== id || viewer?.id !== getUser()?.id || viewer?.role !== getUser()?.role) return;
      after?.();
      await refresh(id);
    } catch (error) {
      if (context === contextGeneration && sessionId === id && viewer?.id === getUser()?.id && viewer?.role === getUser()?.role) {
        onError(error);
        if (context === contextGeneration && sessionId === id && getUser()?.id === viewer.id && getUser()?.role === viewer.role) await refresh(id);
      }
    } finally { if (context === contextGeneration) { submitting = false; controls(); } }
  }
  $('[data-message-form]').addEventListener('submit', event => {
    event.preventDefault();
    submit('messages', { body: $('[name="message"]').value }, () => $('[data-message-form]').reset());
  });
  $('[data-prompt-form]').addEventListener('submit', event => {
    event.preventDefault();
    submit('prompts', { body: $('[name="prompt"]').value, durationSeconds: Math.round(Number($('[name="minutes"]').value) * 60) }, () => $('[data-prompt-form]').reset());
  });
  $('[data-response-form]').addEventListener('submit', event => {
    event.preventDefault();
    if (!current() || remaining() <= 0) return;
    submit(`prompts/${current().id}/respond`, { body: $('[name="response"]').value, visibility: $('[name="visibility"]').value }, () => $('[data-response-form]').reset());
  });
  $('[data-close-prompt]').addEventListener('click', () => {
    if (current()) submit(`prompts/${current().id}/close`);
  });
  setInterval(tick, 1000);
  reset();
  return { refresh, reset };
}
