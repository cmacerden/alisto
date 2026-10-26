const { test } = require('node:test');
const assert = require('node:assert/strict');
const { detectMeetMembership } = require('../extension/detector');

function element(text, { label, tooltip, hidden = false, disabled = false, opacity = '1' } = {}) {
  return {
    textContent: text, disabled, opacity, closest: () => hidden ? {} : null,
    getAttribute: name => name === 'aria-label' ? label : name === 'data-tooltip' ? tooltip : null,
    getClientRects: () => hidden ? [] : [{}]
  };
}
function detect(buttons = [], headings = []) {
  return detectMeetMembership({
    defaultView: { getComputedStyle: el => ({ display: 'block', visibility: 'visible', opacity: el.opacity }) },
    querySelectorAll: selector => selector.startsWith('button') ? buttons : headings
  });
}

test('Meet adapter never infers membership just because a meeting URL/page or media controls exist', () => {
  assert.equal(detect(), 'unknown');
  assert.equal(detect([element('Turn off microphone'), element('Turn off camera')]), 'unknown');
});

test('visible enabled Leave call control is required for an in-call signal', () => {
  assert.equal(detect([element('call_end', { label: 'Leave call' })]), 'in');
  assert.equal(detect([element('', { label: 'Leave call (Ctrl + Alt + H)' })]), 'in');
  assert.equal(detect([element('', { tooltip: 'Leave the call' })]), 'in');
});

test('prejoin controls and explicit left-meeting headings identify out-of-call pages', () => {
  assert.equal(detect([element('Join now')]), 'out');
  assert.equal(detect([element('Ask to join')]), 'out');
  assert.equal(detect([], [element("You've left the meeting")]), 'out');
});

test('conflicting, hidden, disabled, transparent, and unsupported-language controls cannot verify membership', () => {
  assert.equal(detect([element('Leave call'), element('Join now')]), 'unknown');
  assert.equal(detect([element('Leave call', { hidden: true })]), 'unknown');
  assert.equal(detect([element('Leave call', { disabled: true })]), 'unknown');
  assert.equal(detect([element('Leave call', { opacity: '0' })]), 'unknown');
  assert.equal(detect([element('Quitter l’appel')]), 'unknown');
});

test('camera/microphone state changes do not change detected call membership', () => {
  for (const media of ['Turn on microphone', 'Turn off microphone', 'Turn on camera', 'Turn off camera']) {
    assert.equal(detect([element('Leave call'), element(media)]), 'in');
  }
});
