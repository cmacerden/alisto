const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { acquireInstanceLock } = require('../lib/instance-lock');

function fixture(t) {
  const root = process.platform === 'win32' && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : os.tmpdir();
  fs.mkdirSync(root, { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, 'alisto-lock-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'database.sqlite');
}

test('a second server cannot own the same database or trigger recovery', t => {
  const filename = fixture(t);
  fs.writeFileSync(filename, 'untouched database contents');
  const release = acquireInstanceLock(filename);
  try {
    assert.throws(() => acquireInstanceLock(filename), { code: 'ELOCKED' });
    assert.equal(fs.readFileSync(filename, 'utf8'), 'untouched database contents');
  } finally { release(); }
  const nextRelease = acquireInstanceLock(filename);
  nextRelease(); nextRelease();
});

test('an abandoned instance lock can be recovered after the stale interval', t => {
  const filename = fixture(t);
  const lockPath = `${filename}.lock`;
  fs.mkdirSync(lockPath);
  const stale = new Date(Date.now() - 60000);
  fs.utimesSync(lockPath, stale, stale);
  const release = acquireInstanceLock(filename);
  release();
  assert.equal(fs.existsSync(lockPath), false);
});
