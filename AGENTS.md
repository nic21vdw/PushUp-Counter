# Working on this project

## Commit straight to `main`

No branches, no pull requests. Commit to `main` and push, so that what is asked
for is running by the time the answer comes back.

This overrides the branch-and-PR default in the global `CLAUDE.md`. It is the
owner's explicit instruction for this repo, given after several rounds where the
work sat unmerged in a PR while the live counter kept running the old code.

This repo pushes directly to `main`. That sentence is load-bearing: the global
guardrail hook only permits main commits in a repo whose `AGENTS.md` says so in
those words, so keep it even if this section is reworded.

The reason it is safe here: this is a single-user project whose only deployment
is the copy in `C:\Users\nic21\PushUp-Counter`, and the tests are quick. Run
`npm test` before pushing — that is the whole gate.

## One click from the Desktop

`Push-Up Counter.lnk` on the Desktop runs `go-live.ps1` through `go-live.cmd`
(same `conhost --headless` wrapper as the OBS Dashboard). It starts
`start-counter.cmd` only if 4747 is down, focuses an existing Chrome window
titled Push-Up Tracker instead of opening a second one, and cuts OBS to
PUSHUPS over obs-websocket. That is the way to pull the counter up mid-stream.

Do not reinvent a 20-second `netstat` / `timeout /t 1` wait. The Documents
launchers (`Push-Up Tracker.bat`) forward here. Do not `git checkout` this
clone while the server it starts is running.

## Deploying is restarting the server

The live counter runs from this checkout. After committing:

1. Stop it — find the PID with `netstat -ano | grep 4747`, then `taskkill //PID <id> //F`.
2. Start `start-counter.cmd` again (via `Start-Process` so it gets its own window).
3. Reload the tracker page in the browser. **Hard-reload it**: the page caches its
   own JavaScript, and a server that is serving new code to a browser holding old
   code is the single most common way a change looks like it did not happen.

The count lives in `state.json`, which is gitignored and never touched by any of
this. Restarting never loses push-ups.

The OBS browser source keeps its old JavaScript across a restart too. Clear it
without touching OBS by pressing its _Refresh cache of current page_ button over
obs-websocket (`PressInputPropertiesButton`, `propertyName: 'refreshnocache'`) —
the password is in `%APPDATA%\obs-studio\plugin_config\obs-websocket\config.json`.

## The count is not reconstructible — treat it that way

Nobody re-does push-ups because a file got clobbered, and there is no upstream
copy to fetch. So: `state.json.bak` holds the previous save, every change is
appended to `state-history.jsonl` with a reason, and an unparseable `state.json`
is renamed to `state.json.broken` rather than written over.

If the owner says the count reset, read the journal first — `node count.mjs
--history` — instead of reasoning about what might have happened. Put a number
back with `node count.mjs <n>`, which goes through the running server and needs
no restart. It is authenticated with `.admin-token` so that no page can do it;
keep it that way, and do not add an HTTP route that sets the count without it.

## Two things that make a working tracker look broken

- **The window must be open, not necessarily visible.** Frames come off the
  camera track (`MediaStreamTrackProcessor` in `pose-tracker.js`), so a tracker
  covered by OBS, minimised or in a background tab keeps counting. Before
  2026-10-21 the loop ran on `requestVideoFrameCallback`, which Chrome stops for
  a page it is not painting, and a covered window counted nothing. Do not move
  inference back onto a paint-driven callback. The Options panel's sample rate is
  the check: under 10/s reps start to go missing.
- **The page must be clicked once.** Browsers refuse audio until a page has been
  interacted with, silently. OBS browser sources are exempt. The framing line
  says "Click the window once to turn the sound on" when this is what is wrong.

## OBS cannot hold the camera, so the tracker runs in Chrome

`overlay.html` as an OBS **Browser Source** will never count. obs-browser refuses
`getUserMedia` outright — the log line is
`[obs-browser: '<source>'] Error: [camera] Camera could not start: Permission denied` —
so the page falls back to a number-only tile and the reps never land.

The arrangement that works, and the one the OBS scene is built around:

- The counting page is a **real Chrome window** on `overlay.html?camera=<name>`,
  which OBS picks up as a `window_capture` matching the title
  `Push-Up Tracker - Google Chrome`. Chrome has camera permission; obs-browser
  does not.
- The browser source in the scene runs `overlay.html?count=0` — a display-only
  duplicate. It shows the number everywhere without competing for the webcam or
  for the counting slot.

Two traps when checking this from a session:

- `count=0&video=0` renders **nothing visible**. `video=0` hides the tile, and
  the number is white text on a transparent page with no plate behind it. Use
  `count=0` alone; the tile's own background is what makes the number readable.
- A `window_capture` does not sample while its scene is off program, so
  `GetSourceScreenshot` on it fails and `sourceWidth` reads `0x0` even when the
  window is open and the setting is correct. That is not a broken capture — cut
  to the scene to see it. Browser and text sources do render off program, which
  is why the rest of the scene screenshots fine.

## There is a second, stale checkout - do not start it

`C:\Users\nic21\Documents\GitHub\PushUp-Counter` is an abandoned July 2026
copy: ten commits, no `.env`, its own `state.json`, and an older two-page layout
(`camera.html` / `tracker.html`) that no longer exists here. Starting it binds
4747 and serves a number that is not the count - it showed "420 push-ups to do"
while the real figure was 53 - and any reps it banks land in a `state.json`
nothing else reads.

Three launchers used to point at it and now forward here instead
(`Documents\Push-Up Tracker.bat`, `Documents\Push-Up Tracker\Push-Up
Tracker.bat`, and the stale checkout's own `Push-Up Counter.cmd`); their previous
contents sit beside them as `*.stale-backup`. If the owner reports a wrong
number, check which directory the process on 4747 is running from before
anything else.

## Ports

Rep continuity expires after `maxGapMs` without a usable angle, even if the
camera delivers no missing-pose callbacks during that gap. Camera changes must
call `counter.resetPhase()` to clear the old camera's median and smoothing
history while preserving completed reps. The landmark-to-HTTP integration test
in `tests/api-rep.test.mjs` checks side-on movement at 10, 30 and 60 samples per
second against a disposable server, without adding test reps to the live count.

`4747` is the real counter. Anything else is a throwaway test server — never
give the owner a link to one, and stop it when finished.

## Adding a rep sound

Drop an audio file into `public/sounds/`. It joins the shuffle on the next page
load, trimmed automatically. Nothing to register in code. Sounds that need to be
exact get a hand-measured window in `SAMPLE_WINDOWS` in `public/js/rep-sound.js`.

Do not download meme audio from the web on the owner's behalf: those are
copyrighted recordings from untrusted sites. Point at this folder instead.

## Hype mode

The 3D layer (`hype-stage.js`), the announcer (`hype-director.js` decides what
happened, `hype-announcer.js` says it, `hype-lines.js` is the script) and graded
reps (`rep.grade` from `RepCounter.update`) all hang off `startHype()` in
`overlay.js`. `hype` is the default rep sound; any other sound preset turns the
announcer off so two voices never talk over each other.

- `?demo=1` fires fake reps on a timer and never banks one. Use it to see or
  hear a change without getting on the floor.
- `?fx=0` drops the 3D layer, `?voice=0` the announcer.
- three.js comes from jsdelivr, pinned to 0.170.0. If it cannot load, or the
  machine only has software WebGL, the page runs exactly as it did before.
- The stage is throttled so the pose detector keeps 25+ samples/s. Check the
  rate in the Options panel after making the stage heavier.

## Subscribers come from the exact Studio feed first

YouTube's public API rounds the sub count to three significant figures, so on its own
it only moves in steps of ten. The server reads `http://127.0.0.1:4757/subs` (the exact
YouTube Studio count from `orca\projects\OBS\subs-server.mjs`) every 2 s and uses it while
it reports `exact: true`; when that feed drops it holds the last exact count for `EXACT_GRACE_SECONDS` (600) and only
then falls back to the API every `POLL_SECONDS`. Falling back on every blip used to rebase the
baseline across the gap, and on 2026-10-17 that swallowed two real subscribers.
`EXACT_SUBS_URL=off` turns the feed off, and the no-YouTube tests set it so a live feed on
the dev machine cannot leak in. Switching between the exact and rounded source moves the
baseline by the same jump, so a source change never adds or removes push-ups by itself.

## Getting ahead does not bank credit against new subs

`left` is `owed - credited`, where `credited = done - surplus`. A rep done while nothing is
owed still adds to `done` (the record of what happened) but also to `surplus`, so it is not
credit. Before this, `done` was subtracted whole: 45 done against 22 owed meant the next 23
subscribers added nothing on screen, which is how "two new subs added zero" happened on
2026-10-17. `settle()` runs after every rep, every poll and at boot, and moves any `credited`
past `owed` into `surplus`. A new stream resets `surplus` with `done`.

## Sets, corrections and rep ids (2026-10-30)

- With `REQUIRE_ARM` on (the default), `/api/rep` refuses camera reps unless a
  set is active, with a **400** and `notArmed: true`. 400 on purpose: a page
  from before sets drops a 400 and retries anything else, and a retried rep
  would land the moment a set started. Tests run servers with
  `REQUIRE_ARM=off` unless they test arming.
- Every rep carries an id (`ids` in the report, queued in localStorage by
  `counter-client.js`). The server remembers the last 2000 and banks a repeat
  once. Do not drop the ids: lost answers and reloads otherwise double-count.
- Hand corrections go through `POST /api/control`, which needs the
  `X-Pushup-Control: 1` header, a localhost Host and no foreign Origin. That
  keeps websites out (no CORS preflight is answered). Setting an absolute count
  still needs `.admin-token` via `count.mjs`; keep that separate.
- Sets, streaks, goal, milestones, boss and the event log live in
  `public/js/session-model.js` (shared by server and pages), persisted as
  `state.session`. Celebrations are recorded once per stream per milestone or
  goal value; pages prime `CelebrationGate` with what is there on load, so a
  reload never replays one.
- Rep continuity (`rep-counter.js`): gaps over `refillGapMs` (150) refill the
  median filter but keep the phase; gaps up to `maxGapMs` (now 1200) keep the
  rep and mark it `bridged`; longer gaps abandon it. The 250 ms limit from
  2026-10-23 dropped every rep whose bottom hid the arm for ~400 ms; the
  traces in `tests/rep-traces.mjs` reproduce that. An upright torso
  (`maxTorsoTiltDeg`, from world landmarks) can neither start nor finish a rep.
