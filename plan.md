# Alisto — Approved Project Plan

**Status:** Approved specification. Phases 1–2 implemented and verified. Phases 3–5 have not started.

All rules and implementation defaults below form the agreed baseline.

## Approved direction change — Google Meet Chrome extension

This section supersedes conflicting browser-companion, class-code, and connection-presence requirements below. Phases 1–2 retain original website behavior for historical compatibility. The Chrome extension foundation and Meet-linked presence prototype are implemented; actual live Meet detector validation and participation remain pending.

- Delivery: a Chrome side-panel extension used alongside Google Meet, reusing the Alisto backend and Student / Teacher/Admin accounts. Embedded Jitsi is no longer planned.
- Session identification: use the Google Meet meeting code/link instead of the generated six-character Alisto join code. Keep Alisto class records and teacher ownership; a Meet code must not bypass login or authorize access to private reports. Preserve existing codes and historical records during migration.
- Activity Rate: measure detected time joined to the session's matching Google Meet call, not merely time connected to Alisto. Retain the 60-second uninterrupted grace period, restart grace only before measurement begins, and count later out-of-call time in the denominator until the teacher ends the Alisto session. No measured time means N/A.
- Detection: bind local Meet call membership observations to the authenticated Alisto account and matching live session. These are browser-reported signals, not independent proof of attendance or attention. Meet page changes can break detection. Approved failure behavior: show “Cannot verify” as a detection-quality notice, not confirmed absence or a new presence state. Exclude unverifiable intervals from both active time and total measured time; never credit them as in-call time or count them as absence. Reports must disclose excluded unverifiable duration so a rate is not mistaken for complete coverage. Grace requires 60 uninterrupted seconds of verified in-call membership; an unverifiable interval before grace completes breaks that verified streak. Once measurement has begun, uncertainty does not restart grace.
- Privacy: do not track camera/mic state or use, attention, tab focus, mouse/keyboard activity, screenshots, or recordings. No separate video-activity score or additional video-activity indicator.
- Retained features: separate General Chat and Participation Chat, timed prompts, response visibility, participation calculations/classifications, role-specific dashboards, and session reports with planned CSV/email delivery. These run through Alisto, not Google Meet's native chat.
- Remaining work: validate/adapt detection against current live Google Meet UI and school Chrome policies, deploy a shared HTTPS backend, then implement participation and complete reports.

### Extension foundation implemented

- `extension/manifest.json` packages a Manifest V3 native side panel with narrowly scoped Google Meet/local-backend host permissions, top-frame call-detector content script, and temporary session-storage bindings.
- Student/Teacher registration/login/logout reuse existing HttpOnly backend sessions and CSRF checks. The extension requests neither cookie-reading nor credential-storage permissions.
- Teacher class creation/listing and role-authorized saved presence history work through the existing API. Historical rates are explicitly labeled as legacy Alisto connection measurements.
- User verified unpacked extension loading, login, and existing-class display in Chrome. The prototype now starts teacher-owned sessions on actual Meet codes and lets logged-in students explicitly connect matching tabs. It cannot join legacy sessions or credit login/URL alone as in-call time.
- Meet counters use separate version-3 tables so old results retain their meaning. Fresh browser signals are valid for at most 15 seconds; unknown intervals are excluded, incomplete grace resets, and sources aggregate conservatively without double counting. Unknown live status is null with a “Cannot verify” notice, never confirmed absence. Saved results disclose unverifiable time since enrollment.
- Verification: 118 automated tests pass, including migration/legacy compatibility, Meet HTTP authorization/lifecycle, grace/uncertainty/expiration, multiple sources, recovery/locking/privacy, detector fixtures, worker sender/document/tab/account validation, room discovery with withheld URLs and /meet/code paths, manual teacher room selection, session deletion, and extension class deletion. Deletion tests cover ownership/CSRF/confirmation, live-session protection, transactional cleanup/rollback, socket subscription removal, and non-reused session IDs across migration/restart. Isolated UI checks cover cancellation, deletion, history/result cleanup, class preservation, and student tab discovery/connection with a withheld URL while retaining Cannot verify for uncertain membership. Automated tests and mocked UI checks do not establish compatibility with Google's current live DOM.
- Version 0.2.1 addresses a reported session-start blocker when the sidebar cannot read the active Meet URL: teachers can paste the actual Meet code/link. Known conflicts with the detected room are rejected. Current-window lookup also falls back to the focused window only when no current tab is returned. Student observation requirements remain unchanged. An isolated UI test confirms fallback session creation with a withheld tab URL; the user's specific Chrome tab-access cause is not yet confirmed.
- User confirmed that session creation now works. Version 0.2.2 adds the requested Teacher-only session deletion: owned ended/interrupted sessions can be permanently removed after inline confirmation; live sessions must be ended first. Deletion removes that session's presence measurements from teacher/student history, not classes/accounts or other sessions. Additional linked records block deletion transactionally. No user sessions are automatically deleted. This explicit deletion permission supersedes unconditional historical-retention wording below.
- Additive schema version 4 stores a session-ID high-water mark so deleted IDs cannot be reused by stale report links, confirmation buttons, or extension bindings. Existing counters and account/class records are retained during migration.
- Version 0.2.3 exposes the existing Teacher-owned class-deletion API in the extension. Inline confirmation includes Cancel; classes with live/saved sessions have a disabled Delete class button and instructions to remove sessions explicitly first. The backend's foreign-key protections still apply. Busy controls retain their prior disabled state. Isolated UI checks confirm cancellation sends no DELETE, confirmed deletion removes only the empty test class, and linked-session classes/history remain protected. This extension-only change needs no backend restart and deletes no existing user classes automatically.
- Version 0.2.4 addresses the reported student pre-connection error by adding validated top-frame page-script room discovery when tab.url is unavailable, explicit Find Meet tabs selection, and support for standard account-prefixed meeting routes. Known non-Meet URLs and mismatched/stale documents remain rejected. Site-access/refresh/incognito instructions are shown instead of claiming the user is outside the call. No extra permissions or backend restart are needed. Exact behavior in the user's live Chrome window still needs confirmation after reloading Alisto and refreshing Meet.
- The user then supplied an actual /meet/<meeting-code> URL, confirming a parser-format mismatch. Version 0.2.5 adds that precise route to the shared strict-host parser. Regression tests cover sidebar/picker identification, teacher input, page samples, and worker enrollment/observations, while retaining unknown membership when only the URL is known. Reload Alisto and refresh the Meet page; no backend restart is required.
- Next implementation milestone: reload the updated extension, refresh Meet tabs, and validate teacher/student join, grace, leave/rejoin, unknown states, and ending in a real Meet call. Then implement chat/participation and full reports.

## 1. Purpose and boundaries

**Project title:** Alisto: An Online Class Idle and Engagement Monitoring System.

Despite the title, Alisto measures connection-based presence and participation only. It does not detect idle behavior, attention, or learning.

Alisto is a lightweight browser-based companion running alongside Zoom, Google Meet, or Teams. It answers who is connected and who responded to required participation prompts.

### Principles

- Presence: Active means connected; Offline means disconnected.
- Transparency: students and teachers see the same calculated rates.
- Privacy: no monitoring outside Alisto.
- Descriptive reporting: no penalties or punitive scores.
- Simplicity: no extensions, check-in buttons, warnings, or popups.

### Out of scope

| Category | Excluded capabilities |
| --- | --- |
| Conferencing | Video calls, webcam access, microphone access |
| Surveillance | Screen recording, screenshots, other-tab/app tracking |
| Behavioral tracking | Mouse, keyboard, scroll, keystroke, or biometric tracking |
| Status and enforcement | Idle/Away states, manual status, heartbeat buttons, penalties, focus banners, warning popups |
| Integrations | Native mobile apps and LMS integrations |

## 2. Accounts, classes, and session flow

### Roles

| Role | Access |
| --- | --- |
| Student | Register/login, join live sessions, chat, respond to prompts, access personal reports |
| Teacher/Admin | One combined role; manage own classes, run sessions, monitor students, access reports and exports |

There is no separate system-wide administrator role. Teachers can access only their own classes and associated reports.

Both roles register with name, email, and password. The entry page offers Student and Teacher/Admin buttons leading to role-aware authentication and separate dashboards.

### Class codes

- Each class receives a permanent six-character code.
- Students enter the code to join that class's current live session.
- Codes are unique, case-insensitive, and randomly generated.
- Only one session per class can be live at a time.
- A code does not bypass login or grant access to private historical reports.

### Approved Phase 1 additions

- Teachers can copy a class code from its card using click-based compatibility copying or the standard Clipboard API; if both are blocked, the code is selected for manual copying.
- Teachers can permanently delete their own classes after an inline confirmation, with a Cancel option and no popup.
- Deletion requires server-side ownership and CSRF checks. Restrictive linked records block deletion rather than cascading into report/history loss.

### Normal flow

1. Teacher logs in, creates a class, and starts a session.
2. Students log in and enter the permanent class code.
3. Students join immediately as Active; their grace periods begin.
4. Teacher monitors presence, chats, and posts participation prompts.
5. Teacher ends the session; results lock and reports become available.

## 3. Presence and Activity Rate

### Presence states

| State | Meaning |
| --- | --- |
| Active | Student has a live Alisto session connection |
| Offline | Student has disconnected, left, closed the tab, or lost connection |

With multiple tabs or devices, the student remains Active while at least one authorized connection to that session exists.

Socket.IO uses automatic connection checks, not student actions. Unexpected connection loss can take a short interval to detect. Connection presence is not proof of attention or engagement.

### Approved 60-second grace rule

1. First join immediately shows Active and starts grace.
2. Disconnecting before completing grace restarts it on reconnection.
3. Measurement begins after one uninterrupted 60-second grace period.
4. Once measurement begins, grace never restarts during that session.
5. Measurement continues through subsequent disconnections until the session ends.

Repeated disconnections before completing grace can leave a student unmeasured. Reports must show this honestly rather than inventing a percentage.

### Calculation

```text
Activity Rate = active seconds / total measured seconds * 100
```

After grace:

| Connection state | Active time | Total measured time |
| --- | --- | --- |
| Connected | Increases | Increases |
| Disconnected | Unchanged | Increases |

Example:

```text
Join:             00:00
Grace completes:  01:00
Disconnect:       10:00
Session ends:     15:00

Active time:      540 seconds
Measured time:    840 seconds
Activity Rate:    64.29%
```

### Display and calculation requirements

- Before measurement begins, display "Grace period" rather than 0%.
- If measurement never begins, the final Activity Rate is N/A.
- Calculate durations using server timestamps, not browser counters.
- Display rates live to students and teachers; store final results permanently.
- Chat messages never affect Activity Rate.

## 4. General Chat and Participation Chat

### Separate chat areas

| Area | Purpose | Effect on rates |
| --- | --- | --- |
| General Class Chat | Normal teacher/student discussion | None |
| Participation Chat | Required teacher prompts and student responses | Participation Rate only |

Messages retain sender identity, role, timestamp, and session association.

### Prompt behavior

- Only one timed participation prompt can be open per session.
- Prompts are highlighted with a countdown.
- Each student's first valid response received before closure counts once.
- Extra messages do not earn extra participation credit.
- Responses after closure do not count.

### Response visibility

The student chooses visibility before sending:

| Visibility | Who can read the response |
| --- | --- |
| Everyone — default | Participants in that class session |
| Teacher only | Owning teacher and responding student |

Both choices earn identical participation credit. Private response content must never be sent to classmates' browsers.

### Participation eligibility

A prompt counts toward a student's denominator if it is posted after their first join in that session, including while they are subsequently offline.

Prompts posted before their first join do not count.

```text
Participation Rate =
eligible activities responded to / total eligible required activities * 100
```

No eligible activities means N/A, not 0%.

### Live participation buckets

Evaluate these conditions in priority order:

| Priority | Condition | Bucket |
| --- | --- | --- |
| 1 | Valid response already received | Participated |
| 2 | No valid response; student currently offline | Disconnected |
| 3 | No valid response; student online; prompt open | Pending |
| 4 | No valid response; student online; prompt closed | No Participation |

A student who responds and later disconnects stays Participated for that prompt; their separate presence status becomes Offline.

Buckets describe live conditions. Permanent history must separately retain whether each eligible prompt received a valid response.

### Participation classifications

Use the unrounded percentage for classification:

| Rate | Classification |
| --- | --- |
| 80–100% | Highly Active |
| At least 50%, below 80% | Moderately Active |
| Above 0%, below 50% | Low Participation |
| 0% | No Participation |
| N/A | Not yet applicable |

These labels describe participation frequency, not attention or academic performance.

## 5. Dashboards and reports

### Student live view

- Current Active/Offline status.
- Grace countdown or live Activity Rate.
- General Class Chat.
- Participation Chat with prompt countdown and visibility selector.
- Live Participation Rate and classification.

No focus banners, warnings, or popups.

### Teacher live view

- Student names, presence states, both rates, and participation classifications.
- Explicit list of Offline students.
- Names in each participation bucket.
- Participation totals and progress bar.
- Session controls, both chats, and reporting/export access.

Participation totals use the current prompt's eligible student population so bucket counts and denominators agree.

### Student session report

| Group | Fields |
| --- | --- |
| Session | Class title, session date, completion/interruption label |
| Presence | Total measured time after grace, connected time, Activity Rate |
| Participation | Eligible activity count, responded count, Participation Rate, classification |
| Status | Final presence status |

Students can view, download CSV, or email their own reports. Their dashboard lists past sessions.

Total measured time includes disconnection after grace; it is not simply time connected.

### Teacher session report

Teachers can view saved class-session results and export a full-class CSV containing:

```text
Name, Email, Final Status,
Active Seconds, Total Measured Seconds, Activity Rate,
Participated Count, Total Eligible Activities,
Participation Rate, Classification
```

Reports and participation history remain available after sessions end.

## 6. Session ending and interruption recovery

### Normal ending

1. Teacher ends the session immediately.
2. Any open prompt closes immediately.
3. Responses received before closure count; unanswered eligible students receive no credit for that prompt.
4. Presence measurement stops and everyone becomes Offline.
5. Final reports lock and remain accessible.

Final status is always Offline after closure. It must not be presented as proof that a student left early.

### Server-interruption recovery

1. Persist consistent measurement checkpoints during live sessions.
2. After restart, identify sessions that were interrupted.
3. Finalize them through the last saved checkpoint.
4. Label reports "Ended due to interruption."
5. Exclude subsequent downtime; teachers start a new session after recovery.

Both student and teacher reports remain available.

Checkpoint every 5 seconds, plus key state changes. Abrupt failure may lose the unsaved interval; reports should identify the saved cutoff. Recovery must use a consistent saved state for timings, prompts, and responses.

Interrupted sessions do not automatically resume.

## 7. Technical structure

### Stack

| Layer | Technology |
| --- | --- |
| Server and real-time updates | Node.js, Express, Socket.IO |
| Database | SQLite with better-sqlite3 |
| Authentication | express-session, bcryptjs |
| Email | Nodemailer |
| Frontend and export | Plain HTML/CSS/JS; server-generated CSV |

This is a single-server MVP.

### Database groups

| Group | Tables and purpose |
| --- | --- |
| Accounts | teachers, students |
| Class lifecycle | classes, sessions |
| Presence | session_students; supporting connection intervals/checkpoints |
| Chat | messages, including session and sender references |
| Participation | participation_activities, participation_responses, including response visibility |

Use persisted login sessions, foreign keys, transaction-based finalization, and uniqueness constraints preventing duplicate participation credit.

The exact column-level schema will be designed during Phase 1 while preserving these requirements.

### Required files

```text
server.js
public/index.html
public/auth.html
public/student.html
public/teacher.html
```

Supporting files:

```text
package.json
.env.example
README.md
database/schema.sql
```

Backend modules, frontend assets, and tests may be added to keep server.js manageable.

### Security and privacy requirements

- Enforce roles, class ownership, and report ownership on the server.
- Validate input, escape chat output, and protect cookie-authenticated actions.
- Hash passwords; protect login attempts; persist sessions securely.
- Filter teacher-only responses server-side, including real-time broadcasts.
- Escape CSV formula-like values; keep secrets outside source code.

### Email behavior

Configured SMTP delivers reports to the student's registered address.

Ethereal fallback is testing only: it provides an email preview but does not deliver to real inboxes. The interface must distinguish preview generation from successful delivery.

## 8. Build order and acceptance checks

| Phase | Deliverable | Key acceptance check |
| --- | --- | --- |
| 1. Foundation | Database, authentication, roles, classes | Teachers cannot access another teacher's class |
| 2. Presence | Session lifecycle, connections, grace, live rates | Reconnecting after grace does not reset measurement |
| 3. Participation | Two chats, timed prompts, visibility, buckets | Private responses never reach classmates |
| 4. Reports | Saved results, student history, CSV, email | Both roles can retrieve completed-session reports |
| 5. Reliability | Recovery, security, end-to-end tests | Interrupted sessions produce reports without counting downtime |

Additional tests must cover multiple tabs, late joins, zero eligible activities, sessions ending during grace, deadline races, and ending a session with an open prompt.

## 9. Current project state

- Specification approved, including implementation defaults.
- This plan is the implementation reference.
- Phases 1–2 implemented: accounts, persistent login, teacher-owned classes and codes, copy/delete controls, teacher-started live sessions, code-based student joining, Active/Offline presence, 60-second grace, live Activity Rates, multi-tab handling, session ending, presence history, and interruption recovery. Full participation-aware reports, CSV, and email remain deferred.
- Verification: 52 automated tests pass across foundation, clipboard, presence timing, authenticated Socket.IO/HTTP, schema migration, saved recovery, and instance locking. Browser checks cover matching live teacher/student rates, multiple tabs, leaving/rejoining without resetting completed grace, immediate ending, and saved presence results. Browser test accounts used a separate in-memory database and separate test cookies, not the application database or login cookie.
- Next implementation milestone: Phase 3 — Participation. Build General Chat, Participation Chat, timed prompts, response visibility, participation buckets, rates, and classifications.

### Phase 2 implementation notes

- Version-2 migration adds sessions and session_students without replacing existing account, class, or login-session tables.
- Server-owned millisecond counters are projected into live snapshots approximately once per second. Consistent checkpoints are saved every 5 seconds and on connection/lifecycle changes.
- Interruption recovery locks saved presence results at the last checkpoint and excludes later downtime. The server entry point acquires an exclusive instance lock before recovery; an abruptly abandoned lock may take 10 seconds to expire.
- Student snapshots contain only the requesting student's measurements. Socket authentication, CSRF-bound handshakes, role/ownership checks, logout, and login expiration are enforced server-side.
- Classes with session history cannot be deleted, preserving saved results. Phase 2 history exposes presence-only summaries; full reports and delivery/export remain Phase 4.
