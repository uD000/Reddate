> **This branch (`main`) runs [reddate.xyz](https://reddate.xyz)**, the original browser watch-party page.
> The full project (Android TV app, browser app, accounts, catalog and the info site) is on the
> [`tv` branch](../../tree/tv), which is the default branch and runs [tv.reddate.xyz](https://tv.reddate.xyz).

# Reddate

Create a private room, drop in a video, and watch it in perfect sync while you
chat — with **end-to-end encrypted** messages and a Discord-style **voice/video
lounge**. No accounts, no database, nothing stored. Rooms disappear the moment
everyone leaves.

Originally built as a two-person virtual-date page, now reworked so **anyone,
anywhere** can spin up a room and share the link. Styled after Reddit
(light theme: white + orange).

## Features

- 🎬 **Synced video playback** — YouTube links *and* direct video URLs (`.mp4`,
  `.webm`, `.ogg`, …). Play, pause, seek and load together; late joiners and
  drifters auto-catch-up. Playback commands that arrive before a viewer's player
  is ready are buffered and applied on load, so nobody has to "press play first".
- 🔒 **End-to-end encrypted chat** — messages are encrypted in the browser with
  AES-GCM 256. The room key lives only in the invite link (after the `#`) and
  never touches the server, which relays opaque ciphertext only.
- 🎙️ **Lounge** — Discord-style: anyone in the room can hop in or out, up
  to 8 people, mic on and camera optional, with a speaking indicator.
  Peer-to-peer over WebRTC (a mesh), end-to-end encrypted by DTLS-SRTP;
  signaling is relayed through the room and media never touches the server.
- 🖼️ **Images & GIFs** — upload an image (sent E2E as a data URL, 2 MB cap), or
  pick a GIF from the GIPHY picker (trending on open, search as you type, more
  loads as you scroll). Needs a free `GIPHY_API_KEY` — see *Getting started*.
- ⌨️ **Live typing indicators** and reaction "rain" on trigger words (`love`,
  `lol`, `fire`, …), detected locally on decrypted text.
- 💬 **Lightweight polls** to keep the room fun.
- ⬆️⬇️ **Reddit-style UI** — subreddit-style header, OP tag, cosmetic upvote/downvote,
  and a "Comment" send button.
- 🔗 **Shareable invite links** — create a room, copy the link, send it to anyone.
- 👥 **Multi-participant rooms** — share the link with as many people as you like
  (voice holds up to 8; chat and video sync have no limit).
- 🍿 **Browse movies & shows with Stremio/Nuvio addons** — paste any
  Stremio-compatible addon URL into a room and everyone in it can browse
  catalogs, search, pick a season/episode, and play a stream in sync.

## Addons (Stremio / Nuvio compatible)

Reddate speaks the [Stremio addon protocol](https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/protocol.md),
the same format Nuvio uses, so existing addons work as-is:

1. In a room, click **🍿 Browse movies & shows** → **🧩 Addons** and paste an
   addon's `manifest.json` URL.
2. **Catalog** addons add rows to browse and search. Cinemeta is built in, so
   browsing works before you add anything; other catalog addons add more.
3. **Stream** addons turn a title or episode into playable links. Reddate ships
   none — to play anything, someone in the room pastes their own stream addon.
   Pick a stream and it loads for the whole room through the normal synced player.

How it fits together:

- **The browser talks to addons directly.** Stremio addons serve
  `Access-Control-Allow-Origin: *`, so the server never proxies them.
- **The room's addon list is end-to-end encrypted** with the room key, like chat.
  Addon URLs often contain personal auth tokens; the server only stores and
  relays an opaque blob so late joiners receive the list.
- **Only streams that actually play are listed.** What a browser can decode
  depends on the browser: Safari and Chrome on Mac handle HEVC, Chrome opens many
  MKVs, and Chrome/Firefox can't decode Dolby (AC-3 / E-AC-3 "DDP") audio, so
  those files play silently. Stream titles can't tell you that, so Reddate
  test-plays each stream for a few seconds in a hidden, muted player and lists
  only the ones whose video **and** audio decode (stopping once it finds 5).
  Checks pause while the tab is hidden, since browsers won't play media there.
  Files whose container or codecs this browser reports it can't decode (from the
  MKV header, e.g. MKV on iPhone or Dolby audio in Chrome) are skipped without
  downloading, and the search stops after 45 seconds — if nothing was confirmed
  by then (or the phone blocks test playback, e.g. in Low Power Mode), the best
  remaining candidates are shown to try.
  Torrent/magnet-only results, streams needing custom request headers, and
  30 GB+ remuxes are skipped. HLS (`.m3u8`) plays via hls.js.
- The room's addon list is also remembered in your browser (on your device only),
  so refreshing while you're alone in a room doesn't lose it.
- **Badges** — each stream shows what its release name says: resolution,
  streaming service (Netflix, Prime Video, Disney+…), Dolby Vision / HDR,
  source (REMUX, Blu-ray, WEB-DL, and a red CAM warning), audio (Atmos, DD+,
  DTS-HD, AAC, 5.1…), codec and edition. Logos are public-domain files linked
  from Wikimedia Commons (so viewers' browsers load them from Wikimedia);
  everything else is a Reddate-styled badge.

### Subtitles & audio tracks

Both are **per viewer** — each person picks their own; nothing is synced.

- **💬 Subtitles** — for titles picked from Browse, subtitles come from the
  built-in OpenSubtitles v3 addon plus any room addon that offers subtitles.
  Pick a language and a file (ones matching the stream's release are ranked
  first, early CAM/TS rips last), nudge timing ±0.5s if they drift, or load
  your own `.srt`/`.vtt` file for any video. Your language is remembered and
  applied automatically to the next title.
- **🔊 Language** — open the Language button below the video, or the audio
  icon in full-screen mode, to switch audio while watching (e.g. Hindi / English).
  Your choice applies only to you, keeps the playback position, and is remembered
  for the next video when that language is available. The list updates as tracks
  load. Switching requires audio tracks supplied by the source. Native and HLS
  players switch tracks directly. For embedded tracks in MP4/MKV files that the
  browser cannot switch, the server uses **FFmpeg + ffprobe** to identify the real
  tracks and decode short audio chunks. The original video keeps playing directly
  from its source; the selected audio follows pauses, seeks, buffering and playback
  speed. Alternate audio uses the player's volume and mute setting from before
  switching. For titles with
  many tracks, the list scrolls while the heading and controls stay
  visible. Recently decoded audio is reused when switching back, and the current
  audio continues until the new track is ready. The first uncached track still
  depends on the source host's response time. Seeking requests the target audio
  immediately; if it is not cached, this viewer's picture waits with a buffering
  indicator until sound is ready. Near an audio chunk boundary, the next chunk
  also loads before resuming to avoid repeated short stops. Picture and sound
  then resume together without broadcasting that local hold as a room pause.
  Routine room corrections wait for the video decoder to settle after a seek.
  The fallback supports different
  titles, addons and audio codecs.
  YouTube manages alternate audio through its own Settings → Audio track
  menu, when the video offers it. This does not translate or dub single-language videos.
- **🔊 Stream languages** — Chrome/Firefox always play a file's *default*
  audio track, so each stream shows what you'll hear first, e.g.
  "🔊 Hindi (+ Tamil, English)". The languages come from the file's own MKV
  header when it can be read, otherwise from the release name.
  File hosts usually block browsers from reading that header, so the Reddate
  server reads it instead: only the first 64 KB (never the video), returning
  only the track languages. It refuses private/internal addresses and is
  rate-limited per client.
- Some addon sources take a while (sometimes a minute) to start; the player shows
  a loading notice and suggests picking another stream if one is slow.

> Reddate hosts no content. What a room can play depends entirely on the addons
> its members add — make sure the sources you use are ones you're allowed to stream.

## How the privacy model works

Reddate uses a shared-key end-to-end encryption scheme:

1. When you create a room, the browser generates a random room ID and a 256-bit
   AES-GCM key.
2. Both are placed in the URL **fragment**: `.../#room=<id>&k=<key>`. Browsers
   never send the fragment to the server, so the key stays client-side.
3. Everyone who opens the invite link gets the same key and can decrypt each
   other's messages. The server only ever relays opaque ciphertext.
4. Trigger-word reactions are detected locally on decrypted text, so no
   plaintext ever leaves your browser.

> **Note:** anyone with the invite link can read the room, so treat the link
> like a password. This protects against a curious/compromised server, not
> against someone you shared the link with. Chat history is never persisted.

### What is and isn't private

| Data | Private? |
|------|----------|
| Chat text & uploaded images | ✅ End-to-end encrypted (AES-GCM); server sees ciphertext only |
| Video/audio call media | ✅ End-to-end encrypted by WebRTC (DTLS-SRTP); peer-to-peer |
| Reaction detection | ✅ Runs locally on decrypted text |
| A room's addon list (and tokens in addon URLs) | ✅ End-to-end encrypted; server stores ciphertext only |
| Which video is loaded / playback position | ⚠️ Relayed in the clear (server coordinates sync), including a picked stream's URL and title |
| GIF searches | ⚠️ Sent from your browser to GIPHY (GIPHY requires this) — not E2E. The GIFs you send are E2E like any image. |
| GIF images, direct video links, addon requests | ⚠️ Fetched from the external host, revealing your IP to it — not E2E |
| Usage stats (if enabled) | Anonymous counts only — visits, unique visitors per day (salted hash, salt rotated daily, never stored), rooms, joins, messages, videos started by type, feature use. No IPs, room links, chat, names or titles. |
| Stream files' audio languages | ⚠️ When the file host blocks the browser, the server reads the file's first 64 KB to list its languages, so it sees those candidate stream URLs |
| Embedded audio switching fallback | ⚠️ The server reads portions of the selected media file and decodes the selected audio track. It sees the source URL and selected track. Short audio chunks and temporary source sessions are kept in memory, not written to disk. |

## Getting started

Requires Node.js 18+. For embedded-file audio switching, install `ffmpeg` and
`ffprobe` on the server (available on PATH), or set `FFMPEG_PATH` and `FFPROBE_PATH`.
Without them, native/HLS audio switching still works and the Language menu explains
that embedded audio switching needs the server tools. Set `AUDIO_EXTRACTION=off`
to disable the server fallback. It adds server CPU and media bandwidth usage;
extraction is limited to four concurrent jobs, two per client IP, with bounded
20-second chunks. Sources must have public HTTP(S) addresses.

```bash
npm install
npm start          # or: npm run dev  (auto-reload with nodemon)
```

Then open http://localhost:3000, enter a display name, and click
**Create a room**. Copy the invite link and share it. Paste a YouTube or direct
video URL to start watching, and hit **📹 Start Call** for a 1:1 video chat.

Set a custom port with `PORT=8080 npm start`.

Optional environment variables (locally, put them in a `.env` file next to
`server.js` — it's git-ignored; see `.env.example`):

- `SUPPORT_URL` — optional; shows a "Buy me a coffee" link (https only).
- `GIPHY_API_KEY` — turns on the GIF picker. Get a free key at
  [developers.giphy.com](https://developers.giphy.com/) → *Create an App* → *API*.
  (Tenor's API shut down on 30 June 2026.)
- `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `STATS_PASSWORD` — turn on
  the private stats page at `/stats` (log in with any username + the password).
  Counts are stored in a free [Upstash](https://upstash.com) Redis database.
- `TURN_URL`, `TURN_USERNAME`, `TURN_CREDENTIAL` — a TURN relay for calls behind
  strict NATs. STUN-only (default) works on most networks.

## Project structure

```
server.js          # Socket.IO relay server: rooms, video-state sync, ciphertext relay, WebRTC signaling
stats.js           # Anonymous usage counts → Upstash Redis (batched); powers /stats
views/stats.html   # The private stats page (served only after the password check)
public/index.html  # Markup + styles (lobby + app shell)
public/app.js      # Client logic: E2E crypto, chat, video sync (YouTube + direct links + HLS), polls
public/addons.js   # Stremio-compatible addons: catalogs, search, episodes, stream picker
public/tracks.js   # Per-viewer subtitles (addon + local files) and audio-track switching
public/audio-fallback.js # Keeps extracted audio aligned with the original video
public/playback-gate.js # Coordinates local audio buffering without pausing the room
media-audio.js     # Optional FFmpeg audio extraction, in-memory sessions and bounded chunks
public/mkv.js      # MKV header reader (audio track languages), shared by browser and server
public/badges.js   # Stream badges (resolution, service, HDR, source, audio, codec, edition)
public/voice.js    # Discord-style voice room, up to 8 (WebRTC mesh, E2E via DTLS-SRTP)
```

The server keeps all room state in memory (`rooms` Map) and never inspects
message contents.

## Deploying

This is a **single long-lived Node process**: Socket.IO needs a persistent
connection and rooms live in memory, so it must run on a platform that keeps a
process alive — not on serverless/static hosts. **Vercel and Netlify won't work
without a rewrite** (they'd need an external WebSocket service + Redis for shared
state). Good fits: **Render**, **Railway**, **Fly.io**, or any VPS.

Run behind **HTTPS** — invite links stay protected in transit, and browsers only
grant camera/mic (for calls) on secure origins.

### Render (one-click Blueprint)

A [`render.yaml`](render.yaml) blueprint is included. On [render.com](https://render.com):

1. **New +** → **Blueprint**, connect this GitHub repo.
2. Render reads `render.yaml` and provisions a free web service (`npm install`
   → `npm start`). `PORT` is injected automatically.
3. (Optional) Set `TURN_URL` / `TURN_USERNAME` / `TURN_CREDENTIAL` in the
   dashboard for reliable calls behind strict NATs. STUN-only works otherwise.

Then open the service URL, pick a name, and create a room.


## Roadmap

- Shared video queue and presence
- Group calls (currently 1:1)
- QR-code room invites

## License

MIT
