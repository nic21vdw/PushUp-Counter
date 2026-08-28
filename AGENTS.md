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

- **The window must be visible.** Chrome throttles a fully-occluded window until
  the detector stops sampling and the camera will not even open. Check
  `document.visibilityState`. The Options panel reports the sample rate for this
  reason; under 25/s is a problem, 0 means the window is behind something.
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

`4747` is the real counter. Anything else is a throwaway test server — never
give the owner a link to one, and stop it when finished.

## Adding a rep sound

Drop an audio file into `public/sounds/`. It joins the shuffle on the next page
load, trimmed automatically. Nothing to register in code. Sounds that need to be
exact get a hand-measured window in `SAMPLE_WINDOWS` in `public/js/rep-sound.js`.

Do not download meme audio from the web on the owner's behalf: those are
copyrighted recordings from untrusted sites. Point at this folder instead.
