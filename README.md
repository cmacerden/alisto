# Alisto

A Google Meet classroom companion moving to a Chrome extension, backed by Node.js and SQLite. The approved specification is in [plan.md](plan.md).

## Chrome extension — Meet presence prototype ready

The new interface is in [`extension/`](extension/README.md). It provides role-based account access, classes, sessions linked to the **actual Google Meet code**, browser-reported call presence, grace/Activity Rates, excluded uncertain time, teacher monitoring, and saved presence results. Reload the extension and refresh existing Meet tabs to update. The backend remains required.

Students whose current tab is not recognized can use **Find Meet tabs** to choose the actual meeting. A verified top-frame page-script fallback handles withheld tab URLs without granting attendance merely from a room code. Missing page scripts require a Meet-page refresh/site-access check.

**Prototype, not independently verified attendance:** an English Meet UI adapter detects recognizable membership controls; unsupported UI or missing evidence shows **Cannot verify**. An open Meet tab alone earns no call time. **Not yet enabled:** chats, participation, full reports/CSV/email. Old website sessions below still measure **Alisto connection time**. Version-3 migration preserves them and stores Meet measurements separately; additive version 4 adds a monotonic session-ID allocator for safe explicit history deletion.

Teachers can now delete their own ended/interrupted sessions from extension **Session history**, after an inline permanent-deletion confirmation. This removes that session and its presence results from teacher and student history; it does not delete accounts, classes, other sessions, or the Google Meet call. Live sessions are protected. No existing sessions are deleted automatically.

Extension **Your classes** also offers Teacher-owned class deletion with inline confirmation. Classes with live/saved sessions are protected; those sessions must be explicitly removed first. This uses the existing class DELETE endpoint and does not delete Google Meet meetings or accounts.

## Current state: Phase 2 — Presence

Implemented: role selection, student and teacher registration/login, separate dashboards, persistent SQLite login sessions, teacher-owned classes, permanent six-character class codes, code copying, and confirmed class deletion.

Phase 2 adds teacher-started live sessions, student joining by class code, Active/Offline presence, a 60-second grace period, live Activity Rates, multi-tab connection handling, session ending, saved presence summaries, and interruption recovery. Accounts, existing classes, codes, and login sessions are preserved by the additive version-2 schema upgrade.

Use **Copy code** on a class card to copy its six-character code. It tries click-based compatibility copying and the standard Clipboard API. If both are blocked, the code is selected for manual copying. **Delete class** opens an inline confirmation, not a popup. Deletion permanently removes the class and code, requires teacher ownership and CSRF protection, and is blocked if restrictive linked records exist. No classes are deleted automatically.

Not implemented yet: General Chat, Participation Chat, timed participation prompts, Participation Rates/classifications, complete session reports, CSV export, and email. Presence-only saved results are available now; they are not the complete Phase 4 reports.

## Run locally — about 2 minutes after prerequisites

Requires Node.js 22 or newer and npm. Node.js 24 LTS is recommended.

1. Install dependencies: `npm install`.
2. If npm reports a blocked native dependency script, review and approve only `better-sqlite3` using `npm install-scripts approve better-sqlite3` (newer npm versions), then run `npm rebuild better-sqlite3`.
3. Run `npm start`.
4. Open <http://localhost:3000>.

On Windows PowerShell, use `npm.cmd` instead of `npm` if execution policy blocks `npm.ps1`. No execution-policy change is required.

The app creates `data/alisto.sqlite` and a persistent development session secret in `data/session-secret`. Both are ignored by Git. Protect and back up the data directory. SQLite uses WAL mode; avoid copying a live database without a proper SQLite backup procedure.

Run only one Alisto server against a database. The server entry point obtains an exclusive instance lock before startup recovery, so launching a second server cannot close the first server's live sessions. After an abrupt process termination, the abandoned lock may require 10 seconds to expire before a restart. Normal shutdown releases it immediately. Do not manually remove a lock while its server is running.

There are no seeded accounts. Register from the appropriate role page. The same email can have separate student and teacher accounts, with independent credentials. Passwords require at least 8 characters and at most 72 UTF-8 bytes.

## Configuration

Optionally copy `.env.example` to `.env` and configure:

| Variable | Default / meaning |
| --- | --- |
| `PORT` | `3000` |
| `DATABASE_PATH` | `./data/alisto.sqlite`; relative paths resolve from the launch directory |
| `SESSION_SECRET` | Required in production; at least 32 characters; use a cryptographically random secret |
| `NODE_ENV` | Use `production` for deployment; requires HTTPS for secure cookies |
| `TRUST_PROXY` | `0`; set to `1` only behind exactly one trusted reverse proxy |

Keep the session secret stable to preserve valid logins across restarts. Do not publish `.env` or the data directory. Automatic development-secret creation is disabled in production.

## Tests

Run `npm test` (or `npm.cmd test` on Windows).

Tests use isolated temporary/in-memory SQLite databases and ephemeral local HTTP servers. Foundation tests cover authentication, validation, CSRF, persistent sessions, rate limiting, codes, ownership, and deletion. Clipboard tests cover compatibility methods and cleanup. Phase 2 tests cover grace boundaries/resets, measured disconnection, multiple tabs, late joins, locked results, startup recovery, additive migration, authenticated polling/WebSocket connections, socket logout/expiration, and roster privacy. Test data is removed afterward; the application database is untouched.

## HTTP API

| Area | Endpoints |
| --- | --- |
| Security token | `GET /api/auth/csrf` |
| Account access | `POST /api/auth/register`, `POST /api/auth/login` |
| Current account | `GET /api/auth/me`, `POST /api/auth/logout` |
| Classes — teacher only | `GET /api/classes`, `POST /api/classes`, `GET /api/classes/:id`, `DELETE /api/classes/:id` |

Session endpoints:

| Action | Endpoint and access |
| --- | --- |
| Start live session | `POST /api/classes/:id/sessions` — owning teacher |
| Session history | `GET /api/sessions` — own classes for teachers; previously joined sessions for students |
| Presence snapshot | `GET /api/sessions/:id` — owning teacher or previously joined student |
| End immediately | `POST /api/sessions/:id/end` — owning teacher |
| Permanently delete saved session | `DELETE /api/sessions/:id` with `{ "confirm": true }` — owning teacher; ended/interrupted only |

Starting a second live session for the same class returns 409. Classes with session history cannot be deleted; this protects saved results. Students receive only their own presence measurements, never another student's email or presence roster.

Meet extension endpoints (cookie login + CSRF required for writes):

| Action | Endpoint |
| --- | --- |
| Start linked session | `POST /api/meet/classes/:id/sessions` with `{ meetCode }` — owning teacher |
| Resolve current Meet room | `GET /api/meet/live/:code` — authenticated; no roster/history |
| Enroll observation source | `POST /api/meet/sessions/:id/join` with `{ meetCode, sourceId }` — student |
| Membership evidence | `POST /api/meet/sessions/:id/observe` with `{ meetCode, sourceId, state }` — enrolled student; state `in`, `out`, or `unknown` |

Meet sessions reuse authorized `GET /api/sessions/:id`, history, and teacher ending. Legacy Socket.IO student joining cannot credit Meet sessions. Evidence expires after 15 seconds; unknown intervals are excluded from numerator/denominator and disclosed as `excluded_seconds`. Unknown live snapshots have `status: null` and `detection_notice: "Cannot verify"`, not a fabricated Offline status. The extension README explains grace, multiple sources, lifecycle, and detection limitations.

Send JSON for request bodies. All state-changing API requests require the session's token in `X-CSRF-Token`. Obtain it from the security-token endpoint; successful authentication returns a replacement after session rotation. Browser requests must preserve cookies.

## Try Phase 2 — about 3 minutes

1. Log in as a teacher, create/select a class, and click **Start session**.
2. Open a private/incognito browser window for the student account so teacher and student cookies remain separate. Register/log in, enter the class code, and click **Join live session**.
3. Check that both views show Active immediately and a 60-second grace countdown. After grace, connected and measured time begin and Activity Rate becomes measurable.
4. Use **Leave this tab**, or close all student session tabs. The teacher sees Offline; reconnecting after measurement begins does not restart grace. Multiple connected tabs count as one student.
5. Click **End session now** as teacher. Everyone becomes Offline and presence results stop changing. Both roles can retrieve the saved presence result from session history.

Do not switch teacher/student login within the same browser profile to simulate two people: they intentionally share one login cookie, and signing in under a different account disconnects sockets for the replaced login.

### Timing and recovery

- Server timestamps own all calculations. The browser displays server snapshots approximately once per second; it does not track focus, clicks, keys, or other tabs/apps.
- Grace requires 60 uninterrupted connected seconds. Disconnecting before grace completes resets it; once measurement starts, all subsequent time until ending counts in the denominator. Chat will not affect this rate.
- No measured time means N/A, not 0%. A disconnect is counted when detected; automatic connection checks may take approximately 20 seconds to recognize an unexpected network loss.
- Consistent checkpoints persist every 5 seconds and on join/disconnect/end. Startup finalizes interrupted sessions at their last saved cutoff, marks everyone Offline, and excludes later downtime. Up to the unsaved interval can be lost on abrupt failure. Orderly shutdown saves a final consistent checkpoint.
- Ended/interrupted presence results are locked. Rejoining requires a new live session after closure; the class code stays the same. Full participation-aware reports and export/email remain deferred.

### Socket.IO protocol

The client is served locally at `/socket.io/socket.io.js`. Handshakes require the authenticated login cookie plus `auth.csrfToken`. Foreign browser origins are rejected. Socket actions revalidate the persisted login and enforce roles/ownership; logout disconnects associated sockets immediately, and expiration is checked automatically.

| Event | Purpose |
| --- | --- |
| `session:watch` | Teacher selects an owned session using `{ sessionId }` |
| `session:join` | Student joins with `{ code }`, or reconnects to a previously joined live session with `{ sessionId }` |
| `session:leave` | Student leaves the session in this socket/tab only |
| `presence:update` | Server sends a teacher roster or a student-only snapshot, never a public roster |
| `sessions:changed` | Server tells authorized accounts to refresh their session list |
| `session:deleted` | Server notifies affected accounts to clear the deleted session's cached view; old subscriptions are removed |

Action acknowledgements have `{ ok: true, data }` or `{ ok: false, status, error }`. A student connection can participate in only one session at a time; joining another detaches the previous session in that tab. Viewing saved results does not disconnect a student's live session.

## Structure

```text
server.js                 Environment configuration and server lifecycle
lib/app.js                Express application, authentication, and class routes
lib/database.js           SQLite initialization
lib/session-store.js      Persistent express-session store
lib/presence.js           Server-owned grace/timing, checkpoints, and recovery
lib/meet-presence.js      Separate Meet evidence, uncertainty-aware timing, and saved counters
lib/session-ids.js        Monotonic session IDs that are not reused after deletion
lib/realtime.js           Authenticated Socket.IO events and private updates
lib/instance-lock.js      Prevent concurrent server startup/recovery against one database
database/schema.sql       Additive version-4 schema; preserves older records until explicit deletion
extension/                Manifest V3 side panel, worker, Meet detector, and setup guide
public/                   HTML, CSS, and browser JavaScript
test/                     Foundation, clipboard, presence, migration, and real-time tests
plan.md                   Approved specification and phased roadmap
```

Phase 3 adds the message and participation tables described in the plan. Existing user data must be preserved when introducing future schema migrations. A database marked with a newer unsupported schema version is rejected, not downgraded.

## Security boundaries

- Passwords are hashed with bcrypt; API responses never include password hashes.
- Sessions are stored in SQLite with HttpOnly, SameSite cookies, an eight-hour expiry, and secure cookies in production.
- State-changing requests require CSRF protection. Authentication attempts are rate-limited.
- Every class query checks teacher ownership. Students cannot create or retrieve teacher class lists.
- Frontend user content is rendered with `textContent`; Helmet applies security headers and a restrictive content security policy. No external fonts or tracking scripts are used.

Phases 1–2 have automated checks, not a complete production security review. Final reliability and end-to-end verification remain part of Phase 5.
