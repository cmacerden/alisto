'use strict';

window.Alisto = (() => {
  let csrfToken;

  async function api(url, { method = 'GET', body } = {}) {
    if (method !== 'GET' && !csrfToken) {
      const result = await api('/api/auth/csrf');
      csrfToken = result.csrfToken;
    }
    const response = await fetch(url, {
      method, credentials: 'same-origin',
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(method !== 'GET' ? { 'X-CSRF-Token': csrfToken } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const result = await response.json();
    if (!response.ok) {
      const error = new Error(result.error || 'The request could not be completed.');
      error.status = response.status;
      throw error;
    }
    if (result.csrfToken) csrfToken = result.csrfToken;
    return result;
  }

  function status(element, message, isError = false) {
    element.textContent = message;
    element.classList.toggle('error', isError);
  }

  async function copyText(text) {
    // Preserve the click's user activation: embedded browsers can deny the
    // asynchronous Clipboard API while allowing synchronous compatibility copy.
    const previousFocus = document.activeElement;
    const selection = window.getSelection();
    const ranges = [];
    if (selection) {
      for (let index = 0; index < selection.rangeCount; index++) {
        ranges.push(selection.getRangeAt(index).cloneRange());
      }
    }
    const input = document.createElement('textarea');
    input.value = text;
    input.className = 'clipboard-helper';
    input.tabIndex = -1;
    input.setAttribute('readonly', '');
    input.setAttribute('aria-label', 'Class code to copy');
    document.body.append(input);
    let copied = false;
    try {
      input.focus({ preventScroll: true });
      input.select();
      input.setSelectionRange(0, text.length);
      // Deprecated, but retained for browsers blocking the standard API.
      copied = typeof document.execCommand === 'function' && document.execCommand('copy') === true;
    } catch {
      copied = false;
    } finally {
      input.remove();
      previousFocus?.focus({ preventScroll: true });
      if (selection) {
        selection.removeAllRanges();
        for (const range of ranges) selection.addRange(range);
      }
    }
    if (copied) return true;
    try {
      if (!navigator.clipboard?.writeText) return false;
      await navigator.clipboard.writeText(text);
      return true;
    } catch { return false; }
  }

  async function requireUser(role) {
    try {
      const { user } = await api('/api/auth/me');
      if (user.role !== role) { location.replace(`/${user.role}.html`); return null; }
      return user;
    } catch (error) {
      if (error.status === 401) { location.replace(`/auth.html?role=${role}`); return null; }
      throw error;
    }
  }

  function bindLogout() {
    const button = document.querySelector('#logout');
    button.addEventListener('click', async () => {
      button.disabled = true;
      try { await api('/api/auth/logout', { method: 'POST' }); location.replace('/'); }
      catch { button.textContent = 'Retry logout'; button.disabled = false; }
    });
  }

  return { api, status, copyText, requireUser, bindLogout };
})();
