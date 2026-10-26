'use strict';

(async () => {
  const { api, status } = Alisto;
  const role = new URLSearchParams(location.search).get('role');
  if (!['student', 'teacher'].includes(role)) { location.replace('/'); return; }
  const label = role === 'teacher' ? 'Teacher / Admin' : 'Student';
  document.querySelector('#role-label').textContent = `${label} access`;
  document.title = `Alisto · ${label} access`;
  const form = document.querySelector('#auth-form');
  const submit = document.querySelector('#submit-button');
  const message = document.querySelector('#form-status');
  let mode = 'login';
  let ready = false;

  function setMode(next) {
    mode = next;
    const registering = mode === 'register';
    document.querySelector('#name-field').hidden = !registering;
    document.querySelector('#name').required = registering;
    document.querySelector('#password').autocomplete = registering ? 'new-password' : 'current-password';
    document.querySelector('#login-mode').setAttribute('aria-pressed', String(!registering));
    document.querySelector('#register-mode').setAttribute('aria-pressed', String(registering));
    document.querySelector('#form-title').textContent = registering ? 'Create your account' : 'Welcome back';
    document.querySelector('#form-description').textContent = registering ? `Register for ${label.toLowerCase()} access.` : 'Log in to your account to continue.';
    submit.textContent = registering ? 'Create account' : 'Log in';
    status(message, '');
  }
  document.querySelector('#login-mode').addEventListener('click', () => setMode('login'));
  document.querySelector('#register-mode').addEventListener('click', () => setMode('register'));

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!ready) return;
    const password = form.elements.password.value;
    if (new TextEncoder().encode(password).length > 72) {
      status(message, 'Password must be at most 72 UTF-8 bytes.', true); return;
    }
    submit.disabled = true;
    document.querySelector('#login-mode').disabled = true;
    document.querySelector('#register-mode').disabled = true;
    status(message, mode === 'register' ? 'Creating your account…' : 'Logging in…');
    try {
      await api(`/api/auth/${mode}`, { method: 'POST', body: {
        role, name: form.elements.name.value, email: form.elements.email.value, password
      } });
      location.assign(`/${role}.html`);
    } catch (error) { status(message, error.message, true); }
    finally {
      submit.disabled = false;
      document.querySelector('#login-mode').disabled = false;
      document.querySelector('#register-mode').disabled = false;
    }
  });

  try { await api('/api/auth/csrf'); ready = true; submit.disabled = false; }
  catch { status(message, 'Could not connect to Alisto. Refresh this page to try again.', true); }
})();
