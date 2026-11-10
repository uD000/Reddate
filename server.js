// Reddate / virtual-date platform — room-based sync server.
//
// Privacy model: chat is end-to-end encrypted in the browser. Each room has a
// symmetric key that lives only in the client URL fragment (#...), which is
// never sent to the server. This process only relays opaque ciphertext and
// never sees message plaintext. Nothing is persisted: rooms live in memory and
// are discarded once empty, and chat history is never stored.

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

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] }
});

// Render (and most hosts) put one proxy in front; trust it so req.ip is the
// real client for per-IP rate limits.
app.set('trust proxy', 1);
app.use(express.static('public'));
require('./media-audio').registerMediaAudio(app);

// ---- Anonymous usage stats (stats.js) ----
// The page pings once per load (Render's health checks would inflate a
// server-side count), plus a few feature events the server can't see —
// GIFs travel inside encrypted chat, Browse and calls are client-side.
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
app.get('/stats', requireStatsPassword, (_req, res) => {
    res.set('Cache-Control', 'no-store').sendFile(path.join(__dirname, 'views', 'stats.html'));
});
app.get('/api/stats', requireStatsPassword, async (req, res) => {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
    try {
        res.set('Cache-Control', 'no-store').json(await stats.report(days));
    } catch (e) {
        res.status(502).json({ error: e.message });
    }
});

// WebRTC ICE configuration. Media is peer-to-peer and E2E encrypted; a TURN
// relay only forwards already-encrypted packets. Configure TURN via env for
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
// Note: GIF searches go to GIPHY and are not end-to-end encrypted.
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

const MAX_ROOM_ID = 128;
const MAX_USERNAME = 40;
const MAX_ADDONS_CIPHER = 32 * 1024; // encrypted addon list blob
const MAX_STREAM_URL = 4096;
const MAX_TITLE = 200;

function getRoom(roomId) {
    let room = rooms.get(roomId);
    if (!room) {
        room = {
            videoState: { videoId: '', isPlaying: false, currentTime: 0, lastUpdate: Date.now() },
            users: new Map(),
            poll: null,
            pollVotes: new Map(),
            // Room's Stremio-addon list, E2E encrypted with the room key
            // ({ iv, ciphertext }). Addon URLs carry auth tokens, so the
            // server stores and relays an opaque blob it cannot read.
            addons: null,
            watchEpoch: 0,
            // Voice room: socket id -> { username, muted, cam }. Audio/video go
            // peer-to-peer (WebRTC mesh); the server only relays signaling.
            voice: new Map()
        };
        rooms.set(roomId, room);
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
    return { type, id, filename };
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

function broadcastUserCount(roomId) {
    const room = rooms.get(roomId);
    if (room) io.to(roomId).emit('user-count', room.users.size);
}

function leaveRoom(socket) {
    const { roomId, username } = socket.data;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (room) {
        room.users.delete(socket.id);
        room.pollVotes.delete(socket.id);
        leaveVoice(socket, room, roomId);
        socket.to(roomId).emit('system-message', {
            message: `${username || 'Someone'} left the room 👋`,
            timestamp: Date.now()
        });
        broadcastUserCount(roomId);
        if (room.users.size === 0) rooms.delete(roomId);
    }
    socket.leave(roomId);
    socket.data.roomId = null;
}

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
    socket.on('join-room', ({ roomId, username } = {}) => {
        if (typeof roomId !== 'string' || !roomId || roomId.length > MAX_ROOM_ID) return;
        username = (typeof username === 'string' ? username : '').slice(0, MAX_USERNAME).trim() || 'Guest';

        if (socket.data.roomId) leaveRoom(socket); // leave any previous room first

        if (!rooms.has(roomId)) stats.track('rooms');
        stats.track('joins');
        const room = getRoom(roomId);
        socket.data.roomId = roomId;
        socket.data.username = username;
        socket.join(roomId);
        room.users.set(socket.id, { username });

        socket.to(roomId).emit('system-message', {
            message: `${username} joined the room 💫`,
            timestamp: Date.now()
        });

        // Bring the newcomer up to speed with the current video state.
        if (room.videoState.videoId || room.videoState.src) socket.emit('video-sync', room.videoState);
        if (room.addons) socket.emit('addons-updated', { ...room.addons, user: null });
        if (room.voice.size) socket.emit('voice-members', [...room.voice].map(([id, m]) => ({ id, ...m })));
        broadcastUserCount(roomId);
        socket.emit('joined', { roomId });
    });

    // ---- Encrypted chat relay (server never sees plaintext) ----
    socket.on('send-message', (payload = {}) => {
        const roomId = socket.data.roomId;
        if (!roomId || !payload.ciphertext || !payload.iv) return;
        stats.track('messages');
        socket.to(roomId).emit('new-message', {
            ciphertext: payload.ciphertext,
            iv: payload.iv,
            username: socket.data.username,
            timestamp: Date.now(),
            id: socket.id
        });
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
        const kind = videoData.kind === 'direct' ? 'direct' : 'yt';
        const src = typeof videoData.src === 'string' ? videoData.src : '';
        if (kind === 'direct' && (!/^https?:\/\//i.test(src) || src.length > MAX_STREAM_URL)) return;
        const title = typeof videoData.title === 'string' ? videoData.title.slice(0, MAX_TITLE) : '';
        const room = getRoom(roomId);
        room.videoState = {
            videoId: kind === 'yt' ? String(videoData.videoId || '') : '',
            src: kind === 'direct' ? src : '',
            kind,
            title,
            content: kind === 'direct' ? cleanContent(videoData.content) : null,
            isPlaying: false,
            currentTime: 0,
            lastUpdate: Date.now()
        };
        // Which kind of video was started (counts only — never the title or link).
        stats.track(kind === 'yt' ? 'video_youtube' : room.videoState.content ? 'video_addon' : 'video_link');
        room.watchEpoch++;
        io.to(roomId).emit('video-loaded', { ...room.videoState, user: socket.data.username });
    });

    // ---- Room addons (opaque E2E-encrypted blob; server can't read it) ----
    socket.on('set-addons', (payload = {}) => {
        const roomId = socket.data.roomId;
        if (!roomId || typeof payload.ciphertext !== 'string' || typeof payload.iv !== 'string') return;
        if (payload.ciphertext.length > MAX_ADDONS_CIPHER) return;
        stats.track('addons_updated');
        const room = getRoom(roomId);
        room.addons = { iv: payload.iv, ciphertext: payload.ciphertext };
        socket.to(roomId).emit('addons-updated', { ...room.addons, user: socket.data.username });
    });

    socket.on('video-playpause', (data = {}) => {
        const roomId = socket.data.roomId;
        if (!roomId) return;
        const room = getRoom(roomId);
        room.videoState.isPlaying = !!data.isPlaying;
        room.videoState.currentTime = data.currentTime || 0;
        room.videoState.lastUpdate = Date.now();
        room.watchEpoch++; // pauses (and resumes) never count as watch time
        socket.to(roomId).emit('video-playpause-sync', {
            isPlaying: data.isPlaying,
            currentTime: data.currentTime,
            user: socket.data.username
        });
        io.to(roomId).emit('system-message', {
            message: `${socket.data.username} ${data.isPlaying ? 'played ▶️' : 'paused ⏸️'} the video`,
            timestamp: Date.now()
        });
    });

    socket.on('video-progress', (data = {}) => {
        const roomId = socket.data.roomId;
        if (!roomId) return;
        const room = getRoom(roomId);
        room.videoState.currentTime = data.currentTime || 0;
        room.videoState.lastUpdate = Date.now();
        socket.to(roomId).emit('video-progress-sync', { currentTime: data.currentTime });
        countWatchTime(socket, room);
    });

    socket.on('video-seek', (data = {}) => {
        const roomId = socket.data.roomId;
        if (!roomId) return;
        getRoom(roomId).videoState.currentTime = data.currentTime || 0;
        socket.to(roomId).emit('video-seek', { currentTime: data.currentTime, user: socket.data.username });
    });

    socket.on('sync-request', (data = {}) => {
        const roomId = socket.data.roomId;
        if (!roomId) return;
        const room = getRoom(roomId);
        if (data) {
            room.videoState.currentTime = data.currentTime || room.videoState.currentTime;
            room.videoState.isPlaying = !!data.isPlaying;
            room.videoState.lastUpdate = Date.now();
        }
        io.to(roomId).emit('video-sync', room.videoState);
    });

    // ---- Polls (preset questions, non-private) ----
    socket.on('start-poll', (pollData = {}) => {
        const roomId = socket.data.roomId;
        if (!roomId) return;
        const room = getRoom(roomId);
        room.poll = { ...pollData, id: Date.now(), startTime: Date.now() };
        room.pollVotes.clear();
        io.to(roomId).emit('poll-started', room.poll);
    });

    socket.on('poll-vote', (voteData = {}) => {
        const roomId = socket.data.roomId;
        if (!roomId) return;
        const room = getRoom(roomId);
        if (room.poll && voteData.pollId === room.poll.id) {
            room.pollVotes.set(socket.id, { user: voteData.user, option: voteData.option });
            io.to(roomId).emit('poll-vote', { user: voteData.user, option: voteData.option });
        }
    });

    socket.on('poll-end', () => {
        const roomId = socket.data.roomId;
        if (!roomId) return;
        const room = getRoom(roomId);
        if (room.poll) {
            io.to(roomId).emit('poll-ended', { results: Array.from(room.pollVotes.values()) });
            room.poll = null;
            room.pollVotes.clear();
        }
    });

    // ---- Voice room (Discord-style: join/leave any time, up to MAX_VOICE) ----
    // Media is peer-to-peer and encrypted by WebRTC; the server relays only
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

    socket.on('disconnect', () => {
        leaveRoom(socket);
        stats.observeOnline(io.engine.clientsCount);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Reddate server running on http://localhost:${PORT}`);
});
