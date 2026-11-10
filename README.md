<p align="center">
  <img src="docs/media/social-preview.png" alt="Reddate: movie night, in sync" width="100%">
</p>

<h1 align="center">Reddate</h1>

Party invitations use five letters or numbers, for example `A7B2C`. Creating a
party automatically generates a unique code. Use **Copy room code** to share it.
Browsers and Android TVs join by typing that code or pasting an invite link. Previous
eight-character codes and links still work. Joining waits for server confirmation;
invalid codes, closed rooms and account/profile restrictions show an error.

`reddate.xyz`, `tv.reddate.xyz` and Android TV must use the same TV server process
to share rooms. This branch serves the browser app on `reddate.xyz` by default.
If `reddate.xyz` continues running the `main` branch, its lobby sends new parties
to `https://tv.reddate.xyz`; set `SHARED_PARTY_URL` there for another shared server.
Keep the Android app's start URL pointed at that same service. Room state is in
memory, so independent deployments do not share rooms.

The browser Language menu supports live native/HLS track switching and the
embedded MP4/MKV audio fallback from `main`. Install FFmpeg and ffprobe on the TV
server for that fallback, or set `FFMPEG_PATH` and `FFPROBE_PATH`. Android TV
switches tracks through its native player. Both remember the viewer's language
for later videos, preserve playback position, and keep the choice local to that
viewer. Temporary audio buffering holds only that viewer's picture.

<p align="center">
  <b>Movie night, in sync.</b><br>
  An open-source watch-party app for Android TV, phones and browsers.<br>
  Everyone presses play together, the best stream is picked for you, and you bring your own addons.
</p>

<p align="center">
  <a href="https://tv.reddate.xyz/download"><b>Download for Android TV</b></a> ·
  <a href="https://tv.reddate.xyz/app">Open in the browser</a> ·
  <a href="https://tv.reddate.xyz/addon-list">Addons</a> ·
  <a href="docs/">Docs</a> ·
  <a href="https://discord.gg/UubFc9Kw3d">Discord</a>
</p>

<p align="center">
  <a href="LICENSE"><img alt="MIT licence" src="https://img.shields.io/badge/licence-MIT-ff6a32?style=flat-square"></a>
  <a href="../../releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/uD000/Reddate?style=flat-square&color=ff6a32"></a>
  <img alt="Android TV" src="https://img.shields.io/badge/Android%20TV-Kotlin%20%2B%20Compose-1d1917?style=flat-square">
  <img alt="Node 18+" src="https://img.shields.io/badge/Node-18%2B-1d1917?style=flat-square">
  <img alt="Stremio addon format" src="https://img.shields.io/badge/addons-Stremio%20format-1d1917?style=flat-square">
  <a href="https://discord.gg/UubFc9Kw3d"><img alt="Discord" src="https://img.shields.io/badge/chat-Discord-5865F2?style=flat-square&logo=discord&logoColor=white"></a>
</p>

---

## What it is

- **Watch together.** Start a room from your TV and share its code or QR. New viewers join the current video at the party's live position, using the host's current audio and subtitles. Viewers can then choose another audio language, turn subtitles off, or adjust subtitle timing on their own device. Their choices do not change anyone else's player. Shared starting settings are held in memory until the video changes or the room closes.
- **Resume on refresh.** A browser tab remembers its joined room and name. Refreshing the classic page or browser app returns directly to the room. Leaving the room explicitly clears that tab's saved session.
- **A TV app that feels native.** Home with Top 10 rows per streaming service, Continue watching, big posters, a remote-friendly layout and a stream picker that shows speed and device support before you press play.
- **You bring the sources.** Reddate speaks the Stremio addon format, so the catalogs and stream sources you already use work. Reddate hosts no video.

## See it

<table>
  <tr>
    <td width="50%"><img src="tv-site/assets/hero-home.jpg" alt="Home with Continue watching and trending rows"><br><sub><b>Home.</b> Continue watching, trending and Top 10 rows, per profile.</sub></td>
    <td width="50%"><img src="tv-site/assets/p-streams.jpg" alt="Stream picker with speed, quality and device badges"><br><sub><b>Streams.</b> Speed, quality, language and device checks, best first.</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="tv-site/assets/p-invite.jpg" alt="Invite panel with a party code and QR"><br><sub><b>Invite.</b> One press for a code and a QR. It works until the room closes.</sub></td>
    <td width="50%"><img src="tv-site/assets/p-top10.jpg" alt="Top 10 rows with big ranking numbers"><br><sub><b>Top 10.</b> The ten most-watched titles on each service in your country.</sub></td>
  </tr>
</table>

Poster and still images in these pictures belong to their owners.

## Features

**Watch parties**
- Rooms start only when you invite someone, so watching alone creates nothing on the server.
- One shared "anchor" position. Every player steers itself toward it, so a slow connection catches up without dragging the room back.
- Hosts (more than one is possible) play, pause and seek. A host who drops out has a short grace period before control passes to a guest.
- Chat with pop-ups over the video on TV, and a voice and video lounge on phones and computers.

**Home and discovery**
- Top 10 per service (Netflix, Prime Video, Disney+, Apple TV+, Max and more), trending, popular, genres and search.
- Profiles, one per person, each with its own Home rows, addons, Continue watching and tracking.
- A calendar of upcoming releases and watch tracking with Trakt and Simkl.

**Streams and subtitles**
- Streams are ranked before you choose: speed measured on your connection, quality, audio languages, and whether your TV, phone or computer can play them.
- Subtitles in any language, per viewer, with delay, size, colour and position.

**Addons**
- Any Stremio-compatible addon (catalogs, streams, subtitles).
- **Reddate Catalog**: movies and series from TMDB, with your country and rows chosen on the [addons page](https://tv.reddate.xyz/addon-list).
- **Reddate YT**: YouTube trending, music, gaming, news, search and channels, with your own free YouTube API key. It plays in Reddate's own player, with the room tools one press away.

**Privacy**
- Rooms live in memory and disappear when everyone leaves. Chat is relayed, never stored or logged. See [docs/PRIVACY.md](docs/PRIVACY.md) for exactly what is and isn't private.

## How it fits together

```mermaid
flowchart LR
  subgraph Devices
    TV["Android TV app<br/>Compose UI + WebView engine"]
    WEB["Browser app<br/>React"]
  end
  subgraph Server["One Node process"]
    IO["Socket.IO<br/>rooms, sync, chat"]
    API["Accounts, Catalog,<br/>Reddate YT, Trackers"]
  end
  TV <--> IO
  WEB <--> IO
  TV --> API
  WEB --> API
  API --> REDIS[("Upstash Redis<br/>accounts, stats")]
  API --> TMDB["TMDB"]
  TV -.-> ADDONS["Stream and catalog addons"]
  WEB -.-> ADDONS
```

Read more in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Run it yourself

```bash
git clone https://github.com/uD000/Reddate.git
cd Reddate
npm install
npm start            # http://localhost:3000
```

Everything optional (accounts, the movie catalog, GIFs, stats) turns on with environment variables; copy `.env.example` to `.env`. The full guide, including Render, is in [docs/SELF-HOSTING.md](docs/SELF-HOSTING.md). To build the TV app, see [android-tv/README.md](android-tv/README.md).

## Project layout

| Path | What is in it |
|------|---------------|
| `server.js` | Socket.IO rooms, video sync, chat relay, parties, pairing |
| `accounts.js`, `catalog.js`, `yt-addon.js`, `trackers.js`, `stats.js` | Accounts and profiles, the TMDB catalog, Reddate YT, Trakt and Simkl, anonymous counts |
| `android-tv/` | The Android TV app (Kotlin, Jetpack Compose, Media3) |
| `web/` | The browser app (React and Vite); `web/dist` is the built copy the server serves |
| `public/` | The engine pages shared by the TV and browser apps |
| `tv-site/` | The info site: download, addons, legal pages |
| `docs/` | Guides, measurements and the site's media |

## Docs

[Architecture](docs/ARCHITECTURE.md) · [Addons](docs/ADDONS.md) · [Privacy](docs/PRIVACY.md) · [Self-hosting](docs/SELF-HOSTING.md) · [Performance notes](docs/PERFORMANCE.md) · [Test plan](docs/TEST-PLAN.md)

## Community

Questions, bugs, ideas and early builds: join the [Reddate Discord](https://discord.gg/UubFc9Kw3d). Longer discussions live in [GitHub Discussions](../../discussions).

## Contributing

Bug reports, ideas and pull requests are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md). To report a security problem, use [SECURITY.md](SECURITY.md) and please don't open a public issue.

If you enjoy Reddate you can [buy the maintainer a coffee](https://buymeacoffee.com/udhere2t).

## Credits

- Movie and series data and images from [TMDB](https://www.themoviedb.org). *This product uses the TMDB API but is not endorsed or certified by TMDB.* Streaming-availability data is provided by JustWatch.
- Icons: [Lucide](https://lucide.dev) (ISC). Fonts: Bricolage Grotesque, Hanken Grotesk, JetBrains Mono and Geist (SIL Open Font Licence). HLS playback: [hls.js](https://github.com/video-dev/hls.js) (Apache-2.0). GIFs: [GIPHY](https://giphy.com). Subtitles: OpenSubtitles, through addons.
- Stremio and Nuvio are trademarks of their owners. Reddate only speaks their addon format.

> Reddate hosts no content. What a room can play depends entirely on the addons its members add; make sure the sources you use are ones you are allowed to stream.

## Licence

[MIT](LICENSE) © 2026 Uday Katare
