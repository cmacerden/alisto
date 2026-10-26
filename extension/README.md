# Alisto Chrome extension — Meet presence prototype (0.2.5)

The primary interface is a Manifest V3 Chrome side panel, backed by the existing Node/SQLite server. The old website remains for compatibility and history. Existing accounts, classes, and results are preserved.

## Implemented

- Student / Teacher/Admin registration, login, logout, and role-specific views; teacher-owned class creation/listing.
- Teacher-started sessions bound to the **actual Google Meet code** read from the current meeting tab, for example `abc-defg-hij`. A class or Meet code can have only one live Alisto session. A code identifies a session; it does not bypass login or reveal private reports.
- Explicit student **Connect this Meet tab**, browser-reported in/out-of-call detection, 60-second grace, live Activity Rate, and excluded uncertain time. Closing the sidebar does not stop detection in an open, connected Meet tab. Additional tabs must be connected separately; same-profile tabs are aggregated rather than counted twice.
- Teacher roster / student-only measurements, ending and locked saved presence results, plus interruption recovery. Saved website results remain labeled **legacy Alisto connection time**, never converted into Meet time.
- Teacher-only deletion of an owned ended/interrupted session, with inline Cancel / permanent-delete confirmation. Its presence data and results disappear from both teacher and student history; accounts, classes, other sessions, and the Google Meet call are unchanged. Live sessions cannot be deleted.
- Teacher-only class deletion from **Your classes**, with inline confirmation. Classes with live/saved sessions remain protected until their sessions are explicitly removed; no reports are automatically cascaded away.

Not implemented: General Chat, Participation Chat, timed prompts, Participation Rates, complete reports, CSV, and email.

**Prototype limitation:** the detector is a conservative English-language Meet UI adapter, not an official Meet attendance API. Actual Google Meet layouts must be tested manually. An unsupported layout/language displays **Cannot verify**. These signals can be affected by page changes, throttled browser timers, device sleep, connectivity, or client tampering. They do not independently verify attendance, Google identity, attention, or learning. Alisto class ownership does not prove the teacher is the Google Meet host.

## Install / update locally — about 3 minutes

1. Run the updated backend with `npm.cmd start` on Windows (`npm start` elsewhere). Do not start a second server if port 3000 is already running. Back up the database before the additive version-4 upgrade (Meet tables were introduced in version 3; version 4 prevents deleted session IDs from being reused).
2. Open `chrome://extensions`; enable **Developer mode**, then **Load unpacked** and select the `extension` folder. If already installed, click Alisto's **Reload** button. Approve the newly required storage permission if prompted.
3. **Refresh each existing Meet tab once** so the new content script loads. Pin Alisto and open it from the meeting tab using its toolbar icon.
4. Log in/register. Existing Alisto accounts work. The local backend must remain running.

Folder on this machine: `C:\Users\Maxenne Acerden\Documents\Default Project\extension`.

## Classroom test — about 4 minutes

1. As teacher, open the real Meet room and Alisto sidebar. Check the displayed meeting code. If Chrome does not expose it to the sidebar, paste the actual Meet link or `abc-defg-hij` code into **Google Meet link or code (fallback)** above your classes. On your class click **Start Meet session**. A pasted code that conflicts with the detected tab is rejected; clear the fallback field when switching rooms. If a legacy website session is still live for that class, end it there first.
2. In a separate Chrome profile, install the same extension and log in as a student. Join that **same Google Meet call**, open Alisto, and click **Connect this Meet tab**. If the active tab is not identified, click **Find Meet tabs**, choose the matching actual code, then connect. Opening the meeting URL/prejoin page alone must not mark the student Active.
3. Confirm **Active · detected in call**, matching teacher/student rates, and 60-second grace. After grace, in-call and measured time increase. Turning camera/mic on/off or switching tabs must not affect the rate.
4. Leave the call while keeping the Meet exit page open. When recognizable, it shows **Offline · detected out of call**; measured time continues after grace. Unrecognized UI, disabled detector, or stale observations show **Cannot verify**, and uncertain time is excluded. Missing evidence expires after 15 seconds, so closing a tab/browser or network loss must not create unlimited in-call time or unlimited assumed absence.
5. As teacher, click **End Alisto session**. Counters lock and saved results include excluded time. This ends Alisto measurement only; it does not hang up anyone's Google Meet call.

The extension samples roughly every 5 seconds (UI changes may trigger a sample sooner), and the sidebar refreshes roughly every 5 seconds. Detection/requests are not instantaneous. Browser throttling can cause gaps; gaps are not attention penalties.

The teacher fallback selects a room only; it does not certify that the teacher joined it or grant student presence credit. Student connection still requires a matching real Meet tab and call-state evidence. No extra permissions are required for fallback entry. When the side panel has no current-window tab, it also tries the active tab in the last focused window; it never silently selects an unrelated background meeting.

### Student tab not detected

Version 0.2.4 adds a top-frame page-script fallback when Chrome does not expose `tab.url`, plus the explicit **Find Meet tabs** picker. The picker queries only `https://meet.google.com/*`, displays room codes/tab IDs without page titles, and does not connect or grant attendance until the student clicks Connect. Known non-Meet URLs are never replaced by a pasted code or script fallback. Standard `/u/<account-number>/<meeting-code>` routes are also recognized.

Version 0.2.5 also recognizes Google's `/meet/<meeting-code>` URL format, alongside `/<meeting-code>`. The shared parser is used by the sidebar, tab picker, content script, teacher link input, and worker, so all identify the same room code. Reload the extension and refresh the Meet tab to replace the old content-script parser. Recognizing the URL still does not prove in-call membership.

Reload Alisto in `chrome://extensions`, **refresh the Meet page**, and rejoin the call if needed so the updated content script is installed. If no readable tabs are listed, check Alisto's **Site access** for `meet.google.com`; for private windows enable **Allow in Incognito** in extension details. A missing/blocked page script cannot be treated as proof of attendance. No new permissions or backend restart are required.

The page-script response includes a validated Meet address stripped of query/fragment data, code, and current membership signal. This address is used locally to identify the real tab when its URL is withheld; the backend still receives only the existing code/source/state payload. The worker rechecks the current document before refreshing evidence. Identifying the room does not by itself change a Cannot verify membership result into Active.

## Delete a saved session — about 30 seconds

In the Teacher sidebar's **Session history**, choose an ended/interrupted session and click **Delete session**. Read the session title/date and warning, then choose **Cancel** or **Permanently delete session**. Cancellation sends no deletion request. Confirmed deletion is irreversible through Alisto and removes saved presence results for all enrolled students. Refresh other open extension panels to clear cached history/results. This does not delete the class or end a Google Meet call.

Existing backups and previously exported copies are not erased by this action.

You must **End Alisto session** before deleting a live session. Backend checks teacher ownership, CSRF, and explicit confirmation; it deletes related presence records in one transaction. Unexpected linked records block deletion and roll back cleanup. Session IDs are never reused, preventing old links or extension bindings from selecting a new session after deletion. Nothing is automatically deleted.

## Delete a class — about 30 seconds

Under **Your classes**, click **Delete class**, then choose **Cancel** or **Permanently delete class**. Only the owning Teacher can delete it. This removes the Alisto class and its legacy code, not the teacher account or Google Meet meeting. No extra permissions or backend restart are required for this extension update; it uses the existing protected class-deletion API.

If **Delete class** is disabled, the class still has a live or saved session. End any live Alisto session, explicitly delete that class's sessions from **Session history**, then refresh. Deleting those sessions permanently removes their results for all enrolled students. The backend also refuses class deletion if any linked records remain, even if another panel's class list is stale. Cancellation sends no deletion request.

Use separate Chrome profiles for teacher/student testing: Alisto website tabs and the extension share the backend's HttpOnly cookie in a profile. Logout/account changes affect other Alisto tabs in that profile. Incognito must be explicitly enabled in extension details; split incognito mode keeps its worker/login separate. A browser restart clears temporary tracking bindings, so reconnect from the sidebar. Existing server evidence expires; it is never assumed to remain in-call indefinitely.

## Timing and uncertainty

- Sidebar durations and grace countdowns use `H:MM:SS` (for example, `1:30:00`); live and saved measurements use the same format. This is display formatting only; server counters remain in seconds/milliseconds.
- All accounting uses **server receipt timestamps**, not client-submitted counters or backdated times. A source report remains usable for at most 15 seconds; the following gap is unverifiable.
- Grace needs 60 uninterrupted seconds of fresh in-call signals. Out/unknown evidence breaks incomplete grace. Once measurement starts, grace never restarts for that Alisto session.
- After grace: detected in-call time increases numerator and denominator; confirmed out-of-call time increases denominator only; unverifiable time increases neither. No measured time is **N/A**. Reports expose all unverifiable time **since enrollment**, including any before grace.
- With multiple sources, fresh in-call evidence wins; otherwise any stale/unknown source makes membership unverifiable rather than inventing absence. Stale sources can therefore prevent a confirmed out-of-call result. At most eight browser sources can enroll per student per session.
- Ending/recovery locks counters and final status Offline. Recovery uses the last saved consistent checkpoint and never counts restart downtime. This status does not imply the student left early.

## Security / privacy

- Permissions: `sidePanel`, `storage`, Google Meet host access, and the fixed local backend host. No blanket `tabs`, cookie-reading, camera/mic, or all-sites permission. Tracking bindings use **`chrome.storage.session`**, not durable credential storage; passwords, cookies, and CSRF tokens are not saved there.
- A top-frame isolated content script checks visible call/join controls and exit headings. It sends the meeting code, `in` / `out` / `unknown`, and a query-free Meet page address to the worker for local tab validation; the backend receives only code/source/state. It does not read participant lists or Meet chat, inspect media streams, record content, or track camera/mic state, focus history, mouse, or keyboard activity.
- The worker validates extension/message origins, frame and tab/room identity, and current document samples. Only explicitly connected tabs report to an enrolled session. It rechecks the authenticated student before submitting observations, survives worker suspension using temporary bindings, and never exposes a generic fetch proxy.
- Fixed-destination cookie-authenticated API requests retain CSRF, role, ownership, source-enrollment, and observation rate-limit checks. No remote scripts, wildcard CORS, or weakened backend security headers. See Chrome's [network requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests) and [cookie behavior](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies) documentation.
- Backend is fixed to `http://localhost:3000` for development. Other computers cannot use your localhost. A shared HTTPS backend, narrowly updated host/CSP configuration, school permissions, and real-browser testing are required before classroom deployment. If cookie restrictions prevent login, inspect site/managed policies; do not disable browser protection globally or make session cookies JavaScript-readable.

## Tests / preview

Run `npm.cmd test` from the project root. Tests cover legacy compatibility/migration, Meet-code HTTP lifecycle and authorization, grace/unknown-time projection, evidence expiration, multiple sources, locking/recovery/privacy, detector fixtures, and worker messaging/account/tab behavior. Tests do not prove compatibility with Google's current live DOM or every Chrome cookie policy.

For an isolated **UI-only** preview, run `node scripts/preview-extension.js`, then open `http://127.0.0.1:3002/panel.html`. Login: `teacher@preview.example` / `student@preview.example`, password `ExtensionTest123!`. Mocked Chrome APIs, synthetic call signals, rewritten same-origin API requests, an in-memory database, and a separate cookie are used; the real application database is untouched. `window.fixtureCallState` can be `in`, `out`, or `unknown` for UI checks. Stop with Ctrl+C. This is not a real Meet or extension-environment test.
