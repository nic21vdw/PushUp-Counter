# AGENTS.md

Working notes for this repo. Read before changing anything.

## What this is

A local push-up counter for streams. `server.js` owns the count; the pages in
`public/` are the UI. The deliverable is `overlay.html` — transparent background,
white text — dropped into OBS as a Browser Source.

## Running it

```bash
npm start        # http://127.0.0.1:4747 — no install, no build step
npm test         # node:test, no dependencies
```

Node 18+. **There are no dependencies and no build step**; do not add either
without a reason that outweighs losing `git clone && npm start`.

## Things that are easy to get wrong

- **YouTube is optional and off by default.** Subscriber tracking only switches on
  with both an API key and a channel ID/handle (`subsEnabled` in `server.js`).
  With neither, nothing is polled and no error is shown — a bare server is a
  working server, not a broken one. Don't reintroduce a startup warning for it.
- **`state.json` is the source of truth** and lives next to `server.js`. It is
  gitignored. Tests must never touch the real one — they boot the server in a
  temp cwd instead.
- **Windows: symlinking a directory needs Developer Mode.** The test harness uses
  a junction on win32 and a `dir` symlink elsewhere (`LINK_TYPE`). Use the same
  approach in any new test that needs to serve `public/`.
- **`node --test` runs test files concurrently**, so every file that spawns
  servers needs its own port range. Currently: `api-done` 14731, `counting-client`
  14831, `no-youtube` 14931. Pick a fresh base for a new one — a shared base means
  two servers race and the loser dies with `EADDRINUSE`, which shows up as a
  confusing "server did not start" timeout.
- **`public/vendor/` is gitignored** (~24 MiB MediaPipe runtime + pose model).
  `npm run fetch-assets` populates it; without it the pages fall back to a CDN and
  say so (`CDN_FALLBACK_NOTICE`). The notice is persistent on `camera.html` but
  time-limited on `tracker.html`, because that page *is* the stream overlay — do
  not make it permanent there. Note that populating it also un-skips a test.
- **`tracker.html` paints no faults by default** (`?status=1` opts in). It is a
  stream source: a red banner over the scene tells the audience about a problem
  only the streamer can fix. Failures go to the console, and `camera.html` — the
  operator page — reports them with what to do about each. Don't "fix" a silent
  tracker by making the box unconditional again.
- **Only one page should count reps at a time.** The server tracks a counting
  client id so `camera.html` and a `tracker.html?count=1` OBS source don't both
  subtract from the same push-up.

## Capture sources

`CAPTURE` in `public/js/pose-tracker.js` is the only place that knows where video
comes from — webcam via `getUserMedia`, screen/window via `getDisplayMedia`.
Detection downstream is source-agnostic. Two rules that look like details but are
not:

- Mirror the webcam, never a shared screen (flipping reverses text in it).
- Screen capture exists because **OBS and the browser cannot both hold the
  webcam**. It costs an encode/decode hop and some accuracy, so the webcam stays
  the default.

## Parallel sessions

Several agents often work on this repo at once. Check `git status` before editing
— an in-progress tree is a sign someone else is mid-task. Prefer a worktree or a
separate clone over editing a checkout another session is writing to.

Note this repo is cloned twice on the streaming machine, and an OBS scene can
composite browser sources from **both** at once — so one screenshot may mix code
from two branches. Grep for the on-screen string across both clones before
deciding which to edit, and never `git checkout` in a clone whose server is live
on port 4747; add a worktree instead.

## Response format

End every substantive response with a short recap section, set off by a heading.
It reads as a standalone summary for someone who skipped the body: what you
concluded or changed, what it means, and what is left open or needs a decision.
A few lines or a tight bullet list — not a replay of the response.

Skip it when the whole response is already a few lines, or the answer is a
single fact. When a change ends in a pull request, the branch name and PR URL
go inside the recap, on their own line at the very end.
