# Push-Up Counter

A live push-up counter for streams, as one OBS browser source.

```
a subscriber arrives while you are live   ->  the number goes up one
the webcam sees you do a push-up          ->  the number goes down one
```

That is the whole machine. There is no button that logs push-ups, no field that
edits the total, and no endpoint behind either — the only way the number comes
down is doing the push-ups in front of the camera.

The source is white text on a fully transparent page, so it drops straight into
OBS and composites over your scene with no chroma key and no custom CSS.

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
  Frame it up   http://127.0.0.1:4747/overlay.html?setup=1
  Status        http://127.0.0.1:4747/status.html
  1 push-up per subscriber gained while live.
```

## 4. Frame yourself

Open **`/overlay.html?setup=1`** in a browser. That is the same page you are
about to put in OBS, with the camera picture and the pose skeleton drawn on so
you can see what the detector sees.

Off to your side, chest height, 2–3 m back, whole body in frame from hands to
feet. Joint angles come from the model's metric 3D landmarks, so a head-on or
three-quarter camera works too — side-on is just the most reliable.

**Close this tab before you go live.** Two pages with the camera open will fight
over it, and two pages counting would bank every push-up twice.

### If you have more than one camera

Streaming machines usually do — a webcam or two, a phone-as-webcam bridge, OBS's
own virtual camera. The page takes whatever the browser calls the default, which
is very often the one OBS has already claimed. Name the one you want:

```
/overlay.html?setup=1&camera=Brio
```

Any part of the camera's name works, case-insensitive. If it can't find it, the
error names every camera it can see, so you know what to type.

## 5. Add it to OBS

**Sources → + → Browser**, then:

| Field  | Value                                    |
| ------ | ---------------------------------------- |
| URL    | `http://127.0.0.1:4747/overlay.html`     |
| Width  | `900`                                    |
| Height | `220`                                    |

Leave the custom CSS box alone — the page is already transparent.

**Untick "Shutdown source when not visible."** This one source is also the thing
doing the counting, so the camera has to stay open while you are doing push-ups
off-scene. If you shut it down between scenes, nothing counts.

Then **remove any Video Capture Device using the same camera** from your scenes.
On most machines the first app to open a camera keeps it.

### Making it look right

| Param    | Example              | What it does                              |
| -------- | -------------------- | ----------------------------------------- |
| `size`   | `size=120`           | Font size of the number, in px            |
| `color`  | `color=%23ffffff`    | Text colour (URL-encode `#` as `%23`)     |
| `label`  | `label=TO GO`        | Text after the number; `label=` hides it  |
| `align`  | `align=right`        | `left` (default), `center`, `right`       |
| `font`   | `font=Impact`        | Any font installed on the machine         |
| `weight` | `weight=900`         | Font weight                               |
| `shadow` | `shadow=none`        | Drop the text shadow                      |
| `bar`    | `bar=1`              | Progress bar: how much of it you have done|
| `subs`   | `subs=1`             | Second line with the subscriber count     |

Example: `overlay.html?size=140&align=center&bar=1&subs=1`

The status page shows the finished URL for you.

### Other options

| Param    | Example         | What it does                                       |
| -------- | --------------- | -------------------------------------------------- |
| `camera` | `camera=Brio`   | Which webcam to open (part of its name)            |
| `setup`  | `setup=1`       | Draw the camera and skeleton. Never use on stream  |
| `count`  | `count=0`       | Display only — does not open the camera at all     |

`count=0` is there for a second screen showing the same number. Only ever run
**one** counting source, or every push-up lands twice.

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

- Angles run through a moving average, so one bad frame can't trigger a count.
- The bottom of the rep must last a minimum time, and reps must be a minimum
  time apart — flailing doesn't count.
- If your hips sag or pike past the plank threshold the rep is thrown away and
  you have to re-establish the top position.
- Losing the pose (you leave frame) abandons the rep in progress rather than
  banking it.
- Reps counted while the server is unreachable are held and sent when it's back,
  so a blip doesn't quietly cheat you out of push-ups.

### Tuning it to you

Range of motion varies. Watch the skeleton in `?setup=1`, do one slow rep, and
if it misses reps or double-counts, adjust with URL params:

| Param       | Default | What it does                                      |
| ----------- | ------- | ------------------------------------------------- |
| `down`      | `100`   | How bent your arms must get to register the bottom |
| `up`        | `155`   | How straight they must get to complete the rep     |
| `plank`     | `140`   | How straight your body must be for a rep to count  |
| `smoothing` | `0.5`   | Lower = steadier but laggier; higher = twitchier   |
| `minrep`    | `400`   | Minimum ms between reps                            |

Reps **missed**? Raise `down` and lower `up`. Getting **double counts**? Raise
`minrep` and lower `smoothing`.

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
