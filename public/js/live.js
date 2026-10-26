'use strict';

window.AlistoLive = (() => {
  function duration(seconds) {
    const value = Math.max(0, Math.floor(seconds || 0));
    return `${Math.floor(value / 3600).toString().padStart(2, '0')}:${Math.floor(value / 60 % 60).toString().padStart(2, '0')}:${(value % 60).toString().padStart(2, '0')}`;
  }
  function rate(value) { return value === null || value === undefined ? 'N/A' : `${value.toFixed(2)}%`; }
  function sessionLabel(session) {
    return session.status === 'interrupted' ? 'Ended due to interruption' : session.status === 'ended' ? 'Ended' : 'Live';
  }
  function create({ onUpdate, onState, onSessionsChanged, onSessionDeleted = () => {} }) {
    const socket = io({
      autoConnect: false,
      auth: async callback => {
        try { const result = await Alisto.api('/api/auth/csrf'); callback({ csrfToken: result.csrfToken }); }
        catch { callback({}); }
      }
    });
    socket.on('presence:update', onUpdate);
    socket.on('sessions:changed', onSessionsChanged);
    socket.on('session:deleted', onSessionDeleted);
    socket.on('connect', () => onState(true, 'Connected to live updates.'));
    socket.on('disconnect', reason => onState(false, reason === 'io server disconnect'
      ? 'Connection closed. Log in again if your session expired.' : 'Connection offline. Reconnecting; showing last received measurements.'));
    socket.on('connect_error', () => onState(false, 'Cannot connect to live updates. Retrying; log in again if your session expired.'));
    return {
      socket,
      async request(event, payload) {
        if (!socket.connected) throw new Error('Wait for the live connection before trying again.');
        let result;
        try { result = await socket.timeout(10000).emitWithAck(event, payload); }
        catch { throw new Error('No response received. Check your connection and try again.'); }
        if (!result.ok) {
          const error = new Error(result.error); error.status = result.status; throw error;
        }
        return result.data;
      }
    };
  }
  return { duration, rate, sessionLabel, create };
})();
