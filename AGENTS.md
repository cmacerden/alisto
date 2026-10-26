# Alisto: working context

## Scope and sources
- The primary UI is the unpacked Chrome extension; `public/` is the legacy website, retained for compatibility/history. Both use the same backend/accounts.
- Read the **Google Meet extension direction-change section at the top of `plan.md`** before its original specification: it supersedes older class-code, connection-presence, and no-extension requirements. Use `extension/README.md` for installation and real-call checks.
- Chat, participation, full reports, CSV, and email are planned, not implemented. Do not mistake roadmap requirements for existing behavior.

## Commands and verification
- Run from the repository root with Node >=22. On this Windows/PowerShell machine use `npm.cmd` to avoid blocked `npm.ps1`: `npm.cmd install`, `npm.cmd start`, `npm.cmd run dev`, `npm.cmd test`.
- `better-sqlite3` is a native dependency; if its install script is blocked, see the approval/rebuild steps in `README.md` rather than disabling script protections globally.
- Tests use Node's built-in runner: one file is `node --test test/meet-presence.test.js`; filter by name with `node --test --test-name-pattern="grace" test/meet-presence.test.js` (options precede filenames).
- No build, lint, formatter, or typecheck scripts exist. For a focused JavaScript syntax check use `node --check <file>`.
- Tests create temporary/in-memory databases and ephemeral servers; no running application server or real Meet call is required. Timing tests inject `now` and advance a fake clock.
- UI-only preview: `node scripts/preview-extension.js`, then `http://127.0.0.1:3002/panel.html`; credentials are in `extension/README.md`. It uses an in-memory backend and mocked Chrome/call signals, not real extension permissions or Meet detection.

## Wiring and extension gotchas
- `server.js` loads `.env`, acquires the database instance lock, calls `createApp` in `lib/app.js`, then attaches HTTP/Socket.IO. `PresenceService` in `lib/presence.js` coordinates legacy timing, Meet timing, history, ending, and recovery; `lib/meet-presence.js` owns Meet evidence accounting. `lib/realtime.js` enforces socket authentication and private delivery.
- Extension scripts are plain JavaScript, not a bundled app: `panel.js` is the sidebar, `background.js` the service worker, and `content.js`/`detector.js` sample Meet. Keep shared URL parsing in `extension/meet.js`; supported paths include `/code`, `/meet/code`, and `/u/<number>/code`.
- Adding an extension API requires updating the explicit path/method allowlist in `extension/api.js`, not just a backend route. The backend URL is fixed there; host permissions and CSP in `extension/manifest.json` must also match any destination change.
- After extension changes, reload Alisto at `chrome://extensions` **and refresh existing Meet tabs** to replace content scripts. Backend changes require a server restart; extension-only changes do not.
- Use separate Chrome profiles for teacher/student tests: website and extension share the profile's backend login cookie. Incognito needs explicit extension enablement. Tracking bindings live in `chrome.storage.session`; reconnect after a browser restart.
- Automated detector fixtures/preview cannot prove compatibility with Google's current live DOM. Do not broaden permissions or award presence just to make a tab discoverable.

## Data and behavior invariants
- `data/alisto.sqlite` contains real user records. Do not use it for experiments. Back up via SQLite's backup mechanism before migrations; WAL makes a simple live-file copy unsafe.
- Only one server may use a database. Startup recovery finalizes interrupted sessions; opening the real database through another runtime is not a harmless preview. Never remove a live instance lock; an abandoned lock may take 10 seconds to expire.
- Migrations live in `lib/database.js` plus `database/schema.sql` (currently schema v4), run transactionally on open, and must preserve existing records. Newer unsupported versions are rejected. Allocate session IDs through `lib/session-ids.js` **inside the creation transaction** so deleted IDs cannot be reused by stale bindings.
- Keep legacy `session_students` connection measurements separate from `meet_students`/`meet_sources` call measurements. Never reinterpret old rates as Meet attendance.
- A Meet code/URL selects a room, never proves call membership. Enrollment starts uncertain; `meet_students.joined_at` is set only by the first actual `in` observation, not enrollment (important for future participation eligibility).
- Meet timing uses server receipt times and evidence valid for at most 15 seconds. Grace requires 60 uninterrupted in-call seconds; out/unknown resets incomplete grace, never completed grace. Unknown time is excluded from both rate operands and disclosed cumulatively since enrollment; no measured time is N/A.
- Live unknown snapshots use `status: null` and `Cannot verify`, not Offline. Fresh in-call evidence wins across sources without double counting; otherwise stale/unknown evidence prevents assumed absence. Ending/recovery locks counters and excludes restart downtime.
- No camera/mic state, recordings, attention, focus, or input-activity tracking. The English DOM adapter is browser-reported membership evidence, not independently verified attendance.
- Writes require cookie authentication plus CSRF; authentication rotates the token. Teachers access only owned classes/sessions; students receive only their own measurements, never a peer roster. Preserve these boundaries in HTTP and socket paths.
- Session deletion requires owning teacher, explicit confirmation, and ended/interrupted status; cleanup is transactional. Class deletion must reject linked history rather than cascade it. UI confirmations are inline with Cancel.
