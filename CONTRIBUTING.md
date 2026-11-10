# Contributing to Reddate

Thanks for wanting to help! Reddate is a small project: a Node/Express +
Socket.IO server, plain JavaScript engine pages, a React browser app (`web/`) and
an Android TV app (`android-tv/`). The server needs no build step and no
database to run locally.

## Run it locally (about 2 minutes)

```bash
git clone https://github.com/<you>/Reddate.git   # your fork of uD000/Reddate
cd Reddate
npm install
npm start          # http://localhost:3000   (npm run dev auto-reloads)
```

Open the page in two browser tabs, pick a name in each, and join the same room
with the invite link to test sync, chat and the Lounge.

Optional keys go in a `.env` file next to `server.js` (it's git-ignored; see
`.env.example`). Everything works without them except the GIF picker (needs a
free GIPHY key) and the stats page (needs Upstash Redis).

**Never commit `.env` or any real key, token, password or addon URL** (addon
URLs often contain a private token). Use placeholders in examples.

## Where things live

| Path | What it does |
|------|--------------|
| `server.js` | Express + Socket.IO: rooms, chat relay (never stored), video sync, Lounge signaling, stats endpoints |
| `stats.js` | Anonymous usage counters (optional, Upstash) |
| `public/index.html` | The page, styles and icons |
| `public/tokens.css` | Design tokens (colours, type, spacing) for both themes |
| `public/app.js` | Room, chat, player, full screen, comments panel |
| `public/addons.js` | Stremio-style addon browsing and stream picking |
| `public/tracks.js` | Subtitles and audio tracks |
| `public/voice.js` | The Lounge (WebRTC voice/video) |
| `public/mkv.js`, `public/badges.js` | MKV header reading, stream badges |
| `views/stats.html` | The private `/stats` dashboard |
| `accounts.js`, `catalog.js`, `yt-addon.js`, `trackers.js` | Accounts and profiles, the TMDB catalog, Reddate YT, Trakt and Simkl |
| `web/` | The browser app (React and Vite). After changing it run `cd web && npm install && npm run build` and commit `web/dist` |
| `android-tv/` | The Android TV app (see its README to build it) |
| `tv-site/` | The info site (download, addons, legal pages) |

## Ground rules

- **Keep it light on data.** Never store or log chat or room contents, and keep
  stats to anonymous counts (no IPs, room links, chat, names or titles). Don't
  add tracking. Be honest in the UI: chat is *not* end-to-end encrypted.
- **Use the design tokens.** Colours and fonts come from `public/tokens.css`
  (`var(--color-…)`); please don't hard-code colours. Check both light and dark.
- **Test on a phone-sized screen** (320–414 px) as well as desktop. No sideways
  scrolling, and buttons should be easy to tap.
- **Match the surrounding code**: plain JavaScript, small functions, comments
  that explain *why*.
- Keep pull requests small and focused; describe what you changed and how you
  tested it. Screenshots help for UI changes.

## Good first things

Look for issues labelled `good first issue`, or see [docs/TEST-PLAN.md](docs/TEST-PLAN.md). Testing on real devices (iPhone Safari, Android
Chrome, Google TV) and reporting what breaks is just as valuable as code.

## Licence

By contributing you agree that your contribution is licensed under the MIT
licence in `LICENSE`.
