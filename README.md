# Push-Up Counter

A live push-up counter for streams. It watches your YouTube subscriber count
(YouTube Data API v3), adds push-ups as subscribers roll in, and renders the
number left as white text on a fully transparent page you can drop straight into
OBS as a browser source.

To bring the number down, either tap a button after a set — or point a webcam at
yourself and let it count your reps automatically, one subtracted per push-up as
you do it. See [Counting with the webcam](#6-counting-with-the-webcam).

```
left to do = base owed + (subs gained this stream × push-ups per sub) − done this stream
```

**Only subscribers gained while you are live count.** Growth between streams is
free — otherwise the number runs away from you overnight. Starting the server
begins a new stream automatically; whatever you still owed carries over as the
new base, so the overlay number never jumps.

No dependencies, no build step, no `npm install`. Just Node 18+ (and a webcam if
you want the automatic counting).

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

Fill in `YOUTUBE_API_KEY` and `YOUTUBE_CHANNEL_ID`.

## 3. Run

```bash
npm start
```

```
  Push-up counter is running.
  Control page  http://127.0.0.1:4747/control.html
  OBS overlay   http://127.0.0.1:4747/overlay.html
```

The webcam counter lives at `/camera.html`, linked from the top of the control
page, and the OBS-ready version of it at `/tracker.html` — see
[Putting the tracker on stream](#7-putting-the-tracker-on-stream).

## 4. Add it to OBS

**Sources → + → Browser**, then:

| Field  | Value                                          |
| ------ | ---------------------------------------------- |
| URL    | `http://127.0.0.1:4747/overlay.html?size=88`   |
| Width  | `900`                                          |
| Height | `220`                                          |

Leave the custom CSS box alone — the page is already transparent. Tick
**"Shutdown source when not visible"** so it reconnects cleanly between scenes.

### Overlay options

Append query params to the overlay URL:

| Param        | Example              | What it does                                |
| ------------ | -------------------- | ------------------------------------------- |
| `size`       | `size=120`           | Font size of the number, in px              |
| `color`      | `color=%23ffffff`    | Text colour (URL-encode `#` as `%23`)       |
| `label`      | `label=LEFT`         | Text after the number; `label=` hides it    |
| `align`      | `align=right`        | `left` (default), `center`, `right`         |
| `font`       | `font=Impact`        | Any font installed on the machine           |
| `weight`     | `weight=900`         | Font weight                                 |
| `shadow`     | `shadow=none`        | Drop the text shadow                        |
| `subs`       | `subs=1`             | Show a second line with the sub count       |
| `numberonly` | `numberonly=1`       | Just the digits, nothing else               |

Example: `overlay.html?size=140&label=PUSH-UPS%20TO%20GO&align=center&subs=1`

## 5. Use it on stream

Open the control page (`/control.html`) — it's built for a phone, so you can
leave it open next to you on the floor.

- **Tap 5 / 10 / 20 / 25 / 50 / 100** right after a set. The overlay updates
  instantly, no refresh.
- **Custom amount** for anything else.
- **Undo last** if you fat-finger it.
- **Base owed** — what you carried in from last time, plus any pledge or dare.
  This stream's subscribers add on top of it.
- **Push-ups per sub** — `1` for "+1 subscriber = +1 push-up". Decimals work, so
  `0.5` is one push-up per two subs if the growth gets out of hand.
- **Start new stream** — only needed if you go live twice in one day. Starting
  the server already does this for you.

The counter survives a restart: everything lives in `state.json` next to the
server, written after every change.

## 6. Counting with the webcam

Open **`/camera.html`** (there's a button at the top of the control page), hit
**Start camera**, and get into a push-up position. Every rep it sees is sent to
the server as you do it, so the OBS overlay counts down live — no tapping.

Optional one-off, worth doing: vendor the pose model locally so nothing is
downloaded at stream time.

```bash
npm run fetch-assets     # ~24 MiB into public/vendor, gitignored
```

Without it the page pulls the same files from a CDN the first time you start the
camera. `npm run fetch-assets -- --clean` reverts to the CDN.

### Camera placement

Off to your side, chest height, 2–3 m back, whole body in frame from hands to
feet. Joint angles are computed from the model's metric 3D landmarks, so a
head-on or three-quarter camera works too — side-on is just the most reliable.

### How a rep is counted

Each frame gives 33 body landmarks. From those it takes the **elbow angle**
(shoulder → elbow → wrist, averaged across whichever arms are clearly visible)
and the **plank angle** (shoulder → hip → knee) to check your body is straight.

A rep is a state machine with two thresholds:

```
top (elbow ≥ up threshold) → bottom (elbow ≤ down threshold) → back to top  ⇒  +1
```

It counts on the way up, when the rep is actually finished. Two thresholds
rather than one is what stops jitter around a single value from spraying out
phantom reps. On top of that:

- Angles run through a moving average, so one bad frame can't trigger a count.
- The bottom of the rep must last a minimum time, and reps must be a minimum
  time apart — flailing doesn't count.
- If your hips sag or pike past the plank threshold the rep is thrown away and
  you have to re-establish the top position. Switch it off if it's too strict.
- Losing the pose (you leave frame) abandons the rep in progress rather than
  banking it.
- Reps counted while the server is unreachable are held and sent when it's back,
  so a blip doesn't quietly cheat you out of push-ups.

### Tuning it to you

Range of motion varies, so the defaults won't suit everyone. Do one slow rep
watching the **live elbow angle** readout, note what you actually hit at the top
and bottom, and set the thresholds just inside that range.

| Setting | Default | What it does |
| --- | --- | --- |
| Down threshold | 100° | How bent your arms must get to register the bottom |
| Up threshold | 155° | How straight they must get to complete the rep |
| Min plank angle | 140° | How straight your body must be for a rep to count |
| Smoothing | 0.5 | Lower = steadier but laggier; higher = twitchier |
| Min time between reps | 400 ms | Debounce floor |

Reps **missed**? Raise the down threshold and lower the up threshold. Getting
**double counts**? Raise the min time between reps and lower the smoothing.
Settings are saved per machine.

### While you're actually down there

You're facing the floor and can't see the screen, so turn on the **beep** (rep
landed) and optionally the **voice**, which reads out how many you have left
after each rep.

- **Space bar** logs a rep by hand if the camera misses one.
- **−1 (miscount)** takes back a rep it counted that you didn't do.
- **Undo last** removes the whole detected run — consecutive detected reps are
  rolled into one entry so a 40-rep set doesn't bury the rest of your history.

### Notes

- The camera page must be open on the machine the webcam is plugged into, at
  `http://127.0.0.1:4747/camera.html`. Browsers only grant camera access on a
  secure origin, and a LAN IP isn't one — so unlike the control page, this one
  can't be driven from your phone.
- If `CONTROL_TOKEN` is set, open it as `/camera.html?token=YOUR_TOKEN`.
- Close OBS's own access to the webcam first if it has it exclusively, or the
  page won't be able to open it.
- Video is processed entirely in the browser and never leaves the machine.

## 7. Putting the tracker on stream

`/camera.html` is the page you tune on — sliders, readouts, a big control panel.
You don't want that on stream, and you can't point OBS's Video Capture Device at
the same webcam the browser is using; on most machines whichever app opens the
camera first keeps it.

So there's a second page built for OBS: **`/tracker.html`**. It shows your camera
with the skeleton drawn on it, counts your reps, and reports them to the same
server — one Browser Source that replaces the Video Capture Device entirely, so
nothing is fighting over the webcam.

**Sources → + → Browser:**

| Field  | Value                                            |
| ------ | ------------------------------------------------ |
| URL    | `http://127.0.0.1:4747/tracker.html?count=1`     |
| Width  | `1280`                                           |
| Height | `720`                                            |

Then **remove the Video Capture Device** for that camera from your scene. Leave
"Shutdown source when not visible" **off** for this one — the camera needs to
stay open while you're doing push-ups off-scene.

### Making it look like part of the scene

The page is transparent, so it composites like the text overlay.

| Param | Example | What it does |
| --- | --- | --- |
| `count` | `count=1` | Count reps from this page. **Off by default** |
| `cutout` | `cutout=1` | Remove the background — just you over your scene |
| `bg` | `bg=00ff00` | Solid colour behind you, if you'd rather key it in OBS |
| `video` | `video=0` | No camera picture, skeleton only |
| `skeleton` | `skeleton=0` | Hide the skeleton |
| `counter` | `counter=0` | Hide the number baked into this source |
| `mirror` | `mirror=1` | Flip horizontally |
| `size` | `size=72` | Size of the baked-in number, in px |
| `color` | `color=%23ffffff` | Colour of that number |
| `label` | `label=TO GO` | Text after the number |

`cutout=1` is the one worth trying first: the pose model returns a body-shaped
mask, so the background is removed and you appear over your scene with no
physical green screen and no chroma key. It costs some GPU, so it's only
computed when you actually ask for it.

If you'd rather key it yourself, `bg=00ff00` fills the background with green
instead of transparency and you add a Chroma Key filter in OBS. Asking for `bg`
turns the cutout on for you — otherwise the camera frame would cover the colour
and it would look like the setting did nothing.

Skeleton-only over your existing camera (`video=0&count=1`) is possible, but it
means both OBS and the browser want the webcam. Only do that if your camera
allows two apps at once.

### Only one page counts at a time

`tracker.html?count=1` and `camera.html` both count. If both are open, every
push-up is counted twice. The server reports whichever page counted most
recently, and the other one says so — but it can't guess which you meant, so
close the camera page before you go live, or run the source with `count=0` and
keep counting from the camera page.

## Streams, and why the count resets

Push-ups only accrue from subscribers gained **during a stream**. When a stream
ends, the counter stops moving until the next one starts.

Starting the server decides which it is:

- **Off for more than 6 hours** (`NEW_STREAM_AFTER_HOURS`) → new stream. The sub
  baseline moves to your current count, push-ups done resets to 0, and anything
  you still owed becomes the new base owed. Overnight growth costs you nothing.
- **A shorter gap** — an OBS crash, a reboot, a laptop lid mid-stream → the
  session in progress picks straight back up, sub baseline and all.

Set `NEW_STREAM_AFTER_HOURS=off` to only ever start streams by hand, or `0` to
always start fresh on launch. The **Start new stream** button is there for a
second stream in one day.

So if you finish a stream owing 120, you come back tomorrow owing 120 — not 120
plus every subscriber who arrived while you were asleep.

## Controlling it from your phone

By default the server only listens on `127.0.0.1`, so nothing outside your
machine can touch it. To use your phone on the same Wi-Fi, set both of these in
`.env`:

```
HOST=0.0.0.0
CONTROL_TOKEN=some-long-random-string
```

Then open `http://<your-computer-ip>:4747/control.html?token=some-long-random-string`.
The overlay stays readable without a token; only changes require it.

## Notes on the YouTube API

- Polling is every 30s by default (`POLL_SECONDS`). Each poll costs 1 quota
  unit, so a 24h stream uses ~2,880 of the free 10,000/day. Stop the server when
  you go off air and it costs nothing at all.
- **YouTube rounds public subscriber counts once you pass 1,000** (1,010 → shows
  as "1.01K", and the API returns `1010`; past 10,000 it rounds to 3
  significant figures). Below 1,000 the count is exact. Above that, expect the
  counter to move in jumps rather than one at a time — that's YouTube, not this
  app.
- If your channel has subscriber count hidden, the API returns
  `hiddenSubscriberCount` and no usable number; the control page will say so.
- If the API errors or the network drops, the overlay keeps showing the last
  known number and dims slightly, rather than blanking out mid-stream.

## Tests

```bash
npm test
```

No dependencies to install. Covers the rep-counting state machine and pose
geometry against synthetic angle sequences (clean reps, partial reps, jitter at
the threshold, dropped poses, sagging hips, double-count debounce), and the
server's `/api/done` behaviour over real HTTP.
