# Push-Up Counter

A live push-up counter for streams, as one OBS browser source.

```
a subscriber arrives while you are live   ->  the number goes up one
the webcam sees you do a push-up          ->  the number goes down one
```

That is the whole machine. There is no button that logs push-ups, no field that
edits the total, and no endpoint behind either — the only way the number comes
down is doing the push-ups in front of the camera.

The tracker is one page: a rounded tile showing your webcam with the pose
skeleton drawn on it, and the count beside it. The page background is fully
transparent, so OBS composites the whole panel over your scene with no chroma
key and no custom CSS — you add it as a single Browser Source and you are done.

It wants **its own webcam**, separate from anything OBS has as a Video Capture
Device. On most machines the first app to open a camera keeps it, so a camera
OBS already holds is a camera this cannot have.

**Only subscribers gained while you are live count.** Growth between streams is
free — otherwise the number runs away from you overnight. Starting the server
begins a new stream; whatever you still owed carries over as the new base, so
the number on screen never jumps.

No dependencies, no build step, no `npm install`. Just Node 18+ and a webcam.

---

## 1. Get a YouTube API key

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) and create
   a project (or pick an existing one).
2. **APIs & Services → Library →** search "YouTube Data API v3" → **Enable**.
3. **APIs & Services → Credentials → Create credentials → API key.** Copy it.
4. Optional but recommended: click the key, and under **API restrictions** limit
   it to YouTube Data API v3.

You also need your channel ID — the `UC...` string at
[youtube.com/account_advanced](https://www.youtube.com/account_advanced).
(Your `@handle` works too, via `YOUTUBE_HANDLE`.)

## 2. Configure

```bash
cp .env.example .env
```

Fill in `YOUTUBE_API_KEY` and `YOUTUBE_CHANNEL_ID`. Nothing else is required.

## 3. Run

```bash
npm start
```

```
  Push-up counter is running.
  OBS source    http://127.0.0.1:4747/overlay.html      <- add this as a Browser Source
  Set it up     http://127.0.0.1:4747/overlay.html?setup=1   <- detector readout, check framing
  Status        http://127.0.0.1:4747/status.html
  1 push-up per subscriber gained while live.
```

## 4. Pick your camera and frame yourself

Open **`/overlay.html`** in a browser. That is exactly the page you are about to
put in OBS: your camera filling the window with the count over it, and nothing
else. Add `?setup=1` for a live readout of your elbow angle under the picture,
so you can see what the detector sees.

**Move the mouse and a gear appears** in the top right. That is Options: which
camera to watch, which sound a rep makes, and how loud. Pick a camera and the
picture switches straight away, with no reload.

The controls are revealed by the pointer rather than always drawn, because this
page is also the browser source. OBS has no mouse, so nothing in Options can
ever appear on stream.

Your choices are saved on the server, not in the browser, because this window
(in Chrome) and the browser source (in OBS) are two different browsers with
separate storage. So changing the camera or the sound here changes it in OBS too
— you never have to re-paste a URL.

If you would rather pin a camera to a particular source, name it in the URL and
that wins over the saved choice:

```
/overlay.html?camera=Brio
```

The same goes for `?sound=` and `?volume=`: named in the URL, they win over
whatever Options has saved, so one source can be silent while another is not.

Any part of the camera's name works, case-insensitive. If it can't find it, or
the camera is busy, the error names every camera on the machine so you know what
to type. The status page lists them too.

Off to your side, chest height, 2–3 m back, whole body in frame from hands to
feet. Joint angles come from the model's metric 3D landmarks, so a head-on or
three-quarter camera works too — side-on is just the most reliable.

**Close this tab before you go live.** Two pages with the camera open will fight
over it, and two pages counting would bank every push-up twice.

## 5. Add it to OBS

**Sources → + → Browser**, then:

| Field  | Value                                                |
| ------ | ---------------------------------------------------- |
| URL    | `http://127.0.0.1:4747/overlay.html?camera=Brio`     |
| Width  | `1100`                                               |
| Height | `340`                                                |

Leave the custom CSS box alone — the page is already transparent. Any size works;
the camera tile is 16:9 and grows with the height you give it, and is capped at
62% of the width so it can never crowd the number out.

**Untick "Shutdown source when not visible."** This source *is* the thing doing
the counting, so the camera has to stay open while you are doing push-ups
off-scene. If you shut it down between scenes, nothing counts.

Then **remove any Video Capture Device using the same camera** from your scenes.
On most machines the first app to open a camera keeps it.

Also **untick "Refresh browser when scene becomes active."** Reloading the page
drops the camera and re-acquires it every time you cut to the scene, which
stalls the tracker for a second or two each cut.

## 5a. Keeping it always on

The browser source only works while the server is running, so for a scene you
leave up permanently, start the server with Windows:

1. Double-click **`start-counter.cmd`** in the project folder to check it runs.
   It leaves a window open; closing that window stops the counter.
2. Right-click it → **Show more options → Create shortcut**.
3. Press <kbd>Win</kbd>+<kbd>R</kbd>, type `shell:startup`, press Enter.
4. Drag the shortcut into that folder.

The counter is now up from login, and the OBS source finds it every time. To
stop it, close its window; to start it again, run the shortcut.

If you would rather not have a console window sitting in the taskbar, set the
shortcut's **Run** to **Minimized** in its Properties.

**`update-and-start.cmd`** is the same thing with a `git pull` in front of it, so
a double-click gets you the current counter rather than the one you cloned. It
never blocks on a failed update: no git, a branch other than `main`, local edits,
or no network each print a line and start what you already have.

### Making it look right

| Param      | Example              | What it does                                |
| ---------- | -------------------- | ------------------------------------------- |
| `size`     | `size=120`           | Font size of the number, in px              |
| `color`    | `color=%23ffffff`    | Text colour (URL-encode `#` as `%23`)       |
| `label`    | `label=TO GO`        | Text under the number; `label=` hides it    |
| `font`     | `font=Impact`        | Any font installed on the machine           |
| `weight`   | `weight=900`         | Font weight                                 |
| `shadow`   | `shadow=none`        | Drop the text shadow                        |
| `bar`      | `bar=0`              | Hide the progress bar (on by default)       |
| `subs`     | `subs=1`             | Extra line with the subscriber count        |
| `radius`   | `radius=0`           | Square off the camera tile's corners        |
| `mirror`   | `mirror=0`           | Stop flipping the picture                   |
| `skeleton` | `skeleton=0`         | Hide the pose skeleton, keep the picture    |
| `video`    | `video=0`            | Hide the tile — number only, still counting |

Example: `overlay.html?camera=Brio&size=140&subs=1&radius=8`

The status page shows the finished URL for you.

### Other options

| Param    | Example         | What it does                                        |
| -------- | --------------- | --------------------------------------------------- |
| `camera` | `camera=Brio`   | Which webcam to open (part of its name)             |
| `setup`  | `setup=1`       | Add the detector readout and the fault box. Never use on stream |
| `count`  | `count=0`       | Display only — shows the picture but banks nothing  |
| `sound`  | `sound=coin`    | Which noise a counted rep makes; `sound=0` for none |
| `volume` | `volume=0.2`    | How loud that noise is, `0` to `1`                  |

`count=0` is there for a second source showing the same thing on another scene.
Only ever run **one** counting source, or every push-up lands twice.

### When it can see you but will not count you

The detector finding a body is not the same as the body being countable. Too far
away and the joints are noise; too close and your arms leave the frame; face-on
and the elbow angle is a guess; standing up and there is no push-up to find. In
all of those the skeleton draws happily and the number never moves — which from
the floor is indistinguishable from the thing being broken.

So the tracker says which it is, in one instruction at a time, over the picture:

| What it sees | What it says |
| --- | --- |
| Nothing | Step into frame — nothing to track yet |
| You running off an edge | You are cut off on the left — shift right |
| You filling the frame | Move further back — you fill the whole frame |
| You too small to measure | Move closer — you are too small to measure |
| Arms not visible | Your arms are hidden — turn so the camera sees them |
| You upright | Get down into a plank — nothing counts standing up |
| You facing the camera | Turn side-on — the camera should see you from the side |
| A half-sure detector | Hard to see you — try more light or a plainer background |

It waits about 700 ms before speaking, so settling into position does not make it
flicker, and it disappears the moment the framing is good. Once you are counting
it only comes back for the two form notes that stop a rep being banked: sagging
hips, and going too fast to control. `coach=0` turns it off.

### The rep sound

Every counted rep plays a sound, and by default a **different one each time** —
the same noise a hundred times in a set stops being funny somewhere around six.

The bank is just the files in **`public/sounds/`**. Drop an mp3 in there and it
joins the rotation; no code to edit, nothing to restart but the page. What ships
is `fahh`, `vine-boom`, `roblox-oof` and `among-us`.

| `sound=` | What you get |
| --- | --- |
| `shuffle` | A different file each rep, never the same one twice running. The default |
| *a file name* | Only that one, e.g. `sound=vine-boom` |
| `coin` `powerup` `pop` `boing` `sadtrombone` `chirp` | Synthesised, no file needed |
| `0` | Silence |

**Files are trimmed on the way in.** Meme sound effects are recorded with a
second of dead air at the front and a reverb tail hanging off the back, and
neither belongs between push-ups. The page measures each file's loudness, opens
the window just before the sound actually lands, caps it at a second so it
cannot still be playing when the next rep arrives, and fades the end. Every
sound in the bank reaches half volume within 25 ms of the rep. `fahh` has a
hand-measured window; everything else is done by the same rules in code.

If a file will not load, that one drops out and the rest carry on. If none load,
you get a synthesised beep. A rep is never left silent — a missing noise reads
as a missed rep.

**On lag.** Files are fetched, decoded and trimmed once when the page opens,
never on the rep. The page also holds the audio device open with a silent
source, because Windows powers an idle output down between reps and waking it
costs 50-200 ms. `?setup=1` reports the remaining hardware latency.

**In a normal browser tab there is no sound until you click the page once.**
That is the autoplay rule, not a fault, and it is silent about itself — so the
tracker now says so on screen when it applies. OBS browser sources are exempt
and play from the first rep.

Only the counting source makes noise: a `count=0` duplicate is watching the same
push-up, and two of them would answer each one twice.

In OBS, tick **Control audio via OBS** in the browser source's properties if you
want it on the stream and in your monitor mix; leave it off and it comes out of
the machine's default output, which you hear in the room but your viewers do
not. Either way, `volume=0.2` if it is louder than you want next to a mic.

## 6. Check it is working

**`/status.html`** is read-only. It tells you whether YouTube is answering,
whether anything has counted a push-up recently, and shows the arithmetic with
your live numbers:

```
500 carried over + 18 subs × 1 − 38 done = 380
```

There are no controls on it. Nothing on that page — or anywhere else in the app
— can change the count.

## How a rep is counted

Each frame gives 33 body landmarks. From those it takes the **elbow angle**
(shoulder → elbow → wrist, averaged across whichever arms are clearly visible)
and the **plank angle** (shoulder → hip → knee) to check your body is straight.

A rep is a state machine with two thresholds:

```
top (elbow >= up threshold) -> bottom (elbow <= down threshold) -> back to top  =>  +1
```

It counts on the way up, when the rep is actually finished. Two thresholds
rather than one is what stops jitter around a single value from spraying out
phantom reps. On top of that:

- A rep that stops short of the up threshold still counts once you turn around
  and start the next one — see `uptol` below. At speed nobody locks out, and a
  detector that insists on it stops counting exactly when you speed up.
- Bad frames are removed with a median of the last three samples rather than by
  averaging. An average heavy enough to swallow a mis-detected limb also flattens
  the peaks of a quick rep until they no longer reach the thresholds.
- The bottom of the rep must last a minimum time, and reps must be a minimum
  time apart — flailing doesn't count.
- If your hips sag or pike past the plank threshold the rep is thrown away and
  you have to re-establish the top position — but only if it lasts. A wobble
  shorter than `plankgrace` withholds the count instead of binning the rep.
- Losing the pose abandons the rep in progress rather than banking it, once you
  have really gone (`gap`). A frame or two of motion blur is not you leaving.
- Reps counted while the server is unreachable are held and sent when it's back,
  so a blip doesn't quietly cheat you out of push-ups.

Inference runs on every decoded camera frame rather than once per repaint, and
the camera is asked for 60 fps. Sample rate is what sets the ceiling on how fast
you can go: a 300 ms rep seen 30 times a second is nine samples end to end.

### Tuning it to you

Range of motion varies. Open `?setup=1`, do a few reps *at the speed you actually
train at* while watching the readout under the picture. It shows the live elbow
and plank angles, the range of the last rep it counted, and the sample rate.

| Param        | Default | What it does                                        |
| ------------ | ------- | --------------------------------------------------- |
| `down`       | `100`   | How bent your arms must get to register the bottom   |
| `up`         | `155`   | How straight they must get to complete the rep       |
| `uptol`      | `25`    | How far short of `up` a rep may stop if you turn around |
| `reversal`   | `10`    | Degrees back down that mark the top of such a rep    |
| `plank`      | `140`   | How straight your body must be for a rep to count    |
| `smoothing`  | `0.85`  | Lower = steadier but laggier; higher = twitchier     |
| `minrep`     | `220`   | Minimum ms between reps                              |
| `minphase`   | `60`    | Minimum ms the bottom of a rep must last             |
| `gap`        | `250`   | Ms of lost pose tolerated before the rep is dropped  |
| `plankgrace` | `300`   | Ms of ragged form tolerated before the rep is dropped |

Reps **missed when you go fast**? Check the sample rate first — under about 25/s
no threshold will save you, and the fix is more light on you or a camera that
will do 60 fps. Then raise `uptol`, and lower `minrep` if you are quicker than
~270 reps a minute. Reps **missed generally**? Raise `down` and lower `up` to sit
just inside the range the readout shows you actually hitting.

Getting **double counts**? Raise `minrep`, lower `smoothing`, and raise
`reversal` — a bigger turnaround is harder for noise to fake. `uptol=0` puts it
back to demanding a full lockout on every rep.

These live in the URL rather than in a settings panel on purpose. A control you
can reach mid-set is a control you will reach for.

## Vendoring the pose model

Worth doing once, so nothing is downloaded at stream time:

```bash
npm run fetch-assets     # ~24 MiB into public/vendor, gitignored
```

Without it the page pulls the same files from a CDN the first time it starts.
`npm run fetch-assets -- --clean` reverts to the CDN.

## Streams, and why the count resets

Push-ups only accrue from subscribers gained **during a stream**. When a stream
ends, the counter stops moving until the next one starts.

Starting the server decides which it is:

- **Off for more than 6 hours** (`NEW_STREAM_AFTER_HOURS`) → new stream. The sub
  baseline moves to your current count, push-ups done resets to 0, and anything
  you still owed becomes the new carried-over base. Overnight growth costs you
  nothing.
- **A shorter gap** — an OBS crash, a reboot, a laptop lid mid-stream → the
  session in progress picks straight back up, sub baseline and all.

Set `NEW_STREAM_AFTER_HOURS=off` to only ever start streams by hand, or `0` to
always start fresh on launch.

So if you finish a stream owing 120, you come back tomorrow owing 120 — not 120
plus every subscriber who arrived while you were asleep.

## Notes

- The server listens on `127.0.0.1` only. The overlay has to run on the machine
  the webcam is plugged into anyway, and browsers only grant camera access on a
  secure origin — which a LAN IP is not.
- Video is processed entirely in the browser and never leaves the machine.
- **YouTube rounds public subscriber counts once you pass 1,000** (1,010 shows
  as "1.01K", and the API returns `1010`; past 10,000 it rounds to 3 significant
  figures). Below 1,000 the count is exact. Above that, expect the counter to
  move in jumps — that's YouTube, not this app.
- If your channel has its subscriber count hidden, the API returns
  `hiddenSubscriberCount` and no usable number; the status page will say so.
- If the API errors or the network drops, the overlay keeps showing the last
  known number and dims slightly, rather than blanking out mid-stream.
- Polling is every 30s by default (`POLL_SECONDS`). Each poll costs 1 quota
  unit, so a 24h stream uses ~2,880 of the free 10,000/day. Stop the server when
  you go off air and it costs nothing at all.

## Tests

```bash
npm test
```

No dependencies to install. Covers the rep-counting state machine and pose
geometry against synthetic angle sequences (clean reps, partial reps, jitter at
the threshold, dropped poses, sagging hips, double-count debounce), the overlay's
URL parsing, and the server's one writing endpoint over real HTTP — including
that the endpoints which could once fake the count are gone and stay gone.
