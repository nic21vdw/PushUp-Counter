# Working on this project

## Commit straight to `main`

No branches, no pull requests. Commit to `main` and push, so that what is asked
for is running by the time the answer comes back.

This overrides the branch-and-PR default in the global `CLAUDE.md`. It is the
owner's explicit instruction for this repo, given after several rounds where the
work sat unmerged in a PR while the live counter kept running the old code.

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

## Two things that make a working tracker look broken

- **The window must be visible.** Chrome throttles a fully-occluded window until
  the detector stops sampling and the camera will not even open. Check
  `document.visibilityState`. The Options panel reports the sample rate for this
  reason; under 25/s is a problem, 0 means the window is behind something.
- **The page must be clicked once.** Browsers refuse audio until a page has been
  interacted with, silently. OBS browser sources are exempt. The framing line
  says "Click the window once to turn the sound on" when this is what is wrong.

## Ports

`4747` is the real counter. Anything else is a throwaway test server — never
give the owner a link to one, and stop it when finished.

## Adding a rep sound

Drop an audio file into `public/sounds/`. It joins the shuffle on the next page
load, trimmed automatically. Nothing to register in code. Sounds that need to be
exact get a hand-measured window in `SAMPLE_WINDOWS` in `public/js/rep-sound.js`.

Do not download meme audio from the web on the owner's behalf: those are
copyrighted recordings from untrusted sites. Point at this folder instead.
