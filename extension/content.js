'use strict';

(() => {
  let timer;
  let stopped = false;
  let lastReportAt = 0;
  function sample() {
    const meetCode = meetCodeFromUrl(location.href);
    return { meetCode, pageUrl: meetCode ? `${location.origin}${location.pathname}` : null,
      state: meetCode ? detectMeetMembership(document) : 'unknown' };
  }
  async function report() {
    if (stopped) return;
    if (Date.now() - lastReportAt < 4000) return;
    lastReportAt = Date.now();
    try { await chrome.runtime.sendMessage({ type: 'ALISTO_MEET_OBSERVATION', ...sample() }); }
    catch {
      // Reloading the extension invalidates existing content-script contexts.
      // Stop instead of accumulating errors; server evidence will expire.
      if (!chrome.runtime?.id) { stopped = true; clearInterval(timer); observer.disconnect(); }
    }
  }
  let pending;
  const observer = new MutationObserver(() => {
    clearTimeout(pending);
    pending = setTimeout(report, 250);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true,
    attributes: true, attributeFilter: ['aria-label', 'disabled', 'hidden', 'style', 'class'] });
  // Periodic samples keep evidence fresh even when Meet's UI is unchanged.
  timer = setInterval(report, 5000);
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id === chrome.runtime.id && message?.type === 'ALISTO_MEET_SAMPLE') sendResponse(sample());
  });
  report();
})();
