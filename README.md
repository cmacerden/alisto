# Alisto

Alisto is a **Chrome extension for Google Meet classrooms** that helps teachers manage sessions, review browser-reported call presence, and record student participation. It runs in Chrome's side panel with a Node.js and SQLite backend.

## What Alisto does

- **Class management:** separate Student and Teacher/Admin accounts, teacher-owned classes, and sessions linked to actual Google Meet rooms.
- **Presence summaries:** Activity Rate based on detected matching-call time after 60 uninterrupted seconds of grace. Uncertain membership shows **Cannot verify** and is excluded from the rate.
- **Discussion and participation:** separate General Chat and timed prompts, with Everyone or Teacher-only responses earning equal credit.
- **Saved results:** session history, participation totals, teacher class CSV exports, and personal student CSV/DOCX downloads.
- **Private access:** teachers access only their own classes and sessions; students access only their own measurements and reports.

**Alisto does not measure attention, focus, camera/microphone use, or learning.** An open Meet link alone does not prove call membership. Detection depends on recognizable English Meet controls and is not independently verified attendance.

## Development phases — summary

| Phase | Focus | Status |
| --- | --- | --- |
| 1 — Foundation | Accounts, roles, classes, and persistent storage. | Implemented |
| 2 — Presence | Live sessions, grace, Activity Rate, saved results, and recovery; extended to Google Meet through Chrome. | Implemented |
| 3 — Participation | General Chat, timed prompts, response visibility, and Participation Rate. | Implemented |
| 4 — Reports | Authorized saved summaries, CSV exports, student DOCX downloads, and email/preview support. | Implemented; real SMTP setup and CSV template redesign deferred |
| 5 — Reliability | Privacy, reconnect, timing, and crash-recovery verification. | 179 automated tests passed at the latest recorded check; full live acceptance pending |

**Current status:** extension **0.5.0**, installed manually—not yet published on the Chrome Web Store. Shared HTTPS hosting and a multi-computer classroom pilot are still pending. Without configured SMTP, email creates explicitly labeled Ethereal previews, not inbox delivery; use DOCX for a downloadable student report.

The extension is the primary interface. The older website remains available for compatibility; its historical Alisto-connection measurements are separate from Meet call measurements.

## Use Alisto in Chrome

Requires desktop **Chrome 116+** and **Node.js 22+**. Initial setup takes about **5–10 minutes** after installing these prerequisites.

### 1. Download the project and start the backend

1. Download this repository using **Code → Download ZIP** and extract it, or clone the repository. Keep the extracted folder; Chrome loads the extension from it.
2. Open a terminal in the project root (the folder containing `package.json`). On Windows PowerShell, run:

   ```powershell
   npm.cmd install
   npm.cmd start
   ```

   On other systems, use `npm install` and `npm start`. If npm blocks the native dependency install script, review and approve only `better-sqlite3` using `npm install-scripts approve better-sqlite3` where supported, then run `npm rebuild better-sqlite3`. On PowerShell, use `npm.cmd` for these commands too; do not disable script protections globally.
3. Keep the terminal running while using Alisto. Open <http://localhost:3000> to check the backend. If Alisto is already running, use that server instead of starting a second one.

**Local-only limitation:** the extension connects to `http://localhost:3000` on the same computer. Installing it on multiple computers does **not** create a shared classroom. That requires a shared HTTPS backend and matching extension configuration; separate local servers have separate accounts and records.

### 2. Load the extension in Chrome

1. Enter `chrome://extensions` in Chrome's address bar.
2. Turn on **Developer mode** in the upper-right corner.
3. Click **Load unpacked** and select the project's **`extension` folder**, not the project root or ZIP file. This folder contains `manifest.json`.
4. Open Chrome's **Extensions** menu (puzzle-piece icon) and pin **Alisto · Meet classroom companion**.
5. Open a Google Meet tab and click the **Alisto** toolbar icon. Register or sign in as **Student** or **Teacher/Admin** in the side panel. Existing Alisto accounts work; there are no pre-created accounts.

If a school-managed profile blocks Developer mode or unpacked extensions, ask the administrator for approval; do not bypass school policy.

### 3. Start and join a classroom session

For teacher/student testing on one computer, use **separate Chrome profiles** and load the extension in each. The website and extension share a login cookie within a profile.

1. **Teacher:** open the actual Meet room and Alisto sidebar. Create or select your class, check the Meet code, and click **Start Meet session**. If needed, use **Google Meet link or code (fallback)**. Use the Meet code, not the legacy six-character Alisto class code.
2. **Student:** join the same Meet call, sign in to Alisto, and click **Connect this Meet tab**. If the tab is not identified, use **Find Meet tabs**, select the matching room, and connect. The pre-join screen alone does not earn in-call time.
3. **During the session:** use **Overview** for presence/rates, **General Chat** for discussion, and **Prompts & responses** for timed participation. Activity Rate measurement begins after 60 uninterrupted seconds of verified in-call grace.
4. **Teacher:** click **End Alisto session** when finished. This stops measurement, not the Google Meet call.
5. **Saved results:** open **Session history → View saved session → Overview**. Teachers can download the full-class CSV; students can download their own CSV or **Download my report (.docx)**.

### 4. Update or troubleshoot

- **Extension updates:** click Alisto's **Reload** button at `chrome://extensions`, then **refresh existing Meet tabs**.
- **Backend unavailable:** confirm the server is running on port 3000. Installing the extension does not start it. Before restarting an existing backend, end live Alisto sessions and make a proper SQLite backup.
- **Meet tab not found / Cannot verify:** refresh Meet, join the call, and check Alisto's **Site access** for `meet.google.com`. Unsupported layouts may remain unverifiable.
- **Browser restart:** reopen Alisto and reconnect the Meet tab. Closing only the sidebar does not stop detection in a connected, open Meet tab.
- **Incognito:** enable **Allow in Incognito** in extension details if needed. Separate profiles are recommended for testing.

## Configuration and data safety

Optional settings are listed in `.env.example`. The default backend port is `3000`, and the database is `data/alisto.sqlite`. Keep `.env`, session secrets, databases, and backups private.

Run only **one server per database**. Use SQLite's backup mechanism rather than copying a live database file because SQLite uses WAL mode. Never remove a live instance lock. Startup recovery finalizes interrupted sessions at their saved checkpoint without counting downtime.

## Tests

Run `npm.cmd test` on Windows PowerShell, or `npm test` elsewhere. Tests use isolated temporary/in-memory databases, not real user records. Automated checks do not replace real Meet and school-policy acceptance testing.

## Further details

See [the extension guide](extension/README.md) for detailed installation and real-call checks. Backend code is in `lib/`, extension code in `extension/`, and automated checks in `test/`.
