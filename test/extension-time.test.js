const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { formatDuration } = require('../extension/time');

test('extension durations display hours, minutes, and seconds without wrapping at 24 hours', () => {
  for (const [seconds, expected] of [
    [0, '0:00:00'], [9, '0:00:09'], [59, '0:00:59'], [60, '0:01:00'],
    [90, '0:01:30'], [3599, '0:59:59'], [3600, '1:00:00'],
    [5400, '1:30:00'], [90061, '25:01:01'], [1.9, '0:00:01']
  ]) assert.equal(formatDuration(seconds), expected);
});

test('missing, negative, and non-finite durations display zero', () => {
  for (const value of [undefined, null, -1, NaN, Infinity]) {
    assert.equal(formatDuration(value), '0:00:00');
  }
});

test('sidebar loads duration formatting before its UI and uses it for the grace countdown', () => {
  const html = fs.readFileSync(path.join(__dirname, '../extension/panel.html'), 'utf8');
  const panel = fs.readFileSync(path.join(__dirname, '../extension/panel.js'), 'utf8');
  assert.ok(html.indexOf('src="time.js"') < html.indexOf('src="panel.js"'));
  assert.match(panel, /function duration\(seconds\) \{ return formatDuration\(seconds\); \}/);
  assert.match(panel, /duration\(Math.ceil\(student.grace_remaining_ms \/ 1000\)\)/);
});
