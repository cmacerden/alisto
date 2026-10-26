const fs = require('node:fs');
const path = require('node:path');
const lockfile = require('proper-lockfile');

function acquireInstanceLock(databasePath) {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  let release;
  try {
    // Obtain exclusive ownership before startup recovery can alter live rows.
    release = lockfile.lockSync(databasePath, { realpath: false, stale: 10000, update: 2000 });
  } catch (error) {
    if (error.code === 'ELOCKED') {
      error.message = 'This Alisto database is already in use. Stop the other server first. After an abrupt stop, wait 10 seconds before retrying.';
    }
    throw error;
  }
  let released = false;
  return () => { if (!released) { released = true; release(); } };
}

module.exports = { acquireInstanceLock };
