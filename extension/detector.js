'use strict';

// Conservative English-language UI adapter. Never infer membership from the
// meeting URL, microphone/camera controls, participant names, or tab focus.
function detectMeetMembership(document) {
  function visible(element) {
    if (element.disabled || element.closest('[hidden], [aria-hidden="true"]')) return false;
    const style = document.defaultView.getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && element.getClientRects().length > 0;
  }
  const controls = [...document.querySelectorAll('button, [role="button"]')].filter(visible);
  const labels = controls.flatMap(element => [element.getAttribute('aria-label'), element.getAttribute('data-tooltip'), element.textContent]
    .filter(Boolean).map(value => value.trim().replace(/\s+/g, ' ')));
  const inside = labels.some(value => /^Leave (?:the )?call(?:\s*\([^)]*\))?$/i.test(value));
  const outside = labels.some(value => /^(?:Join now|Ask to join)$/i.test(value)) ||
    [...document.querySelectorAll('h1, h2, [role="heading"]')].filter(visible)
      .some(element => /^(?:You left the meeting|You've left the meeting|You have left the meeting)[.!]?$/i.test(element.textContent.trim()));
  return inside === outside ? 'unknown' : inside ? 'in' : 'out';
}

if (typeof module !== 'undefined') module.exports = { detectMeetMembership };
