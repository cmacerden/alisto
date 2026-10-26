'use strict';

function createExtensionApi(fetchRequest = fetch) {
  const base = 'http://localhost:3000';
  let csrfToken;
  const allowedPath = /^\/api\/(?:auth\/(?:csrf|me|login|register|logout)|classes(?:\/[1-9]\d*)?|sessions(?:\/[1-9]\d*(?:\/end)?)?|meet\/(?:live\/[a-z]{3}-[a-z]{4}-[a-z]{3}|classes\/[1-9]\d*\/sessions|sessions\/[1-9]\d*\/(?:join|observe)))$/;

  async function request(path, { method = 'GET', body } = {}) {
    if (!allowedPath.test(path) || !['GET', 'POST', 'DELETE'].includes(method) ||
        (method === 'DELETE' && !/^\/api\/(?:sessions|classes)\/[1-9]\d*$/.test(path))) throw new Error('Unsupported Alisto request.');
    if (method !== 'GET' && !csrfToken) await request('/api/auth/csrf');
    let response;
    try {
      response = await fetchRequest(`${base}${path}`, {
        method, credentials: 'include', cache: 'no-store', redirect: 'error',
        signal: AbortSignal.timeout(10000),
        headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(method !== 'GET' ? { 'X-CSRF-Token': csrfToken } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined
      });
    } catch {
      throw new Error('Cannot reach Alisto. Start the backend at http://localhost:3000 and retry.');
    }
    let result;
    try { result = await response.json(); }
    catch { throw new Error('Alisto returned an invalid response. Check the backend address.'); }
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw new Error('Alisto returned an invalid response. Check the backend address.');
    }
    if (!response.ok) {
      if ([401, 403].includes(response.status)) csrfToken = undefined;
      const error = new Error(result.error || 'The request could not be completed.');
      error.status = response.status;
      throw error;
    }
    if (result.csrfToken) csrfToken = result.csrfToken;
    if (path === '/api/auth/logout') csrfToken = undefined;
    return result;
  }
  return { request };
}

if (typeof module !== 'undefined') module.exports = { createExtensionApi };
