# Push-Up Counter

A live push-up counter for streams. It watches your YouTube subscriber count
(YouTube Data API v3), adds push-ups as subscribers roll in, and renders the
number left as white text on a fully transparent page you can drop straight into
OBS as a browser source. When you knock out a set, tap a button and the number
comes down.

```
left to do = base owed + (subscribers − baseline) × push-ups per sub − done
```

No dependencies, no build step, no `npm install`. Just Node 18+.

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
- **Base push-ups owed** — the fixed pile you started with (a sponsor pledge,
  a dare, whatever). Subscribers add on top of this.
- **Push-ups per sub** — `1` for "+1 subscriber = +1 push-up". Decimals work.
- **Start subs from now** — resets the baseline to the current count, so only
  subscribers gained from this moment on add push-ups. Hit this at the top of a
  stream.

The counter survives a restart: everything lives in `state.json` next to the
server, written after every change.

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
  unit, so a 24h stream uses ~2,880 of the free 10,000/day.
- **YouTube rounds public subscriber counts once you pass 1,000** (1,010 → shows
  as "1.01K", and the API returns `1010`; past 10,000 it rounds to 3
  significant figures). Below 1,000 the count is exact. Above that, expect the
  counter to move in jumps rather than one at a time — that's YouTube, not this
  app.
- If your channel has subscriber count hidden, the API returns
  `hiddenSubscriberCount` and no usable number; the control page will say so.
- If the API errors or the network drops, the overlay keeps showing the last
  known number and dims slightly, rather than blanking out mid-stream.
