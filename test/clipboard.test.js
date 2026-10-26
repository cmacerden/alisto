const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/js/common.js'), 'utf8');

function browser({ legacy = false, modern = 'available' } = {}) {
  const calls = { native: [], commands: [], removed: false, restoredFocus: false, selected: false, rangeRestored: false };
  const range = { cloneRange() { return this; } };
  const selection = {
    rangeCount: 1, getRangeAt: () => range, removeAllRanges() {},
    addRange(saved) { calls.rangeRestored = saved === range; }
  };
  const input = {
    setAttribute() {}, focus() {}, select() { calls.selected = true; },
    setSelectionRange(start, end) { calls.selectionBounds = [start, end]; },
    remove() { calls.removed = true; }
  };
  const document = {
    activeElement: { focus() { calls.restoredFocus = true; } },
    body: { append(element) { calls.appended = element; } },
    createElement(tag) { assert.equal(tag, 'textarea'); return input; },
    execCommand(command) {
      calls.commands.push(command);
      if (legacy === 'throws') throw new Error('Blocked');
      return legacy;
    }
  };
  const navigator = modern === 'missing' ? {} : { clipboard: {
    async writeText(text) {
      calls.native.push(text);
      if (modern === 'denied') throw new Error('Permission denied');
    }
  } };
  const window = { getSelection: () => selection };
  vm.runInNewContext(source, { window, document, navigator });
  return { copyText: window.Alisto.copyText, calls, input, document };
}

test('copy works when Clipboard API is denied but click-based copying is allowed', async () => {
  const { copyText, calls, input } = browser({ legacy: true, modern: 'denied' });
  const result = copyText('ABC234');
  // Compatibility copying must happen before the first await.
  assert.equal(calls.commands[0], 'copy');
  assert.equal(input.value, 'ABC234');
  assert.equal(await result, true);
  assert.equal(calls.native.length, 0);
  assert.equal(calls.selected, true);
  assert.deepEqual(calls.selectionBounds, [0, 6]);
});

test('copy falls back to the standard Clipboard API', async () => {
  const { copyText, calls } = browser();
  assert.equal(await copyText('DEF567'), true);
  assert.deepEqual(calls.native, ['DEF567']);
});

test('unsupported or throwing compatibility copying still tries the standard API', async () => {
  for (const unsupported of [false, true]) {
    const context = browser({ legacy: 'throws' });
    if (unsupported) delete context.document.execCommand;
    assert.equal(await context.copyText('GHI234'), true);
  }
});

test('copy reports failure honestly when both browser methods are blocked', async () => {
  for (const modern of ['missing', 'denied']) {
    const { copyText } = browser({ modern });
    assert.equal(await copyText('JKL567'), false);
  }
});

test('copy removes temporary controls and restores focus and selection on all paths', async () => {
  for (const legacy of [true, false, 'throws']) {
    const { copyText, calls } = browser({ legacy, modern: 'denied' });
    await copyText('MNP234');
    assert.equal(calls.removed, true);
    assert.equal(calls.restoredFocus, true);
    assert.equal(calls.rangeRestored, true);
  }
});
