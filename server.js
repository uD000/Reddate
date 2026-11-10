// Reddate / virtual-date platform — room-based sync server.
//
// Privacy model: rooms live only in memory and are discarded once empty; chat
// history is never stored and chat is never logged. The server relays messages
// as-is (it can read them while relaying — this is not end-to-end encrypted
// chat). Optional accounts keep an email and saved profiles/addons, encrypted at
// rest (see accounts.js); anonymous usage counts are optional (see stats.js).

// Local development: read KEY=value lines from ./.env (git-ignored) into
// process.env, without overriding variables already set (e.g. on Render).
(function loadDotEnv() {
    try {
        const lines = require('fs').readFileSync(require('path').join(__dirname, '.env'), 'utf8').split(/\r?\n/);
        for (const line of lines) {
            const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
            if (!m || line.trim().startsWith('#')) continue;
            const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
            if (!(m[1] in process.env)) process.env[m[1]] = value;
        }
    } catch (e) { /* no .env file — fine */ }
})();

const express = require('express');
const http = require('http');
const dns = require('dns').promises;
const crypto = require('crypto');
const path = require('path');
const net = require('net');
const { Server } = require('socket.io');
const { parseMkvTracks, HEADER_BYTES } = require('./public/mkv.js');
const stats = require('./stats');
const accounts = require('./accounts');
const catalog = require('./catalog');

const app = express();
app.disable('x-powered-by'); // don't announce the framework
const server = http.createServer(app);

// Which web pages may open a live connection: our own site (and the TV app, which loads it), the local
// network and localhost while developing. Other websites can't connect on a visitor's behalf.
function originAllowed(origin, host) {
    if (!origin) return true; // not a browser page (the app's own requests, curl…)
    let o;
    try { o = new URL(origin); } catch (e) { return false; }
    const h = o.hostname;
    if (host && o.host === host) return true; // same site
    if (h === 'reddate.xyz' || h.endsWith('.reddate.xyz') || h.endsWith('.onrender.com')) return true;
    if (h === 'reddate.tv' || h.endsWith('.reddate.tv')) return true;
    if (h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.localhost')) return true;
    return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h); // a TV or phone on your own network
}
// A viewer that vanished (phone locked, app swiped away) is noticed within ~30 s, not left counted as "watching".
const io = new Server(server, {
    // A TV busy starting a video can go quiet for a while; dropping its host for that ends the party. 20 s + 40 s.
    pingInterval: 20000, pingTimeout: 40000,
    // A chat picture is sent as one message: the default 1 MB limit closed the sender's connection (they were thrown out of the room).
    maxHttpBufferSize: 8 * 1024 * 1024,
    cors: { origin: (origin, cb) => cb(null, originAllowed(origin, null) ? origin || true : false), methods: ['GET', 'POST'] },
    allowRequest: (req, cb) => cb(null, originAllowed(req.headers.origin, req.headers.host))
});

// Small per-IP limits for the open endpoints (sign-in and accounts have their own in accounts.js).
const hitsByKey = new Map();
function allowHit(key, max, windowMs) {
    const now = Date.now();
    const h = hitsByKey.get(key);
    if (!h || h.resetAt < now) { hitsByKey.set(key, { count: 1, resetAt: now + windowMs }); if (hitsByKey.size > 20000) hitsByKey.clear(); return true; }
    return ++h.count <= max;
}

// Basic security headers on everything we serve.
app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.set('X-Frame-Options', 'SAMEORIGIN'); // our pages can't be framed by other sites (clickjacking)
    // Only what's safe for a site that plays videos from anywhere and talks to any addon:
    // no plugins, no <base> tricks, no framing by other sites.
    res.set('Content-Security-Policy', "object-src 'none'; base-uri 'self'; frame-ancestors 'self'");
    res.set('Permissions-Policy', 'geolocation=(), payment=(), usb=()');
    if (req.secure || req.headers['x-forwarded-proto'] === 'https') res.set('Strict-Transport-Security', 'max-age=31536000');
    next();
});

// The browser app (reddate.tv): the same server answers it, by host name. TVs keep using tv.reddate.xyz.
// WEB_HOSTS is a comma-separated list; *.localhost hosts starting with "web." work for local development
// (web.localhost:3090). The app is built into web/dist (npm run build in /web).
const WEB_HOSTS = (process.env.WEB_HOSTS || 'reddate.xyz,www.reddate.xyz,reddate.tv,www.reddate.tv').split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
const isWebHost = req => {
    const h = String(req.hostname || '').toLowerCase();
    return WEB_HOSTS.includes(h) || /^web\.localhost$/.test(h);
};
const webDist = path.join(__dirname, 'web', 'dist');
// The browser app also answers on the TV host (tv.reddate.xyz) for phones and computers: /app, /join/CODE,
// titles, search… The TV app keeps loading the engine page at "/?tv=1".
const APP_PATHS = /^\/(app|join|title|search|watch|addons|account|profiles|rd-assets)(\/|$)|^\/sw\.js$/;
const webIndexCache = new Map();
function webIndexHtml(home) {
    const f = path.join(webDist, 'index.html');
    let st; try { st = require('fs').statSync(f); } catch (e) { return null; }
    const c = webIndexCache.get(home);
    if (c && c.mtime === st.mtimeMs) return c.html;
    const html = require('fs').readFileSync(f, 'utf8').replace('<head>', `<head><script>window.__RD_HOME=${JSON.stringify(home)}</script>`);
    webIndexCache.set(home, { mtime: st.mtimeMs, html });
    return html;
}
app.use((req, res, next) => {
    // The engine: the existing page running without its own screens, driven by the browser app (web/src/engine.ts).
    if (req.path === '/engine') return res.set('Cache-Control', 'no-cache').sendFile(path.join(__dirname, 'public', 'index.html'));
    if (req.path === '/classic') return res.set('Cache-Control', 'no-cache').sendFile(path.join(__dirname, 'public', 'index.html'));
    const web = isWebHost(req);
    const q = req.query || {};
    const wantsApp = web || APP_PATHS.test(req.path) || (req.path === '/' && q.tv === undefined && (q.link !== undefined || q.open !== undefined));
    if (!wantsApp) return next();
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    express.static(webDist, { index: false, maxAge: '1h', setHeaders: (r, f) => { if (/\.html$/.test(f)) r.set('Cache-Control', 'no-cache'); } })(req, res, () => {
        // Files the engine page loads (app.js, icons…) and the API come next; anything else is a screen of the app.
        if (/^\/(api|catalog|socket\.io|downloads|media-info|get|privacy|terms|report|features|setup|addons-guide|addon-list|download|yt)(\/|$)/.test(req.path) || path.extname(req.path)) return next();
        const html = webIndexHtml(web ? '/' : '/app');
        if (!html) return next();
        res.set('Cache-Control', 'no-cache').type('html').send(html);
    });
});

// Render (and most hosts) put one proxy in front; trust it so req.ip is the
// real client for per-IP rate limits.
app.set('trust proxy', 1);
require('./media-audio').registerMediaAudio(app);
// The guest page for joining a watch party by code: the same app, trimmed down (see the `lean` class).
const appPage = path.join(__dirname, 'public', 'index.html');
const sitePage = name => path.join(__dirname, 'tv-site', name);
// The site's pages always ask the server first (their style link carries a version), so a deploy shows up at once.
app.use((req, res, next) => { if (/^\/(|download|addon-list|features|addons-guide|setup|privacy|terms|report)(\.html)?$/.test(req.path)) res.set('Cache-Control', 'no-cache'); next(); });
app.get(['/join', '/join/:code', '/app'], (_req, res) => res.sendFile(appPage));
// The Lounge: just the room's chat plus voice and video, for a phone or computer (the page's `lounge` mode; the TV
// app's chat QR code opens it). Same sign-in and profile rules as joining a party.
app.get(['/lounge', '/lounge/:code'], (_req, res) => res.set('Cache-Control', 'no-cache').sendFile(appPage));
// "/" is the landing page (what Reddate TV is, the download); the TV app, sign-in and invite links carry
// a query string and open the app, and an invite's #room=… is forwarded to /app by the landing page.
// Opening the address plainly lands in the app (it asks for sign-in or sign-up first, then shows Home). The
// landing page lives at /download and the public addon page at /addon-list. A #room=… fragment survives the redirect.
app.get('/', (req, res) => Object.keys(req.query).length ? res.sendFile(appPage) : res.redirect(302, '/app'));
app.get(['/download', '/download.html'], (_req, res) => res.sendFile(sitePage('download.html')));
app.get(['/addon-list', '/addon-list.html'], (_req, res) => res.sendFile(sitePage('addon-list.html')));
app.get('/addons', (_req, res) => res.redirect(302, '/app?open=addons')); // the short address the TV shows for managing addons
app.get(['/setup', '/setup.html'], (_req, res) => res.sendFile(sitePage('setup.html')));
app.get(['/features', '/features.html'], (_req, res) => res.redirect(301, '/download'));
app.get(['/privacy', '/privacy.html'], (_req, res) => res.sendFile(sitePage('privacy.html')));
app.get(['/terms', '/terms.html'], (_req, res) => res.sendFile(sitePage('terms.html')));
app.get(['/report', '/report.html'], (_req, res) => res.sendFile(sitePage('report.html')));
app.get('/robots.txt', (_req, res) => res.type('text/plain').sendFile(sitePage('robots.txt')));
app.get('/sitemap.xml', (_req, res) => res.type('application/xml').sendFile(sitePage('sitemap.xml')));
app.get(['/addons-guide', '/addons-guide.html'], (_req, res) => res.redirect(301, '/addon-list'));
app.use('/assets', express.static(path.join(__dirname, 'tv-site', 'assets'), { maxAge: '1h' }));
// Reddate YT: the YouTube addon (works in Reddate, Nuvio and Stremio) and its setup page at /yt.
require('./yt-addon').register(app);
// Crash reports from the TV app (the error and stack only, no personal data), shown in the server log.
app.post('/api/crash', express.text({ limit: '16kb', type: '*/*' }), (req, res) => {
    if (!allowHit(`crash:${req.ip}`, 20, 600000)) return res.status(429).json({ error: 'Slow down.' }); // no log flooding
    const text = typeof req.body === 'string' ? req.body.slice(0, 12000) : '';
    if (text) console.warn('[tv-crash]\n' + text);
    res.json({ ok: true });
});
// Bug reports: typed on the TV, or sent from a phone with a screenshot (tv.reddate.xyz/report). They arrive as
// an email to REPORT_TO (default hello@reddate.xyz) through Resend, the same mail service accounts use.
app.post('/api/report', express.json({ limit: '6mb' }), async (req, res) => {
    if (!allowHit(`report:${req.ip}`, 6, 3600000)) return res.status(429).json({ error: 'That’s a lot of reports from this connection. Try again in an hour.' });
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const clean = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, n);
    if (b.website) return res.json({ ok: true }); // the hidden field only a bot fills in
    const message = clean(b.message, 4000).trim();
    if (message.length < 5) return res.status(400).json({ error: 'Tell us a little more about what went wrong.' });
    const contact = clean(b.contact, 200).trim();
    const meta = { from: clean(b.source, 20) || 'web', app: clean(b.app, 40), device: clean(b.device, 120), screen: clean(b.screen, 80), account: clean(b.account, 200) };
    let attachments;
    const img = typeof b.image === 'string' ? /^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(b.image) : null;
    if (b.image && !img) return res.status(400).json({ error: 'That picture isn’t a PNG, JPEG or WebP image.' });
    if (img) {
        if (img[2].length > 5.5 * 1024 * 1024) return res.status(413).json({ error: 'That picture is too big. Try a smaller one.' });
        attachments = [{ filename: `screenshot.${img[1] === 'jpeg' ? 'jpg' : img[1]}`, content: img[2] }];
    }
    const text = [message, '', '— — —', `From: ${meta.from}`, contact && `Reply to: ${contact}`, meta.account && `Account: ${meta.account}`, meta.app && `App: ${meta.app}`, meta.device && `Device: ${meta.device}`, meta.screen && `Screen: ${meta.screen}`, `Time: ${new Date().toISOString()}`, attachments ? 'Screenshot attached' : ''].filter(Boolean).join('\n');
    const to = process.env.REPORT_TO || 'hello@reddate.xyz';
    try {
        if (process.env.MAIL_MODE === 'log' && !(process.env.RESEND_API_KEY && process.env.MAIL_SEND_REAL === '1')) {
            console.log(`\n[report → ${to}]\n${text}\n${attachments ? '(with screenshot)' : ''}\n`);
            return res.json({ ok: true });
        }
        if (!process.env.RESEND_API_KEY || !process.env.MAIL_FROM) return res.status(503).json({ error: 'Reports can’t be sent right now. Please try again later.' });
        const r = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ from: process.env.MAIL_FROM, to: [to], subject: `Bug report · ${message.replace(/\s+/g, ' ').slice(0, 60)}`, text, attachments,
                ...(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact) ? { reply_to: contact } : {}) }),
            signal: AbortSignal.timeout(15000)
        });
        if (!r.ok) { console.warn('[report] mail provider HTTP', r.status); return res.status(502).json({ error: 'Couldn’t send it. Please try again in a moment.' }); }
        res.json({ ok: true });
    } catch (e) {
        console.warn('[report] failed:', e.message);
        res.status(502).json({ error: 'Couldn’t send it. Please try again in a moment.' });
    }
});
// A stamp of the page's scripts: the long-lived engine on a TV polls it and reloads itself when it changed.
// Diagnostics: which server copy holds a room and who's in it (names only). Anyone with the code can join, so
// the code is the key here too.
app.get('/api/room-status/:code', (req, res) => {
    const code = String(req.params.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const room = rooms.get(code);
    if (room) pruneRoom(room);
    res.set('Cache-Control', 'no-store').json({
        instance: INSTANCE.id, upMin: Math.round((Date.now() - INSTANCE.startedAt) / 60000),
        exists: !!room, people: room ? [...room.users.values()].map(u => u.username) : [], trail: roomTrail.get(code) || [],
        host: room && room.party ? room.party.hostName : null, playing: room ? !!room.videoState.isPlaying : false
    });
});

app.get('/api/web-version', (_req, res) => {
    const fs = require('fs');
    let v = 0;
    for (const f of ['app.js', 'tv.js', 'account.js', 'addons.js', 'home.js', 'tracks.js', 'pages.js', 'index.html']) {
        try { v = Math.max(v, fs.statSync(path.join(__dirname, 'public', f)).mtimeMs); } catch (e) { /* ignore */ }
    }
    res.set('Cache-Control', 'no-store').json({ v: Math.round(v) });
});
// What version of the TV app is current (read by the app's own "Update" button).
app.get('/api/app-version', (_req, res) => {
    try {
        const v = JSON.parse(require('fs').readFileSync(path.join(__dirname, 'downloads', 'version.json'), 'utf8'));
        res.set('Cache-Control', 'no-store').json({ ...v, url: hasLocalApk() ? '/downloads/reddate-tv.apk' : APK_URL });
    } catch (e) { res.status(404).json({ error: 'No version information' }); }
});
// The Android TV app: tv.reddate.xyz/get is the short address to type into the Downloader app.
const apkFile = path.join(__dirname, 'downloads', 'reddate-tv.apk');
// The app file is a GitHub Release asset, so downloads cost this server no bandwidth (set APK_URL to host it elsewhere).
// A copy placed in downloads/ is served from here instead (self-hosting).
const APK_URL = process.env.APK_URL || 'https://github.com/uD000/Reddate/releases/latest/download/reddate-tv.apk';
const hasLocalApk = () => require('fs').existsSync(apkFile);
app.get(['/get', '/downloads/reddate-tv.apk'], (_req, res) => {
    if (!hasLocalApk()) return res.redirect(302, APK_URL);
    res.download(apkFile, 'reddate-tv.apk', err => { if (err && !res.headersSent) res.status(404).send('The app file is not available right now.'); });
});
app.use(express.static('public'));
accounts.mount(app, express); // sign-in, saved profiles, device pairing (off unless configured)
catalog.mount(app);           // our own TMDB catalog as a Stremio-style addon (off unless TMDB_TOKEN is set)

// ---- Anonymous usage stats (stats.js) ----
// The page pings once per load (Render's health checks would inflate a
// server-side count), plus a few feature events the server can't see —
// GIFs travel inside chat, Browse and calls are client-side.
const CLIENT_EVENTS = { visit: null, browse: 'browse', gif: 'gifs', call: 'calls' };
const eventHits = new Map(); // ip -> { count, resetAt }
app.post('/api/event', express.json({ type: ['application/json', 'text/plain'], limit: '1kb' }), (req, res) => {
    const now = Date.now();
    const hit = eventHits.get(req.ip);
    if (!hit || hit.resetAt < now) eventHits.set(req.ip, { count: 1, resetAt: now + 60000 });
    else if (++hit.count > 60) return res.status(429).end();
    if (eventHits.size > 10000) eventHits.clear();
    const e = req.body && req.body.e;
    if (!Object.prototype.hasOwnProperty.call(CLIENT_EVENTS, e)) return res.status(400).end();
    if (e === 'visit') stats.trackVisit(req.ip, req.get('user-agent'));
    else stats.track(CLIENT_EVENTS[e]);
    res.status(204).end();
});

// Private stats page: HTTP Basic auth with STATS_PASSWORD (any username).
const statsFails = new Map(); // ip -> { count, resetAt }
function requireStatsPassword(req, res, next) {
    const password = process.env.STATS_PASSWORD || '';
    if (!password) return res.status(404).type('text').send('Stats are off. Set STATS_PASSWORD to turn on the stats page.');
    const now = Date.now();
    const fails = statsFails.get(req.ip);
    if (fails && fails.resetAt > now && fails.count >= 10) return res.status(429).type('text').send('Too many attempts. Try again in a few minutes.');
    const [scheme, encoded] = (req.get('authorization') || '').split(' ');
    const given = scheme === 'Basic' && encoded ? Buffer.from(encoded, 'base64').toString().split(':').slice(1).join(':') : '';
    const a = Buffer.from(crypto.createHash('sha256').update(given).digest());
    const b = Buffer.from(crypto.createHash('sha256').update(password).digest());
    if (given && crypto.timingSafeEqual(a, b)) return next();
    if (given) {
        if (!fails || fails.resetAt < now) statsFails.set(req.ip, { count: 1, resetAt: now + 15 * 60000 });
        else fails.count++;
    }
    res.set('WWW-Authenticate', 'Basic realm="Reddate stats", charset="UTF-8"').status(401).type('text').send('Password required.');
}

// The owner's list of sign-ups (same password as the stats page): GET /admin/signups, add ?format=csv to download.
app.get('/admin/signups', requireStatsPassword, async (req, res) => {
    try {
        const list = await accounts.listSignups();
        if (req.query.format === 'csv') {
            const rows = ['email,signed up,confirmed,profiles,devices', ...list.map(r => `${r.email},${new Date(r.createdAt).toISOString()},${r.verified ? 'yes' : 'no'},${r.profiles},${r.devices}`)];
            return res.set('Content-Disposition', 'attachment; filename="reddate-signups.csv"').type('text/csv').send(rows.join('\n') + '\n');
        }
        res.set('Cache-Control', 'no-store').json({ count: list.length, confirmed: list.filter(r => r.verified).length, signups: list });
    } catch (e) { res.status(500).json({ error: 'Could not read the list.' }); }
});
app.get('/stats', requireStatsPassword, (_req, res) => {
    res.set('Cache-Control', 'no-store').sendFile(path.join(__dirname, 'views', 'stats.html'));
});
app.get('/api/stats', requireStatsPassword, async (req, res) => {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
    try {
        res.set('Cache-Control', 'no-store').json(await stats.report(days));
    } catch (e) {
        console.warn('stats:', e.message);
        res.status(502).json({ error: 'Stats are unavailable right now.' });
    }
});

// WebRTC ICE configuration. Media is peer-to-peer (WebRTC encrypts it in
// transit); a TURN relay only forwards those encrypted packets. Configure TURN via env for
// reliable calls across strict NATs (optional — STUN alone works on most LANs).
app.get('/rtc-config', (_req, res) => {
    const iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
    if (process.env.TURN_URL) {
        iceServers.push({
            urls: process.env.TURN_URL,
            username: process.env.TURN_USERNAME || '',
            credential: process.env.TURN_CREDENTIAL || ''
        });
    }
    res.json({ iceServers });
});

// GIF picker config (GIPHY). GIPHY requires its search/trending calls to come
// from the user's browser, so the key is handed to the client — GIPHY keys are
// designed for that (rate-limited per key). Without a key the picker explains
// how to set one up. (Tenor's API shut down on 30 June 2026.)
// Note: GIF searches go from the browser to GIPHY.
app.get('/gif-config', (_req, res) => {
    res.json({ provider: 'giphy', key: process.env.GIPHY_API_KEY || '' });
});

// Optional "support the project" link (Buy Me a Coffee, Ko-fi…). Only a plain
// https URL is passed on; unset means no button is shown.
app.get('/support-config', (_req, res) => {
    let url = '';
    try {
        const u = new URL(process.env.SUPPORT_URL || '');
        if (u.protocol === 'https:') url = u.href;
    } catch (_) { /* unset or invalid */ }
    res.json({ url });
});

// ---- Track lookup for stream files ----
// The stream picker needs each file's tracks: the audio languages (browsers only
// play the default audio track) and codecs (to skip files this browser can't
// decode without test-playing them). Most file hosts block browsers from reading
// them (CORS), so the client can ask here instead: the server reads the first
// 64 KB of the file (the MKV header — never the video) and returns only the
// track metadata. Never the raw bytes, so this can't be used as a
// general-purpose proxy. Private/internal addresses are refused.
const MEDIA_INFO_TIMEOUT = 10000;
const MEDIA_INFO_MAX_REDIRECTS = 3;
const MEDIA_INFO_RATE = { windowMs: 60000, max: 240 }; // per client IP (~40 files per title)
const mediaInfoHits = new Map(); // ip -> { count, resetAt }

function isPrivateIp(ip) {
    if (net.isIPv4(ip)) {
        const [a, b] = ip.split('.').map(Number);
        return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
            (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168) || a >= 224;
    }
    const v6 = ip.toLowerCase();
    const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return v6 === '::' || v6 === '::1' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80');
}

async function assertPublicHost(hostname) {
    const host = hostname.replace(/^\[|\]$/g, '');
    const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map(a => a.address);
    // Note: fetch() resolves again, so a DNS-rebinding host could still slip
    // through; acceptable here since only parsed track languages are returned.
    if (!addrs.length || addrs.some(isPrivateIp)) throw new Error('refused');
}

async function readMediaTracks(rawUrl) {
    let url = rawUrl;
    for (let hop = 0; hop <= MEDIA_INFO_MAX_REDIRECTS; hop++) {
        const u = new URL(url);
        if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
        await assertPublicHost(u.hostname);
        const res = await fetch(url, {
            headers: { Range: `bytes=0-${HEADER_BYTES - 1}` },
            redirect: 'manual', // follow by hand so every hop is checked
            signal: AbortSignal.timeout(MEDIA_INFO_TIMEOUT)
        });
        if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
            url = new URL(res.headers.get('location'), url).href;
            continue;
        }
        if (!res.ok || !res.body) return null;
        const reader = res.body.getReader();
        const buf = new Uint8Array(HEADER_BYTES);
        let n = 0;
        while (n < HEADER_BYTES) {
            const { done, value } = await reader.read();
            if (done) break;
            const take = Math.min(value.length, HEADER_BYTES - n);
            buf.set(value.subarray(0, take), n);
            n += take;
        }
        reader.cancel().catch(() => {});
        return parseMkvTracks(buf.subarray(0, n));
    }
    return null;
}

app.post('/media-info', express.json({ limit: '8kb' }), async (req, res) => {
    const now = Date.now();
    const hit = mediaInfoHits.get(req.ip);
    if (!hit || hit.resetAt < now) mediaInfoHits.set(req.ip, { count: 1, resetAt: now + MEDIA_INFO_RATE.windowMs });
    else if (++hit.count > MEDIA_INFO_RATE.max) return res.status(429).json({ tracks: null });
    if (mediaInfoHits.size > 10000) mediaInfoHits.clear(); // keep the limiter's memory bounded

    const url = req.body && req.body.url;
    if (typeof url !== 'string' || url.length > MAX_STREAM_URL || !/^https?:\/\//i.test(url)) {
        return res.status(400).json({ tracks: null });
    }
    try {
        const info = await readMediaTracks(url);
        // Only track metadata (codec, language, default flag) — never media bytes.
        res.json({ tracks: info ? info.audio : null, video: info ? info.video : null });
    } catch (e) {
        res.json({ tracks: null });
    }
});

// roomId -> { videoState, users: Map<socketId, {username}>, poll, pollVotes: Map, addons }
const rooms = new Map();
const { createRoomCodes, registerRoomCodes } = require('./room-codes');
const roomCodes = createRoomCodes(rooms);

const MAX_ROOM_ID = 128;
const MAX_USERNAME = 40;
const MAX_ADDONS = 60;       // addon links shared in a room
const MAX_ADDON_URL = 2000;
const MAX_TEXT = 2000;       // one chat message
const MAX_IMAGE = 3 * 1024 * 1024; // chat image as a data URL (client caps uploads at 2 MB)
const MAX_STREAM_URL = 4096;
const MAX_TITLE = 200;
const MAX_SUBTITLE_BYTES = 5 * 1024 * 1024;

// The room's video state as of right now (a playing video has moved on since its last update).
function stateNow(room) {
    const v = room.videoState;
    const now = Date.now();
    const currentTime = v.isPlaying ? v.currentTime + (now - v.lastUpdate) / 1000 : v.currentTime;
    return { ...v, currentTime, lastUpdate: now, serverTime: now };
}

function getRoom(roomId) {
    let room = rooms.get(roomId);
    if (!room) {
        room = {
            videoState: { videoId: '', isPlaying: false, currentTime: 0, lastUpdate: Date.now() },
            users: new Map(),
            poll: null,
            pollVotes: new Map(),
            // The room's Stremio-addon list (an array of manifest URLs), held in
            // memory only while the room exists. Addon URLs can carry private
            // tokens, so it is never logged or stored.
            addons: null,
            subtitles: null,
            audio: null,
            audioRevision: 0,
            settingsOwnerResume: null,
            subtitleRevision: 0,
            watchEpoch: 0,
            // Voice room: socket id -> { username, muted, cam }. Audio/video go
            // peer-to-peer (WebRTC mesh); the server only relays signaling.
            voice: new Map()
        };
        rooms.set(roomId, room);
        roomCodes.assign(roomId);
    }
    return room;
}

// What an addon-picked stream is (e.g. { type: 'series', id: 'tt0903747:1:1' }),
// so each viewer can fetch subtitles for it. Null for plain pasted links.
function cleanContent(c) {
    if (!c || typeof c !== 'object') return null;
    const type = c.type === 'movie' || c.type === 'series' ? c.type : null;
    const id = typeof c.id === 'string' && /^[\w:.\-]{1,100}$/.test(c.id) ? c.id : null;
    if (!type || !id) return null;
    const filename = typeof c.filename === 'string' ? c.filename.slice(0, MAX_TITLE) : '';
    // Artwork shown while the stream loads — only from the catalogs' own image servers.
    const art = typeof c.art === 'string' && c.art.length <= 500 &&
        /^https:\/\/(image\.tmdb\.org|images\.metahub\.space|live\.metahub\.space|episodes\.metahub\.space)\/[\w\/.\-]+$/.test(c.art) ? c.art : '';
    // The show an episode belongs to (so viewers can pick another episode from the player).
    const show = typeof c.show === 'string' && /^[\w:.\-]{1,100}$/.test(c.show) ? c.show : '';
    return { type, id, filename, ...(art ? { art } : {}), ...(show ? { show } : {}) };
}

// Watch time: each viewer whose video is playing reports its position every
// ~4 s (more slowly in a background tab), so the gap between two reports from
// the same viewer is time watched. Gaps over 70 s are dropped, and any
// play/pause or new video bumps room.watchEpoch, which restarts every viewer's
// clock, so pauses never count.
const MAX_WATCH_GAP = 70000;
function countWatchTime(socket, room) {
    const now = Date.now();
    const sameRun = socket.data.watchEpoch === room.watchEpoch;
    const last = sameRun ? socket.data.lastProgressAt : 0;
    socket.data.lastProgressAt = now;
    socket.data.watchEpoch = room.watchEpoch;
    if (!last || now - last > MAX_WATCH_GAP) return;
    const v = room.videoState;
    const source = v.kind === 'yt' ? 'watch_youtube' : v.content ? 'watch_addon' : 'watch_link';
    stats.track(source, Math.round((now - last) / 1000));
}

const MAX_VOICE = 8; // a full mesh gets heavy beyond this on phones

function broadcastVoice(roomId) {
    const room = rooms.get(roomId);
    if (!room) return;
    const members = [...room.voice].map(([id, m]) => ({ id, ...m }));
    io.to(roomId).emit('voice-members', members);
}

function leaveVoice(socket, room, roomId) {
    if (!room || !room.voice.delete(socket.id)) return;
    socket.to(roomId).emit('system-message', {
        message: `${socket.data.username || 'Someone'} left the lounge`, timestamp: Date.now()
    });
    broadcastVoice(roomId);
}

// Which copy of the server this is (a deploy starts a new one), to spot people split across two.
// Why rooms change, kept briefly in memory (no chat, no stream links) so a dead party can be explained.
const roomTrail = new Map(); // code -> [{ t, e }]
function trail(roomId, e) {
    if (!roomId) return;
    const key = String(roomId).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const l = roomTrail.get(key) || [];
    l.push({ t: new Date().toISOString().slice(11, 19), e: String(e).slice(0, 120) });
    if (l.length > 40) l.shift();
    roomTrail.set(key, l);
    if (roomTrail.size > 200) roomTrail.delete(roomTrail.keys().next().value);
}
const INSTANCE = { id: crypto.randomBytes(3).toString('hex'), startedAt: Date.now() };

// Anyone listed in a room whose connection is gone (missed a disconnect) is dropped, so counts never go stale.
function pruneRoom(room) {
    for (const id of [...room.users.keys()]) if (!io.sockets.sockets.get(id)) room.users.delete(id);
}
// One entry per person: the same account and profile on a TV and on a phone is one person, not two.
function peopleOf(room) {
    const out = [], byKey = new Map();
    for (const [id, u] of room.users) {
        const s = io.sockets.sockets.get(id);
        const key = s && s.data.uid ? `${s.data.uid}|${s.data.profile || ''}` : `sid:${id}`;
        const p = byKey.get(key);
        if (p) { p.ids.push(id); p.buffering = p.buffering || !!(s && s.data.buffering); continue; }
        const e = { id, ids: [id], name: u.username, buffering: !!(s && s.data.buffering) };
        byKey.set(key, e); out.push(e);
    }
    return out;
}
const usersOf = peopleOf;
// A browser (phone or computer) versus a TV app, from the device name the app sends.
const isBrowserDevice = d => /^(Chrome|Edge|Firefox|Safari|Opera|Browser)( on .*)?$/.test(String(d || ''));

function broadcastUserCount(roomId) {
    const room = rooms.get(roomId);
    if (!room) return;
    pruneRoom(room);
    const people = peopleOf(room);
    io.to(roomId).emit('user-count', people.length);
    // Names only (for "Who's here"), plus whether their stream is loading.
    io.to(roomId).emit('room-users', people);
}

// Signed-in sockets by account id, for "invite my devices". Memory only.
const devices = new Map();
// A phone changed addons or profiles: every other open screen of that account re-reads them now.
accounts.onVaultChange(uid => {
    for (const id of (devices.get(uid) || [])) { const s = io.sockets.sockets.get(id); if (s) s.emit('vault-changed'); }
});
function forgetDevice(socket) {
    const set = socket.data.uid && devices.get(socket.data.uid);
    if (!set) return;
    set.delete(socket.id);
    if (!set.size) devices.delete(socket.data.uid);
}

// ---- Watch parties: rooms started by inviting your own profiles/devices ----
// The person who invites is the host and the only one who controls playback (play, pause, seek,
// what's on). Subtitle changes are shared; audio stays personal. No limit on size. If the host
// drops out, they get HOST_GRACE_MS to come back before control passes to whoever joined first.
// (No limit on how many people can be in a party.)
const HOST_GRACE_MS = 60000;
// Anyone can be given host rights (more than one person, too). A host key is who someone is, not which
// connection they came in on, so a host who reconnects is still a host.
const hostKeyOf = s => `${s.data.uid || ''}|${s.data.device || ''}|${s.data.profile || s.data.username || ''}`;
const isHostSocket = (socket, room) => !room.party || room.party.host === socket.id || !!(room.party.hostKeys && room.party.hostKeys.has(hostKeyOf(socket)));
function hostIds(room) {
    const out = [];
    if (!room.party) return out;
    for (const id of room.users.keys()) {
        const s = io.sockets.sockets.get(id);
        if (s && isHostSocket(s, room)) out.push(id);
    }
    return out;
}
const partyInfo = room => (room.party ? { host: room.party.host, hosts: hostIds(room), hostName: room.party.hostName, away: !!room.party.away, guestsCanPause: room.party.guestsCanPause === true } : null);
function broadcastParty(roomId) { const room = rooms.get(roomId); if (room) io.to(roomId).emit('party', partyInfo(room)); }
const canControl = (socket, room) => isHostSocket(socket, room);
function denyControl(socket, room) {
    socket.emit('control-denied', { hostName: room.party.hostName, away: !!room.party.away });
    socket.emit('video-sync', stateNow(room)); // put their player back where the room is
}
// The host came back (reconnected, or rejoined from the same device): give control back.
function maybeRestoreHost(socket) {
    const room = socket.data.roomId && rooms.get(socket.data.roomId);
    const p = room && room.party;
    if (!p || !p.away || !socket.data.uid || socket.data.uid !== p.uid || socket.data.device !== p.device) return;
    clearTimeout(p.timer);
    p.host = socket.id;
    p.away = false;
    io.to(socket.data.roomId).emit('system-message', { message: `${p.hostName} is back in control`, timestamp: Date.now() });
    broadcastParty(socket.data.roomId);
}
function startParty(socket, room) {
    if (room.party) return;
    room.party = { guestsCanPause: false, hostKeys: new Set([hostKeyOf(socket)]), host: socket.id, hostName: socket.data.profile || socket.data.username || 'Host', uid: socket.data.uid, device: socket.data.device, away: false, timer: null };
    if (!room.restoredAt || Date.now() - room.restoredAt > 120000) io.to(socket.data.roomId).emit('system-message', { message: `👑 ${room.party.hostName} is hosting. Only they control playback; subtitle changes are shared with everyone.`, timestamp: Date.now() });
    broadcastParty(socket.data.roomId);
}

// `keep`: a dropped connection, not a decision to leave. The room (and its code) stays for ten minutes so a
// TV that blinks off the network comes back to the same party instead of a code that no longer works.
const EMPTY_ROOM_KEEP_MS = 4 * 60 * 60 * 1000; // an invite stays good until the room is closed on purpose
// A deploy stops this server: people aren't leaving, they're about to reconnect to the new one.
let shuttingDown = false;
// A party nobody is using closes by itself, so forgotten rooms don't hold sockets (and keep the server awake).
// Paused for 30 minutes, or nothing started and nobody chatting for 30 minutes: closed. A playing video is left
// alone (a film can run for hours without a message), unless nobody has touched anything for 6 hours.
const PARTY_IDLE_MS = (Number(process.env.PARTY_IDLE_MIN) || 30) * 60 * 1000;
const PARTY_PLAYING_MAX_MS = 6 * 60 * 60 * 1000;
setInterval(() => {
    const now = Date.now();
    for (const [roomId, room] of [...rooms]) {
        if (!room.party || room.users.size === 0) continue;
        const v = room.videoState, quiet = now - Math.max(v.lastUpdate || 0, room.chatAt || 0);
        const loaded = !!(v.videoId || v.src || v.content);
        const idle = v.isPlaying ? quiet > PARTY_PLAYING_MAX_MS
            : loaded ? now - (v.lastUpdate || 0) > PARTY_IDLE_MS : quiet > PARTY_IDLE_MS;
        if (idle) endParty(roomId, room, room.party.hostName, 'closed after being idle');
    }
}, 60000).unref();

process.on('SIGTERM', () => { shuttingDown = true; setTimeout(() => process.exit(0), 1500); });

// What a returning viewer says was playing, checked like a fresh load-video.
function restoreState(r) {
    if (!r || typeof r !== 'object') return null;
    const kind = r.kind === 'direct' ? 'direct' : r.kind === 'yt' ? 'yt' : null;
    if (!kind) return null;
    const src = typeof r.src === 'string' ? r.src : '';
    const videoId = typeof r.videoId === 'string' ? r.videoId.slice(0, 64) : '';
    if (kind === 'direct' && (!/^https?:\/\//i.test(src) || src.length > MAX_STREAM_URL)) return null;
    if (kind === 'yt' && !videoId) return null;
    return {
        videoId: kind === 'yt' ? videoId : '', src: kind === 'direct' ? src : '', kind,
        title: typeof r.title === 'string' ? r.title.slice(0, MAX_TITLE) : '',
        content: kind === 'direct' ? cleanContent(r.content) : null,
        isPlaying: !!r.isPlaying, currentTime: (t => (isFinite(t) && t >= 0 && t < 1e6 ? t : 0))(Number(r.currentTime) || 0), lastUpdate: Date.now()
    };
}

/** Another host takes control. */
function handHost(roomId, room, nextId) {
    const next = room.users.get(nextId);
    const s = io.sockets.sockets.get(nextId);
    if (!next) return;
    if (room.party.hostKeys && s) room.party.hostKeys.add(hostKeyOf(s));
    Object.assign(room.party, { host: nextId, hostName: (s && s.data.profile) || next.username, uid: s && s.data.uid, device: s && s.data.device, away: false });
    io.to(roomId).emit('system-message', { message: `👑 ${room.party.hostName} is now in control`, timestamp: Date.now() });
    broadcastParty(roomId);
}

/** No host is left: everyone is sent home and the room is closed. */
function endParty(roomId, room, hostName, reason) {
    clearTimeout(room.party && room.party.timer);
    trail(roomId, `party ended (${reason || 'host ' + (hostName || '?')})`);
    io.to(roomId).emit('party-ended', { host: hostName || 'The host', reason: reason || undefined });
    for (const id of [...room.users.keys()]) {
        const s = io.sockets.sockets.get(id);
        if (s) { s.leave(roomId); s.data.roomId = null; }
    }
    clearTimeout(room.emptyTimer);
    rooms.delete(roomId);
}

function leaveRoom(socket, keep = false) {
    const { roomId, username } = socket.data;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (socket.data.embed) { if (room) leaveVoice(socket, room, roomId); return; } // the embedded Lounge was never in the list
    if (room) {
        room.users.delete(socket.id);
        if (!room.party && room.videoState.settingsOwner === socket.id && room.users.size) {
            room.videoState.settingsOwner = room.users.keys().next().value;
            io.to(roomId).emit('room-settings-owner', { mediaId: room.videoState.mediaId, settingsOwner: room.videoState.settingsOwner });
        }
        trail(roomId, `${username || '?'} left (${keep ? 'connection dropped' : 'on purpose'}); ${room.users.size} remain`);
        if (process.env.MAIL_MODE === 'log') console.log(`[room ${roomId}] - ${username} (${socket.id}) now ${room.users.size}`);
        room.pollVotes.delete(socket.id);
        leaveVoice(socket, room, roomId);
        if (!shuttingDown) socket.to(roomId).emit('system-message', {
            message: `${username || 'Someone'} left the room 👋`,
            timestamp: Date.now()
        });
        broadcastUserCount(roomId);
        if (room.users.size === 0) {
            if (room.party) clearTimeout(room.party.timer);
            if (keep) {
                clearTimeout(room.emptyTimer);
                room.emptyTimer = setTimeout(() => { if (rooms.get(roomId) === room && room.users.size === 0) rooms.delete(roomId); }, EMPTY_ROOM_KEEP_MS);
            } else { trail(roomId, 'room emptied and closed'); rooms.delete(roomId); }
        }
        else if (room.party && room.party.host === socket.id) {
            const p = room.party;
            const coHost = hostIds(room)[0]; // another host still here takes over at once
            if (coHost) {
                handHost(roomId, room, coHost);
            } else if (!keep) {
                // The last host left on purpose: the party is over for everyone.
                endParty(roomId, room, p.hostName);
            } else {
                // The last host's connection dropped: hold on a moment in case it's a blip, then end it.
                p.host = null;
                p.away = true;
                if (!shuttingDown) io.to(roomId).emit('system-message', { message: `${p.hostName} (host) dropped out. Waiting a few seconds for them…`, timestamp: Date.now() });
                broadcastParty(roomId);
                clearTimeout(p.timer);
                p.timer = setTimeout(() => {
                    const r = rooms.get(roomId);
                    if (!r || !r.party || !r.party.away || !r.users.size) return;
                    // Someone is still here: the party carries on with them in control (the host takes it back when they return).
                    const other = hostIds(r)[0] || [...r.users.keys()].find(id => io.sockets.sockets.get(id));
                    if (other) { trail(roomId, 'host gone; control passed to a guest'); handHost(roomId, r, other); } else endParty(roomId, r, r.party.hostName);
                }, HOST_GRACE_MS);
            }
        }
    }
    socket.leave(roomId);
    socket.data.roomId = null;
}

// ---- Flood limits ----
// Anyone (a script too) can open a socket, so one network address is held to a sensible share: this many open
// connections at once and this many new connections or room joins a minute. Generous, because a whole household or a
// mobile carrier's shared address sits behind one: set MAX_SOCKETS_PER_IP=0 to turn the limits off (load tests).
const MAX_SOCKETS_PER_IP = process.env.MAX_SOCKETS_PER_IP === undefined ? 100 : Number(process.env.MAX_SOCKETS_PER_IP) || 0;
const socketsByIp = new Map(); // ip -> open connections
// The real visitor's address: Cloudflare names it, else the first one in the proxy chain, else the connection itself.
function socketIp(socket) {
    const h = socket.handshake.headers || {};
    const cf = String(h['cf-connecting-ip'] || '').trim();
    if (cf) return cf;
    const fwd = String(h['x-forwarded-for'] || '').split(',')[0].trim();
    return fwd || socket.handshake.address || 'unknown';
}
io.use((socket, next) => {
    if (!MAX_SOCKETS_PER_IP) return next();
    const ip = socketIp(socket);
    if ((socketsByIp.get(ip) || 0) >= MAX_SOCKETS_PER_IP || !allowHit(`conn:${ip}`, MAX_SOCKETS_PER_IP * 2, 60000)) return next(new Error('busy'));
    socketsByIp.set(ip, (socketsByIp.get(ip) || 0) + 1);
    socket.data.ip = ip;
    // The transport closing is the one signal that always comes (even if the socket never finished connecting).
    socket.conn.once('close', () => {
        const n = (socketsByIp.get(ip) || 1) - 1;
        if (n > 0) socketsByIp.set(ip, n); else socketsByIp.delete(ip);
    });
    next();
});

io.on('connection', (socket) => {
    // A malformed event from a client (a null or non-object payload, say) must never crash the server.
    // 1) payloads that aren't plain objects become {}; 2) any handler error is contained.
    socket.use((packet, next) => {
        const arg = packet[1];
        if (arg !== undefined && (arg === null || typeof arg !== 'object' || Array.isArray(arg))) packet[1] = {};
        next();
    });
    const addHandler = socket.on.bind(socket);
    socket.on = (event, handler) => addHandler(event, (...args) => {
        try { return handler(...args); } catch (e) { console.warn(`socket handler "${event}" failed:`, e.message); }
    });

    stats.observeOnline(io.engine.clientsCount);
    registerRoomCodes(socket, roomCodes, rooms);
    socket.on('join-room', async ({ roomId, username, restore, requireExisting, resumeId } = {}) => {
        if (typeof roomId !== 'string' || !roomId || roomId.length > MAX_ROOM_ID) return;
        username = (typeof username === 'string' ? username : '').slice(0, MAX_USERNAME).trim() || 'Guest';
        socket.data.resumeId = typeof resumeId === 'string' && /^[a-f0-9]{32}$/.test(resumeId) ? resumeId : null;
        // Room joins a minute from one address (a reconnect loop or a script making rooms), well above any real use.
        if (MAX_SOCKETS_PER_IP && !allowHit(`join:${socket.data.ip || socket.id}`, 90, 60000)) {
            socket.emit('system-message', { message: 'Too many room joins from this connection. Wait a minute and try again.', timestamp: Date.now() });
            return;
        }

        if (socket.data.helloP) await socket.data.helloP;
        if (requireExisting && !rooms.has(roomId)) { socket.emit('join-denied', { reason: 'none' }); return; }
        // A party (or any room a signed-in person is in) takes only signed-in people with a profile name.
        const present = rooms.get(roomId);
        const gated = present && present.users.size && (present.party || [...present.users.keys()].some(id => {
            const m = io.sockets.sockets.get(id);
            return m && m.data.uid && id !== socket.id;
        }));
        if (gated && !(socket.data.uid && socket.data.profile)) {
            socket.emit('join-denied', { reason: socket.data.uid ? 'profile' : 'signin' });
            return;
        }

        const existingRoom = rooms.get(roomId);
        // One profile is one person. A second phone or computer using the same profile is refused (two people were seeing each
        // other's name in chat). The same profile on a TV and on a phone is the same person on two screens, and is allowed.
        if (!socket.data.embed && existingRoom && socket.data.uid && socket.data.profile) {
            const mineBrowser = isBrowserDevice(socket.data.device);
            for (const id of existingRoom.users.keys()) {
                if (id === socket.id) continue;
                const o = io.sockets.sockets.get(id);
                if (o && o.data.uid === socket.data.uid && (o.data.profile || '') === socket.data.profile && isBrowserDevice(o.data.device) === mineBrowser) {
                    socket.emit('join-denied', { reason: 'busy', name: socket.data.profile });
                    return;
                }
            }
        }
        if (socket.data.embed) {
            // The embedded Lounge only listens and talks in a room that is already live; it is not a person in the list.
            if (!existingRoom) { socket.emit('join-denied', { reason: 'none' }); return; }
            socket.data.roomId = roomId;
            socket.data.username = username;
            socket.join(roomId);
            socket.emit('joined', { roomId, code: roomCodes.assign(roomId) });
            socket.emit('user-count', peopleOf(existingRoom).length);
            socket.emit('room-users', peopleOf(existingRoom));
            if (existingRoom.voice.size) socket.emit('voice-members', [...existingRoom.voice].map(([id, m]) => ({ id, ...m })));
            if (existingRoom.pin) socket.emit('lounge-pin', existingRoom.pin);
            if (existingRoom.locked) socket.emit('lounge-state', { locked: true });
            if (existingRoom.party) socket.emit('party', partyInfo(existingRoom));
            return;
        }
        if (existingRoom && existingRoom.locked && !existingRoom.users.has(socket.id)) { socket.emit('join-denied', { reason: 'locked' }); return; }
        // After a server restart (a deploy) every room is gone. The first person back rebuilds it as it was: what's
        // on and where it had got to. Only a room that doesn't exist yet takes this, so nobody can rewrite a live one.
        const rebuilt = !existingRoom && restoreState(restore);
        // Joining the room you're already in (a reconnect check, the app re-announcing itself) leaves nothing: leaving
        // first would see "no host left" and end the party. Only a different room is left behind.
        const sameRoom = socket.data.roomId === roomId && !!existingRoom;
        if (socket.data.roomId && !sameRoom) { trail(socket.data.roomId, `${socket.data.username || '?'} moved to room ${String(roomId).slice(0, 8)}`); leaveRoom(socket); } // leave any previous room first

        if (!rooms.has(roomId)) stats.track('rooms');
        stats.track('joins');
        const room = getRoom(roomId);
        if (rebuilt) { room.videoState = { ...rebuilt, mediaId: crypto.randomBytes(12).toString('hex'), settingsOwner: socket.id }; room.restoredAt = Date.now(); }
        if (rebuilt) room.settingsOwnerResume = socket.data.resumeId;
        if (socket.data.resumeId && room.settingsOwnerResume === socket.data.resumeId) {
            room.videoState.settingsOwner = socket.id;
            io.to(roomId).emit('room-settings-owner', { mediaId: room.videoState.mediaId, settingsOwner: socket.id });
        }
        if (room.emptyTimer) { clearTimeout(room.emptyTimer); room.emptyTimer = null; }
        socket.data.roomId = roomId;
        socket.data.username = username;
        socket.join(roomId);
        room.users.set(socket.id, { username });
        if (process.env.MAIL_MODE === 'log') console.log(`[room ${roomId}] + ${username} (${socket.id}) now ${room.users.size}`);

        // A signed-in person's room (their TV, say) becomes a host-only party the moment someone else walks in,
        // so a guest with the code can never pause or seek it for them.
        if (restore && restore.host && socket.data.uid && room.restoredAt && Date.now() - room.restoredAt < 120000) room.restoredHost = hostKeyOf(socket);
        if (!room.party && peopleOf(room).length >= 2) {
            const others = [...room.users.keys()].map(id => io.sockets.sockets.get(id)).filter(s => s && s.data.uid);
            const host = others.find(s => room.restoredHost && hostKeyOf(s) === room.restoredHost) || others.find(s => s.id !== socket.id);
            if (host) startParty(host, room);
        } else if (room.party && room.restoredHost === hostKeyOf(socket) && room.party.host !== socket.id && Date.now() - room.restoredAt < 120000) {
            // The host came back after a restart and someone else got there first: control goes back to them.
            if (room.party.hostKeys) room.party.hostKeys.add(hostKeyOf(socket));
            Object.assign(room.party, { host: socket.id, hostName: socket.data.profile || username, uid: socket.data.uid, device: socket.data.device, away: false });
            broadcastParty(roomId);
        }

        trail(roomId, `${username} joined${sameRoom ? ' again' : ''}; ${room.users.size} here`);
        if (!sameRoom && (!room.restoredAt || Date.now() - room.restoredAt > 120000)) socket.to(roomId).emit('system-message', {
            message: `${username} joined the room 💫`,
            timestamp: Date.now()
        });

        // Bring the newcomer up to speed with the current video state.
        if (room.videoState.videoId || room.videoState.src) socket.emit('video-sync', stateNow(room));
        if (room.subtitles) socket.emit('subtitles-updated', room.subtitles);
        if (room.audio) socket.emit('audio-updated', room.audio);
        if (room.addons) socket.emit('addons-updated', { addons: room.addons, user: null });
        if (room.voice.size) socket.emit('voice-members', [...room.voice].map(([id, m]) => ({ id, ...m })));
        broadcastUserCount(roomId);
        socket.emit('joined', { roomId, code: roomCodes.assign(roomId) });
        if (room.pin) socket.emit('lounge-pin', room.pin);
        if (room.locked) socket.emit('lounge-state', { locked: true });
        if (room.party) socket.emit('party', partyInfo(room));
        maybeRestoreHost(socket);
    });

    // Leaving on purpose (the TV's "Leave room"), without closing the connection.
    socket.on('leave-room', () => { const r = socket.data.roomId; trail(r, `${socket.data.username || '?'} pressed leave`); if (process.env.MAIL_MODE === 'log') console.log(`[room ${r}] leave-room event from ${socket.id}`); leaveRoom(socket); if (r) socket.leave(r); socket.data.roomId = null; });

    // ---- Chat relay (never stored or logged) ----
    // A message is { t: 'text', v } or { t: 'img', v } where v is an https link or an image data URL.
    const IMG_OK = /^(https:\/\/\S+|data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+)$/;
    socket.on('send-message', (msg = {}, ack) => {
        const done = ok => { if (typeof ack === 'function') ack({ ok }); };
        const roomId = socket.data.roomId;
        if (!roomId) return done(false); // not back in the room yet: the sender keeps it and tries again
        if (typeof msg.v !== 'string') return done(true);
        { const rm = rooms.get(roomId); if (rm) rm.chatAt = Date.now(); }
        if (msg.t === 'text') { if (!msg.v.trim() || msg.v.length > MAX_TEXT) return; }
        else if (msg.t === 'img') { if (msg.v.length > MAX_IMAGE || !IMG_OK.test(msg.v)) return; }
        else return;
        stats.track('messages');
        done(true);
        socket.to(roomId).emit('new-message', {
            t: msg.t,
            v: msg.v,
            username: socket.data.username,
            timestamp: Date.now(),
            id: socket.id,
            mid: typeof msg.mid === 'string' ? msg.mid.slice(0, 24) : undefined,
            reply: msg.reply && typeof msg.reply === 'object' && typeof msg.reply.name === 'string'
                ? { mid: String(msg.reply.mid || '').slice(0, 24), name: msg.reply.name.slice(0, 40), text: String(msg.reply.text || '').slice(0, 120) } : undefined
        });
    });

    // ---- Lounge extras: seen, reactions, one pinned message, host tools. Relayed only; nothing is stored beyond the pin. ----
    const LOUNGE_EMOJI = new Set(['👍', '❤️', '😂', '😮', '🔥', '🎉']);
    const LOUNGE_BURST = new Set(['👍', '❤️', '😂', '😮', '🔥', '🎉', '👏', '😢', '🤯', '🍿', '💀', '😍']);
    socket.on('lounge', (d = {}) => {
        const roomId = socket.data.roomId;
        const room = roomId && rooms.get(roomId);
        if (!room || !d || typeof d.k !== 'string') return;
        const by = socket.data.username || 'Someone';
        const mid = typeof d.mid === 'string' ? d.mid.slice(0, 24) : '';
        switch (d.k) {
            case 'seen': if (mid) socket.to(roomId).emit('lounge', { k: 'seen', mid, by, id: socket.id }); break;
            case 'react': if (mid && LOUNGE_EMOJI.has(d.e)) io.to(roomId).emit('lounge', { k: 'react', mid, e: d.e, by, id: socket.id }); break;
            case 'burst': if (LOUNGE_BURST.has(d.e)) io.to(roomId).emit('lounge', { k: 'burst', e: d.e, by, id: socket.id }); break;
            case 'pin':
                if (!mid) break;
                room.pin = { mid, name: String(d.name || '').slice(0, 40), text: String(d.text || '').slice(0, 200), img: d.img === true, by };
                io.to(roomId).emit('lounge-pin', room.pin);
                break;
            case 'unpin': room.pin = null; io.to(roomId).emit('lounge-pin', null); break;
            case 'lock':
                if (!isHostSocket(socket, room)) break;
                room.locked = !!d.on;
                io.to(roomId).emit('lounge-state', { locked: room.locked });
                io.to(roomId).emit('system-message', { message: room.locked ? `🔒 ${by} locked the room` : `🔓 ${by} unlocked the room`, timestamp: Date.now() });
                break;
            case 'mute-all':
                if (!isHostSocket(socket, room)) break;
                socket.to(roomId).emit('lounge', { k: 'mute-all', by });
                io.to(roomId).emit('system-message', { message: `🔇 ${by} muted everyone`, timestamp: Date.now() });
                break;
        }
    });

    // The page is closing: out of the room now (as a dropped connection, so a host gets the usual grace).
    socket.on('bye', () => {
        trail(socket.data.roomId, `${socket.data.username || '?'} closed the page`);
        leaveRoom(socket, true);
        socket.disconnect(true);
    });

    // A page saying what state it is in (visible, hidden, frozen, offline): only ever shown in the room trail.
    socket.on('diag', (d = {}) => {
        const why = String(d.why || '').slice(0, 40), st = String(d.state || '').slice(0, 20);
        trail(socket.data.roomId, `${socket.data.username || '?'} page: ${why}${st ? ' (' + st + ')' : ''}`);
    });

    // ---- Typing indicators ----
    socket.on('typing-start', () => {
        const roomId = socket.data.roomId;
        if (roomId) socket.to(roomId).emit('user-typing', { username: socket.data.username, isTyping: true });
    });
    socket.on('typing-stop', () => {
        const roomId = socket.data.roomId;
        if (roomId) socket.to(roomId).emit('user-typing', { username: socket.data.username, isTyping: false });
    });

    // ---- Video sync ----
    socket.on('load-video', (videoData = {}) => {
        const roomId = socket.data.roomId;
        if (!roomId) return;
        if (!canControl(socket, getRoom(roomId))) return denyControl(socket, getRoom(roomId)); // watch party: host only
        const kind = videoData.kind === 'direct' ? 'direct' : 'yt';
        const src = typeof videoData.src === 'string' ? videoData.src : '';
        if (kind === 'direct' && (!/^https?:\/\//i.test(src) || src.length > MAX_STREAM_URL)) return;
        const title = typeof videoData.title === 'string' ? videoData.title.slice(0, MAX_TITLE) : '';
        const room = getRoom(roomId);
        room.videoState = {
            mediaId: crypto.randomBytes(12).toString('hex'),
            settingsOwner: socket.id,
            videoId: kind === 'yt' ? String(videoData.videoId || '') : '',
            src: kind === 'direct' ? src : '',
            kind,
            title,
            content: kind === 'direct' ? cleanContent(videoData.content) : null,
            isPlaying: false,
            currentTime: 0,
            lastUpdate: Date.now()
        };
        room.subtitles = null;
        room.audio = null;
        room.audioRevision = 0;
        room.settingsOwnerResume = socket.data.resumeId;
        room.subtitleRevision = 0;
        // Which kind of video was started (counts only — never the title or link).
        stats.track(kind === 'yt' ? 'video_youtube' : room.videoState.content ? 'video_addon' : 'video_link');
        room.watchEpoch++;
        io.to(roomId).emit('video-loaded', { ...room.videoState, serverTime: room.videoState.lastUpdate, user: socket.data.username });
    });

    socket.on('set-subtitles', (payload = {}, ack) => {
        const reply = data => { if (typeof ack === 'function') ack(data); };
        const room = rooms.get(socket.data.roomId);
        if (!room || !room.videoState.mediaId || payload.mediaId !== room.videoState.mediaId) return reply({ ok: false, message: 'The video changed. Pick the subtitle again.' });
        if (!(room.party ? isHostSocket(socket, room) : room.videoState.settingsOwner === socket.id)) return reply({ ok: true, personal: true });
        const s = payload.state;
        if (!s || (s.vtt !== null && typeof s.vtt !== 'string') || (s.vtt && Buffer.byteLength(s.vtt) > MAX_SUBTITLE_BYTES)) return reply({ ok: false, message: 'Subtitle file too large (max 5 MB).' });
        const state = { vtt: s.vtt, key: String(s.key || '').slice(0, MAX_STREAM_URL), embeddedLang: String(s.embeddedLang || '').slice(0, 40), lang: String(s.lang || 'off').slice(0, 40), label: String(s.label || '').slice(0, MAX_TITLE), offset: Number.isFinite(s.offset) ? Math.max(-600, Math.min(600, s.offset)) : 0 };
        room.subtitles = { mediaId: payload.mediaId, state, revision: ++room.subtitleRevision, sender: socket.id };
        io.to(socket.data.roomId).emit('subtitles-updated', room.subtitles);
        reply({ ok: true });
    });

    socket.on('set-audio', (payload = {}, ack) => {
        const reply = data => { if (typeof ack === 'function') ack(data); };
        const room = rooms.get(socket.data.roomId);
        if (!room || payload.mediaId !== room.videoState.mediaId) return reply({ ok: false });
        if (!(room.party ? isHostSocket(socket, room) : room.videoState.settingsOwner === socket.id)) return reply({ ok: true, personal: true });
        const s = payload.state;
        if (!s || typeof s.language !== 'string' || s.language.length > 40 || !Number.isInteger(s.index) || s.index < 0 || s.index > 200) return reply({ ok: false });
        room.audio = { mediaId: payload.mediaId, revision: ++room.audioRevision, state: { language: s.language, label: String(s.label || '').slice(0, MAX_TITLE), index: s.index } };
        io.to(socket.data.roomId).emit('audio-updated', room.audio);
        reply({ ok: true });
    });

    // ---- Room addons (shared list of manifest URLs; memory only, never logged) ----
    socket.on('set-addons', (payload = {}) => {
        const roomId = socket.data.roomId;
        const list = payload.addons;
        if (!roomId || !Array.isArray(list) || list.length > MAX_ADDONS) return;
        if (!list.every(u => typeof u === 'string' && u.length <= MAX_ADDON_URL && /^https?:\/\//i.test(u))) return;
        stats.track('addons_updated');
        const room = getRoom(roomId);
        room.addons = list.slice();
        socket.to(roomId).emit('addons-updated', { addons: room.addons, user: socket.data.username });
    });

    // The room keeps one "anchor": where the video was at a moment in server time and whether it's
    // playing. Only play/pause/seek move it. Each viewer steers their own player toward it, so a slow
    // connection only makes that one viewer catch up, never drags everyone else back.
    const cleanTime = t => (typeof t === 'number' && isFinite(t) && t >= 0 && t < 1e6 ? t : 0);

    // The host chooses whether guests can pause and play for everyone (seeking and picking stay with the host).
    socket.on('party-setting', (d = {}) => {
        const roomId = socket.data.roomId;
        const room = roomId && rooms.get(roomId);
        if (!room || !room.party || !isHostSocket(socket, room) || typeof d.guestsCanPause !== 'boolean') return;
        room.party.guestsCanPause = d.guestsCanPause;
        io.to(roomId).emit('system-message', { message: d.guestsCanPause ? `${socket.data.profile || socket.data.username || 'A host'} lets everyone pause and play` : `Only hosts can pause and play now`, timestamp: Date.now() });
        broadcastParty(roomId);
    });

    socket.on('video-playpause', (data = {}) => {
        const roomId = socket.data.roomId;
        if (!roomId) return;
        const rm = getRoom(roomId);
        if (!canControl(socket, rm) && !(rm.party && rm.party.guestsCanPause === true)) return denyControl(socket, rm); // locked: put them back
        const room = getRoom(roomId);
        const isPlaying = !!data.isPlaying;
        const currentTime = cleanTime(data.currentTime);
        const now = stateNow(room);
        // A player repeating what the room already does isn't news (stops echo loops).
        if (now.isPlaying === isPlaying && Math.abs(now.currentTime - currentTime) < 2) return;
        room.videoState.isPlaying = isPlaying;
        room.videoState.currentTime = currentTime;
        room.videoState.lastUpdate = Date.now();
        room.watchEpoch++; // pauses (and resumes) never count as watch time
        socket.to(roomId).emit('video-playpause-sync', {
            isPlaying, currentTime, serverTime: room.videoState.lastUpdate,
            user: socket.data.username
        });
        io.to(roomId).emit('system-message', {
            message: `${socket.data.username} ${isPlaying ? 'played ▶️' : 'paused ⏸️'} the video`,
            timestamp: Date.now()
        });
    });

    // Progress reports only count watch time; they never move anyone's player.
    socket.on('video-progress', () => {
        const roomId = socket.data.roomId;
        if (!roomId) return;
        countWatchTime(socket, getRoom(roomId));
    });

    socket.on('video-seek', (data = {}) => {
        const roomId = socket.data.roomId;
        if (!roomId) return;
        if (!canControl(socket, getRoom(roomId))) return; // watch party: a guest's own pause/seek stays on their screen
        const room = getRoom(roomId);
        const currentTime = cleanTime(data.currentTime);
        if (Math.abs(stateNow(room).currentTime - currentTime) < 1) return;
        room.videoState.currentTime = currentTime;
        room.videoState.lastUpdate = Date.now();
        room.watchEpoch++;
        socket.to(roomId).emit('video-seek', { currentTime, serverTime: room.videoState.lastUpdate, user: socket.data.username });
    });

    // "Sync everyone": the asker's position becomes the room's.
    socket.on('sync-request', (data = {}) => {
        const roomId = socket.data.roomId;
        if (!roomId) return;
        if (!canControl(socket, getRoom(roomId))) return; // watch party: a guest's own pause/seek stays on their screen
        const room = getRoom(roomId);
        if (typeof data.currentTime === 'number') {
            room.videoState.currentTime = cleanTime(data.currentTime);
            room.videoState.isPlaying = !!data.isPlaying;
            room.videoState.lastUpdate = Date.now();
        }
        const now = stateNow(room);
        io.to(roomId).emit('video-sync', { ...now, force: true }); // "sync everyone": guests who wandered off come back too
        const t = Math.floor(now.currentTime);
        const clock = `${Math.floor(t / 3600) ? Math.floor(t / 3600) + ':' : ''}${String(Math.floor(t / 60) % 60).padStart(Math.floor(t / 3600) ? 2 : 1, '0')}:${String(t % 60).padStart(2, '0')}`;
        io.to(roomId).emit('system-message', { message: `🔄 ${socket.data.username} synced everyone to ${clock}`, timestamp: Date.now() });
    });

    // Someone's stream is buffering: tell the others, so a stall has a name instead of a mystery.
    socket.on('buffering', (data = {}) => {
        const roomId = socket.data.roomId;
        if (!roomId) return;
        const on = !!data.on;
        if (socket.data.buffering === on) return;
        socket.data.buffering = on;
        socket.to(roomId).emit('peer-buffering', { id: socket.id, user: socket.data.username, on });
        broadcastUserCount(roomId);
    });

    // ---- Your own devices (same account): see which are open, and invite them to this room ----
    socket.on('hello', (data = {}) => {
        // join-room waits for this, so a client that says hello and joins straight away is still known.
        socket.data.helloP = (async () => {
            const who = await accounts.sessionInfo(data.token).catch(() => null);
            if (!who) return;
            forgetDevice(socket);
            socket.data.uid = who.uid;
            socket.data.device = String(data.device || who.device || 'Device').slice(0, 40);
            socket.data.profile = typeof data.profile === 'string' ? data.profile.slice(0, 40) : '';
            // The Lounge shown inside the browser app is the same person's second connection: it is not a device
            // to invite, never counts as another person, and never takes the host's place.
            socket.data.embed = data.embed === true;
            if (socket.data.embed) return;
            if (!devices.has(who.uid)) devices.set(who.uid, new Set());
            devices.get(who.uid).add(socket.id);
            maybeRestoreHost(socket);
        })().catch(() => {});
    });
    socket.on('my-devices', (_data, ack) => {
        if (typeof ack !== 'function') return;
        const mine = socket.data.uid ? [...(devices.get(socket.data.uid) || [])] : [];
        ack(mine.filter(id => id !== socket.id).map(id => io.sockets.sockets.get(id)).filter(Boolean).map(s => ({
            id: s.id, device: s.data.device, profile: s.data.profile, inRoom: !!s.data.roomId && s.data.roomId !== socket.data.roomId
        })));
    });
    socket.on('invite-device', (data = {}) => {
        const roomId = socket.data.roomId;
        const target = typeof data.to === 'string' && io.sockets.sockets.get(data.to);
        if (!roomId || !target || !socket.data.uid || target.data.uid !== socket.data.uid) return; // only your own devices
        sendInvites(socket, [target]);
    });
    // Invite every other device signed in to your account (all your profiles).
    socket.on('invite-all', () => {
        const roomId = socket.data.roomId;
        if (!roomId || !socket.data.uid) return;
        const targets = [...(devices.get(socket.data.uid) || [])].filter(id => id !== socket.id)
            .map(id => io.sockets.sockets.get(id)).filter(s => s && s.data.roomId !== roomId);
        if (!targets.length) { socket.emit('system-message', { message: 'None of your other devices are open right now.', timestamp: Date.now() }); return; }
        sendInvites(socket, targets);
    });
    function sendInvites(socket, targets) {
        const roomId = socket.data.roomId;
        const room = getRoom(roomId);
        if (room.party && !canControl(socket, room)) { socket.emit('system-message', { message: `Only ${room.party.hostName} can invite people to this watch party.`, timestamp: Date.now() }); return; }
        startParty(socket, room);
        const from = socket.data.profile || socket.data.username || socket.data.device;
        targets.forEach(t => t.emit('device-invite', {
            roomId, from, device: socket.data.device, title: room.videoState.title || '',
            art: (room.videoState.content && room.videoState.content.art) || ''
        }));
        socket.emit('system-message', { message: `Invite sent to ${targets.map(t => t.data.profile || t.data.device).join(', ')}`, timestamp: Date.now() });
    }
    // The host removes someone from the watch party.
    socket.on('kick-user', (data = {}) => {
        const roomId = socket.data.roomId;
        const room = roomId && rooms.get(roomId);
        const target = typeof data.to === 'string' && io.sockets.sockets.get(data.to);
        if (!room || !room.party || !isHostSocket(socket, room) || !target || target.id === socket.id || target.data.roomId !== roomId) return;
        if (room.party.host === target.id && room.party.host !== socket.id) return; // the main host can't be removed by a co-host
        const who = target.data.username || target.data.profile || 'Someone';
        target.emit('kicked', { by: socket.data.profile || socket.data.username || 'The host' });
        const tkey = target.data.uid ? `${target.data.uid}|${target.data.profile || ''}` : null;
        const mates = tkey ? [...room.users.keys()].map(id => io.sockets.sockets.get(id)).filter(x => x && x.id !== target.id && `${x.data.uid}|${x.data.profile || ''}` === tkey) : [];
        for (const t of [target, ...mates]) { if (t !== target) t.emit('kicked', { by: socket.data.profile || socket.data.username || 'The host' }); leaveRoom(t); t.leave(roomId); t.data.roomId = null; }
        io.to(roomId).emit('system-message', { message: `${who} was removed from the party`, timestamp: Date.now() });
    });
    // Give someone host rights (or take them away). Hosts can pause, seek, change the video and remove people.
    socket.on('set-host', (d = {}) => {
        const roomId = socket.data.roomId;
        const room = roomId && rooms.get(roomId);
        const target = typeof d.to === 'string' && io.sockets.sockets.get(d.to);
        if (!room || !room.party || !isHostSocket(socket, room) || !target || target.data.roomId !== roomId || typeof d.on !== 'boolean') return;
        if (!target.data.uid) return; // only signed-in people can host
        if (!room.party.hostKeys) room.party.hostKeys = new Set();
        const key = hostKeyOf(target);
        const who = target.data.profile || target.data.username || 'Someone';
        if (d.on) {
            room.party.hostKeys.add(key);
            io.to(roomId).emit('system-message', { message: `👑 ${who} is now a host`, timestamp: Date.now() });
        } else {
            if (room.party.host === target.id) return; // the main host stays a host
            room.party.hostKeys.delete(key);
            io.to(roomId).emit('system-message', { message: `${who} is no longer a host`, timestamp: Date.now() });
        }
        broadcastParty(roomId);
    });
    socket.on('invite-answer', (data = {}) => {
        if (typeof data.roomId !== 'string' || !rooms.has(data.roomId) || data.accept) return; // joining announces itself
        io.to(data.roomId).emit('system-message', { message: `${socket.data.profile || socket.data.device || 'Someone'} said “not now”`, timestamp: Date.now() });
    });

    // Typing a room code: is there a party with that code right now?
    socket.on('room-exists', (data = {}, ack) => {
        if (typeof ack !== 'function') return;
        const id = typeof data.roomId === 'string' ? data.roomId.slice(0, 128) : '';
        const r = id && rooms.get(id);
        ack(!!r); // a room that's only between reconnects still counts
    });

    // "Am I still in my room?" A client asks now and then and rejoins if the answer is no.
    // Self-heal: who the server has in our room, so a stale list on the screen is put right.
    socket.on('room-check', (_d, ack) => {
        if (typeof ack !== 'function') return;
        const room = socket.data.roomId && rooms.get(socket.data.roomId);
        if (room) pruneRoom(room);
        ack({ roomId: socket.data.roomId || null, instance: INSTANCE.id, users: room ? peopleOf(room).map(p => p.id) : [] });
    });
    socket.on('room-users-refresh', () => {
        const room = socket.data.roomId && rooms.get(socket.data.roomId);
        if (!room) return;
        socket.emit('user-count', peopleOf(room).length);
        socket.emit('room-users', peopleOf(room));
        if (room.party) socket.emit('party', partyInfo(room));
    });

    // Clock check, so everyone agrees on "now" (the anchor is in server time).
    socket.on('time', (_data, ack) => { if (typeof ack === 'function') ack(Date.now()); });

    // (Quick polls were removed: an older open page may still send these events; they are ignored.)
    socket.on('start-poll', () => {});
    socket.on('poll-vote', () => {});
    socket.on('poll-end', () => {});

    // ---- Voice room (Discord-style: join/leave any time, up to MAX_VOICE) ----
    // Media is peer-to-peer and encrypted in transit by WebRTC; the server relays only
    // connection setup between members of the same voice room.
    socket.on('voice-join', () => {
        const roomId = socket.data.roomId;
        if (!roomId) return;
        const room = getRoom(roomId);
        if (room.voice.has(socket.id)) return;
        if (room.voice.size >= MAX_VOICE) { socket.emit('voice-full', { max: MAX_VOICE }); return; }
        const peers = [...room.voice.keys()];
        room.voice.set(socket.id, { username: socket.data.username, muted: false, cam: false });
        socket.emit('voice-joined', { peers });
        socket.to(roomId).emit('system-message', {
            message: `${socket.data.username} joined the lounge 🎧`, timestamp: Date.now()
        });
        broadcastVoice(roomId);
    });
    socket.on('voice-leave', () => {
        const roomId = socket.data.roomId;
        if (roomId) leaveVoice(socket, rooms.get(roomId), roomId);
    });
    socket.on('voice-state', (data = {}) => {
        const roomId = socket.data.roomId;
        const member = roomId && rooms.get(roomId)?.voice.get(socket.id);
        if (!member) return;
        member.muted = !!data.muted;
        member.cam = !!data.cam;
        broadcastVoice(roomId);
    });
    socket.on('voice-signal', (data = {}) => {
        const roomId = socket.data.roomId;
        const room = roomId && rooms.get(roomId);
        if (!room || typeof data.to !== 'string') return;
        if (!room.voice.has(socket.id) || !room.voice.has(data.to)) return;
        io.to(data.to).emit('voice-signal', { from: socket.id, signal: data.signal });
    });

    socket.on('disconnect', (reason) => {
        trail(socket.data.roomId, `${socket.data.username || '?'} socket closed: ${reason}`);
        if (process.env.MAIL_MODE === 'log') console.log(`[room ${socket.data.roomId}] disconnect ${socket.id}: ${reason}`);
        leaveRoom(socket, true);
        forgetDevice(socket);
        stats.observeOnline(io.engine.clientsCount);
    });
});

const PORT = process.env.PORT || 3000;
// Anything else: a friendly page for people, a short JSON answer for programs.
app.use((req, res) => {
    const program = /^\/(api|catalog|socket\.io)\//.test(req.path) || req.accepts(['html', 'json']) !== 'html';
    if (req.method === 'GET' && !program) return res.status(404).sendFile(sitePage('404.html'));
    res.status(404).json({ error: 'Not found' });
});

server.listen(PORT, () => {
    console.log(`🚀 Reddate server running on http://localhost:${PORT}`);
});
