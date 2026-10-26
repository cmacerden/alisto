'use strict';

function formatDuration(seconds) {
  const value = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const hours = Math.floor(value / 3600);
  const minutes = String(Math.floor(value / 60) % 60).padStart(2, '0');
  const remaining = String(value % 60).padStart(2, '0');
  return `${hours}:${minutes}:${remaining}`;
}

if (typeof module !== 'undefined') module.exports = { formatDuration };
