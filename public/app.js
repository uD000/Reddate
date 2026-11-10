/* Reddate client.
 *
 * End-to-end encryption: each room has an AES-GCM key that lives only in the
 * URL fragment (#room=<id>&k=<key>). The fragment is never sent to the server,
 * so the server only ever relays ciphertext. Every participant shares the same
 * link, so they all hold the same key and can decrypt each other's messages.
 */

// ---------------- Crypto helpers ----------------
const enc = new TextEncoder();
const dec = new TextDecoder();

function bytesToB64url(bytes) {
    let bin = '';
    bytes.forEach(b => bin += String.fromCharCode(b));
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlToBytes(str) {
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    const bin = atob(str);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
}

async function generateRoomKey() {
    return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}
async function exportKey(key) {
    const raw = await crypto.subtle.exportKey('raw', key);
    return bytesToB64url(new Uint8Array(raw));
}
async function importKey(b64) {
    return crypto.subtle.importKey('raw', b64urlToBytes(b64), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
async function encryptText(key, text) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(text));
    return { iv: bytesToB64url(iv), ciphertext: bytesToB64url(new Uint8Array(ct)) };
}
async function decryptText(key, payload) {
    const iv = b64urlToBytes(payload.iv);
    const data = b64urlToBytes(payload.ciphertext);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
    return dec.decode(plain);
}

function randomRoomId() {
    return bytesToB64url(crypto.getRandomValues(new Uint8Array(9)));
}

// ---------------- Fragment parsing ----------------
function parseFragment() {
    const params = new URLSearchParams(location.hash.replace(/^#/, ''));
    return { roomId: params.get('room'), keyB64: params.get('k') };
}

// ---------------- App state ----------------
let socket = null;
let roomKey = null;      // CryptoKey
let roomId = null;
let currentUser = 'Guest';

let vp = null;              // unified player adapter (YouTube or HTML5 <video>)
let currentSrc = '';        // videoId (yt) or url (direct) currently loaded
let isPlayerReady = false;
let isVideoPlaying = false;
let ignoreNextStateChange = false;
let pendingState = null;    // play/pause/seek to apply once the player is ready
let typingTimer = null;

// Generic trigger words -> reaction emoji. Detected client-side on decrypted
// text, so no plaintext ever leaves the browser.
const rainTriggers = {
    love: '❤️', heart: '❤️', lol: '😂', haha: '😂', omg: '😲',
    wow: '🤩', sad: '😢', fire: '🔥', party: '🎉', gg: '🎮'
};

const genericPolls = [
    { question: 'What should we watch next? 🎬', options: ['Comedy 😂', 'Action 💥', 'Something chill 😌', 'Surprise me! 🎲'] },
    { question: 'How\'s the vibe right now? ✨', options: ['Loving it 😍', 'Pretty good 😊', 'Let\'s switch it up 🔄', 'Need a break ☕'] },
    { question: 'Snack of choice for this watch party? 🍿', options: ['Popcorn 🍿', 'Chips 🥔', 'Sweets 🍫', 'Just vibes 😎'] }
];

let currentPoll = null;
let pollVotes = new Map();
let hasVotedInCurrentPoll = false;
let userCount = 0;

// ---------------- Anonymous usage counts ----------------
// Sends only an event name (see stats.js on the server): no room, no user,
// nothing typed or watched.
function sendStat(e) {
    try {
        const body = new Blob([JSON.stringify({ e })], { type: 'text/plain' });
        if (!navigator.sendBeacon || !navigator.sendBeacon('/api/event', body)) {
            fetch('/api/event', { method: 'POST', body, keepalive: true }).catch(() => {});
        }
    } catch (_) { /* stats are best-effort */ }
}
sendStat('visit');

// Optional "Buy me a coffee" link (set SUPPORT_URL on the server); hidden when unset.
fetch('/support-config').then(r => r.json()).then(({ url }) => {
    if (!url) return;
    ['supportTop', 'supportLobby'].forEach(id => {
        const a = document.getElementById(id);
        a.href = url;
        a.hidden = false;
    });
}).catch(() => {});

// ---------------- Lobby ----------------
const lobbyEl = document.getElementById('lobby');
const appEl = document.getElementById('app');
const usernameInput = document.getElementById('usernameInput');
const lobbyBtn = document.getElementById('lobbyBtn');
const lobbyTagline = document.getElementById('lobbyTagline');

const existing = parseFragment();
const isJoining = !!(existing.roomId && existing.keyB64);

if (isJoining) {
    lobbyBtn.textContent = 'Join room';
    lobbyTagline.textContent = 'You\'ve been invited to a room. Pick a name and jump in.';
}

usernameInput.focus();
usernameInput.addEventListener('keydown', e => { if (e.key === 'Enter') lobbyBtn.click(); });

lobbyBtn.addEventListener('click', async () => {
    const name = usernameInput.value.trim();
    if (!name) { usernameInput.focus(); return; }
    currentUser = name;
    lobbyBtn.disabled = true;

    if (isJoining) {
        roomId = existing.roomId;
        roomKey = await importKey(existing.keyB64);
    } else {
        roomId = randomRoomId();
        const key = await generateRoomKey();
        roomKey = key;
        const keyB64 = await exportKey(key);
        location.hash = `room=${encodeURIComponent(roomId)}&k=${keyB64}`;
    }

    startApp();
});

function showToast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove('show'), 2200);
}

// ---------------- Theme switcher (light default / dark) ----------------
(function initThemeToggle() {
    const btn = document.getElementById('themeToggle');
    if (!btn) return;
    const label = () => {
        const light = document.documentElement.getAttribute('data-theme') === 'light';
        const text = light ? 'Switch to dark theme' : 'Switch to light theme';
        btn.querySelector('use').setAttribute('href', light ? '#i-moon' : '#i-sun');
        btn.setAttribute('aria-label', text);
        btn.title = text;
    };
    label();
    btn.addEventListener('click', () => {
        const light = document.documentElement.getAttribute('data-theme') === 'light';
        if (light) document.documentElement.removeAttribute('data-theme');
        else document.documentElement.setAttribute('data-theme', 'light');
        try { localStorage.setItem('reddate-theme', light ? 'dark' : 'light'); } catch (e) {}
        label();
    });
})();

// ---------------- Main app ----------------
function startApp() {
    lobbyEl.classList.add('hidden');
    appEl.classList.remove('hidden');

    socket = io();

    socket.on('connect', () => {
        document.getElementById('connectionStatus').classList.remove('disconnected');
        document.getElementById('connectionText').textContent = 'Connected';
        socket.emit('join-room', { roomId, username: currentUser });
    });
    socket.on('disconnect', () => {
        document.getElementById('connectionStatus').classList.add('disconnected');
        document.getElementById('connectionText').textContent = 'Disconnected';
    });

    socket.on('joined', () => addSystemMessage('🔒 Connected securely. Share the invite link to bring someone in.'));
    socket.on('user-count', c => {
        userCount = c;
        document.getElementById('userCount').textContent = `${c} online`;
    });
    socket.on('system-message', d => addSystemMessage(d.message));

    socket.on('new-message', async data => {
        try {
            const text = await decryptText(roomKey, data);
            const msg = parseEnvelope(text);
            addMessage(msg, data.username, 'other');
            if (msg.t === 'text') detectTriggers(msg.v);
            noteUnread();
        } catch (e) {
            addSystemMessage('⚠️ Received a message that could not be decrypted (key mismatch).');
        }
    });

    const currentlyTyping = new Set();
    socket.on('user-typing', data => {
        const el = document.getElementById('typingIndicator');
        if (data.isTyping) currentlyTyping.add(data.username);
        else currentlyTyping.delete(data.username);
        if (currentlyTyping.size > 0) {
            el.textContent = `${Array.from(currentlyTyping).join(', ')} is typing...`;
            el.style.display = 'block';
        } else el.style.display = 'none';
    });

    wireVideoEvents();
    wirePollEvents();
    wireControls();
    startPollTimer();

    document.getElementById('postAuthor').textContent = `Posted by u/${currentUser}`;

    // Hand the connected socket to the voice room (voice.js).
    if (window.initVoice) window.initVoice(socket, showToast);

    // Addon browser (addons.js). The room's addon list rides the same E2E key as chat.
    if (window.initAddons) window.initAddons(socket, {
        roomId,
        encrypt: obj => encryptText(roomKey, JSON.stringify(obj)),
        decrypt: async payload => JSON.parse(await decryptText(roomKey, payload)),
        toast: showToast
    });
}

// ---------------- Chat ----------------
const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // 2 MB cap on uploads

// Messages are encrypted as a small JSON envelope so we can carry text or
// images over the same E2E channel. { t: 'text' | 'img', v: <string> }
function parseEnvelope(raw) {
    try {
        const obj = JSON.parse(raw);
        if (obj && (obj.t === 'text' || obj.t === 'img')) return obj;
    } catch { /* legacy/plain text */ }
    return { t: 'text', v: raw };
}

async function sendChat(msg) {
    if (!roomKey) return;
    addMessage(msg, currentUser, 'self');
    if (msg.t === 'text') detectTriggers(msg.v);
    const payload = await encryptText(roomKey, JSON.stringify(msg));
    socket.emit('send-message', payload);
}

async function sendMessage() {
    const input = document.getElementById('messageInput');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    socket.emit('typing-stop');
    await sendChat({ t: 'text', v: text });
}

function sendImageFromFile(file) {
    if (!file) return;
    if (!file.type.startsWith('image/')) { showToast('Please pick an image or GIF'); return; }
    if (file.size > MAX_IMAGE_BYTES) { showToast('Image too large (max 2 MB)'); return; }
    const reader = new FileReader();
    reader.onload = () => sendChat({ t: 'img', v: reader.result }); // encrypted data URL
    reader.readAsDataURL(file);
}

// ---------------- GIF picker (GIPHY) ----------------
// Opens on trending GIFs, searches as you type, loads more as you scroll, and
// sends the picked GIF over the encrypted chat channel like any image.
// GIPHY requires these calls to come from the browser; searches are visible to
// GIPHY (not end-to-end encrypted) — the picker says so.
const GIPHY_API = 'https://api.giphy.com/v1/gifs';
const GIF_PAGE = 24;
let gifConfig = null;     // { provider, key } fetched lazily from the server
let gifQuery = '';
let gifOffset = 0;
let gifHasMore = false;
let gifLoading = false;
let gifRequest = 0;       // ignores responses from superseded searches
let gifTimer = null;
let gifObserver = null;

async function loadGifConfig() {
    if (gifConfig) return gifConfig;
    try {
        gifConfig = await (await fetch('/gif-config')).json();
    } catch { gifConfig = { provider: 'giphy', key: '' }; }
    return gifConfig;
}

function setGifStatus(text) { document.getElementById('gifStatus').textContent = text || ''; }

async function openGifPicker() {
    document.getElementById('gifModal').classList.add('show');
    const search = document.getElementById('gifSearch');
    const cfg = await loadGifConfig();
    search.disabled = !cfg.key;
    if (!cfg.key) {
        document.getElementById('gifGrid').innerHTML = '';
        setGifStatus('GIFs aren\'t set up on this server yet — add a free GIPHY API key as GIPHY_API_KEY to turn them on.');
        return;
    }
    search.value = '';
    search.focus();
    if (!gifObserver) {
        // Load the next page when the bottom of the grid scrolls into view.
        gifObserver = new IntersectionObserver(entries => {
            if (entries.some(e => e.isIntersecting) && gifHasMore && !gifLoading) loadGifs(false);
        }, { root: document.querySelector('#gifModal .modal-content'), rootMargin: '200px' });
        gifObserver.observe(document.getElementById('gifSentinel'));
    }
    gifQuery = '';
    loadGifs(true);
}

function scheduleGifSearch(q) {
    clearTimeout(gifTimer);
    gifTimer = setTimeout(() => {
        gifQuery = q.trim();
        loadGifs(true);
    }, 300);
}

function gifSkeletons(grid, n) {
    for (let i = 0; i < n; i++) {
        const s = document.createElement('div');
        s.className = 'gif-skeleton';
        s.style.aspectRatio = `${[4, 3, 1, 16][i % 4]} / ${[3, 4, 1, 9][i % 4]}`;
        grid.appendChild(s);
    }
}

async function loadGifs(fresh) {
    const cfg = await loadGifConfig();
    if (!cfg.key) return;
    const grid = document.getElementById('gifGrid');
    const req = ++gifRequest;
    if (fresh) {
        gifOffset = 0;
        grid.innerHTML = '';
        gifSkeletons(grid, 9);
        document.querySelector('#gifModal .modal-content').scrollTop = 0;
    }
    gifLoading = true;
    setGifStatus('');
    const params = new URLSearchParams({
        api_key: cfg.key, limit: String(GIF_PAGE), offset: String(gifOffset),
        rating: 'pg-13', bundle: 'messaging_non_clips'
    });
    if (gifQuery) params.set('q', gifQuery);
    try {
        const res = await fetch(`${GIPHY_API}/${gifQuery ? 'search' : 'trending'}?${params}`);
        const data = await res.json();
        if (req !== gifRequest) return;
        if (!res.ok) throw new Error((data.meta && data.meta.msg) || `HTTP ${res.status}`);
        if (fresh) grid.innerHTML = '';
        const items = data.data || [];
        items.forEach(g => {
            const img = g.images || {};
            const thumb = img.fixed_width || img.fixed_width_downsampled || img.downsized;
            const full = img.downsized_medium || img.fixed_width || img.original;
            if (!thumb || !thumb.url || !full || !full.url) return;
            const btn = document.createElement('button');
            btn.className = 'gif-item';
            btn.type = 'button';
            btn.setAttribute('aria-label', g.title || 'GIF');
            const pic = document.createElement('img');
            pic.src = thumb.webp || thumb.url;
            pic.alt = '';
            pic.loading = 'lazy';
            if (thumb.width && thumb.height) { pic.width = thumb.width; pic.height = thumb.height; }
            btn.appendChild(pic);
            btn.onclick = () => {
                sendChat({ t: 'img', v: full.url });
                sendStat('gif');
                document.getElementById('gifModal').classList.remove('show');
                document.getElementById('messageInput').focus({ preventScroll: true });
            };
            grid.appendChild(btn);
        });
        const total = data.pagination ? data.pagination.total_count : 0;
        gifOffset += items.length;
        gifHasMore = items.length > 0 && gifOffset < total;
        if (fresh && !items.length) setGifStatus(gifQuery ? `No GIFs for “${gifQuery}”. Try another word.` : 'No GIFs right now.');
    } catch (e) {
        if (req !== gifRequest) return;
        if (fresh) grid.innerHTML = '';
        gifHasMore = false;
        setGifStatus(`Couldn't load GIFs (${e.message}). Check the GIPHY key or try again.`);
    } finally {
        if (req === gifRequest) gifLoading = false;
    }
}

function addMessage(msg, username, kind) {
    const chat = document.getElementById('chatMessages');
    const div = document.createElement('div');
    div.className = `message ${kind}`;
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    div.innerHTML = `
        <div class="message-header">
            <span class="username ${kind === 'self' ? 'self' : ''}"></span>
            <span class="timestamp">${time}</span>
        </div>
        <div class="message-content"></div>`;
    div.querySelector('.username').textContent = username;
    const body = div.querySelector('.message-content');
    if (msg.t === 'img') {
        const img = document.createElement('img');
        img.alt = 'shared image';
        img.loading = 'lazy';
        img.src = msg.v;           // data URL (uploaded) or external URL (GIF link)
        body.appendChild(img);
    } else {
        body.textContent = msg.v;  // textContent — never innerHTML, avoids injection
    }
    chat.appendChild(div);
    chat.scrollTop = chat.scrollHeight;
}

function addSystemMessage(text) {
    const chat = document.getElementById('chatMessages');
    const div = document.createElement('div');
    div.className = 'message system-message';
    div.innerHTML = '<div class="message-content"></div>';
    div.querySelector('.message-content').textContent = text;
    chat.appendChild(div);
    chat.scrollTop = chat.scrollHeight;
    setTimeout(() => {
        div.style.transition = 'opacity 0.3s, transform 0.3s';
        div.style.opacity = '0';
        div.style.transform = 'translateY(-20px)';
        setTimeout(() => div.remove(), 300);
    }, 4000);
}

function detectTriggers(text) {
    const lower = text.toLowerCase();
    Object.keys(rainTriggers).forEach(word => {
        if (lower.includes(word)) triggerRain(rainTriggers[word]);
    });
}

function triggerRain(emoji) {
    const container = document.getElementById('rainContainer');
    for (let i = 0; i < 12; i++) {
        setTimeout(() => {
            const drop = document.createElement('div');
            drop.className = 'rain-emoji';
            drop.textContent = emoji;
            drop.style.left = Math.random() * 100 + 'vw';
            drop.style.animationDuration = (Math.random() * 2 + 2) + 's';
            container.appendChild(drop);
            setTimeout(() => drop.remove(), 4000);
        }, i * 120);
    }
}

// ---------------- Video sync ----------------
// A room can play a YouTube video OR a direct video-file URL (.mp4/.webm/…).
// Both are wrapped in a small adapter (`vp`) with a common play/pause/seek API
// so the sync logic below doesn't care which kind is loaded.
let ytApiReady = false;
function onYouTubeIframeAPIReady() { ytApiReady = true; }
window.onYouTubeIframeAPIReady = onYouTubeIframeAPIReady;

function stageEl() { return document.getElementById('videoPlayer'); }
function consumeIgnore() { const i = ignoreNextStateChange; ignoreNextStateChange = false; return i; }

function destroyPlayer() {
    if (vp && vp.destroy) { try { vp.destroy(); } catch (_) {} }
    vp = null;
    isPlayerReady = false;
    stageEl().innerHTML = '';
    setPlayerStatus('');
    if (window.tracks) window.tracks.detach(); // subtitles / audio tracks (tracks.js)
}

function setPlayerStatus(text) { document.getElementById('playerStatus').textContent = text; }

function onLocalPlayPause(playing) {
    isVideoPlaying = playing;
    updatePlayPauseButton();
    socket.emit('video-playpause', { isPlaying: playing, currentTime: vp ? vp.getCurrentTime() : 0 });
}

function applyPending() {
    if (!pendingState || !vp) return;
    const s = pendingState;
    pendingState = null;
    ignoreNextStateChange = true;
    if (s.currentTime) vp.seekTo(s.currentTime);
    s.isPlaying ? vp.play() : vp.pause();
    isVideoPlaying = s.isPlaying;
    updatePlayPauseButton();
}

function createYouTubePlayer(videoId) {
    if (!window.YT || !YT.Player) { setTimeout(() => createYouTubePlayer(videoId), 300); return; }
    destroyPlayer();
    if (window.tracks) window.tracks.attachYouTube();
    currentSrc = videoId;
    const mount = document.createElement('div');
    stageEl().appendChild(mount);
    const yt = new YT.Player(mount, {
        height: '100%', width: '100%', videoId,
        playerVars: { autoplay: 0, controls: 1, rel: 0, modestbranding: 1 },
        events: {
            onReady: () => { isPlayerReady = true; updatePlayPauseButton(); applyPending(); },
            onStateChange: (e) => {
                if (consumeIgnore()) return;
                const playing = e.data === YT.PlayerState.PLAYING;
                const paused = e.data === YT.PlayerState.PAUSED;
                if (playing || paused) onLocalPlayPause(playing);
            }
        }
    });
    vp = {
        getCurrentTime: () => yt.getCurrentTime() || 0,
        seekTo: (t) => yt.seekTo(t, true),
        play: () => yt.playVideo(),
        pause: () => yt.pauseVideo(),
        destroy: () => yt.destroy()
    };
}

// hls.js is only fetched the first time an HLS (.m3u8) stream is loaded.
const HLS_JS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.13/hls.min.js';
let hlsJsPromise = null;
function loadHlsJs() {
    if (!hlsJsPromise) {
        hlsJsPromise = new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = HLS_JS_URL;
            s.onload = () => resolve(window.Hls);
            s.onerror = () => { hlsJsPromise = null; reject(new Error('hls.js failed to load')); };
            document.head.appendChild(s);
        });
    }
    return hlsJsPromise;
}

function isHlsUrl(src) { return /\.m3u8($|\?)/i.test(src); }

function createDirectPlayer(src) {
    destroyPlayer();
    currentSrc = src;
    const v = document.createElement('video');
    v.preload = 'auto';
    let hls = null;
    if (isHlsUrl(src) && !(v.canPlayType('application/vnd.apple.mpegurl') && v.audioTracks)) {
        // Some browsers play HLS natively without exposing audio tracks. Use
        // hls.js there so language switching works; Safari keeps native tracks.
        loadHlsJs().then(Hls => {
            if (!v.isConnected) return;
            if (!Hls || !Hls.isSupported()) { v.src = src; return; }
            hls = new Hls();
            // Listen before loading: the language list can arrive immediately.
            if (window.tracks) window.tracks.attachHls(hls);
            hls.loadSource(src);
            hls.attachMedia(v);
        }).catch(() => {
            if (!v.isConnected) return;
            v.src = src;
            showToast('Audio controls could not load. Trying the browser player.');
        });
    } else {
        v.src = src;
    }
    v.controls = true;
    v.playsInline = true;
    v.style.background = '#000'; // sized by #videoPlayer (fixed height on desktop, 16:9 on phones)
    stageEl().appendChild(v);
    const audioGate = window.createPlaybackGate(v, {
        onPlayback: playing => { if (!consumeIgnore()) onLocalPlayPause(playing); },
        onBuffering: buffering => {
            document.getElementById('audioBufferingStatus').hidden = !buffering;
        },
        onPlayError: () => { ignoreNextStateChange = false; showToast('Tap Play to resume playback'); }
    });
    if (window.tracks) window.tracks.attach(v, src);
    // Addon sources can take a minute to resolve; say so instead of showing a dead black box.
    setPlayerStatus('⏳ Loading stream…');
    const slowTimer = setTimeout(() => {
        if (!isPlayerReady && currentSrc === src) setPlayerStatus('⏳ Still loading — this source is slow. If it doesn\'t start soon, pick another stream in 🍿 Browse.');
    }, 15000);
    v.addEventListener('loadeddata', () => { clearTimeout(slowTimer); setPlayerStatus(''); isPlayerReady = true; updatePlayPauseButton(); applyPending(); });
    // Only broadcast seeks the viewer made. Seeks applied from the room (remote
    // seek, sync, drift correction) must not be re-broadcast, or two players
    // echo the same seek back and forth forever and playback never advances.
    let programmaticSeekTo = null, syncAfter = 0;
    // Let the decoder settle after startup or a seek before applying routine
    // room drift corrections. Explicit room seeks still take effect at once.
    v.addEventListener('seeking', () => { syncAfter = performance.now() + 2000; });
    v.addEventListener('playing', () => { syncAfter = performance.now() + 2000; });
    v.addEventListener('seeked', () => {
        if (programmaticSeekTo !== null && Math.abs(v.currentTime - programmaticSeekTo) < 0.5) {
            programmaticSeekTo = null;
            return;
        }
        programmaticSeekTo = null;
        socket.emit('video-seek', { currentTime: v.currentTime });
    });
    v.addEventListener('error', () => {
        clearTimeout(slowTimer);
        setPlayerStatus('⚠️ This stream can\'t play in your browser — pick another one in 🍿 Browse.');
        showToast('This video can\'t play in your browser — try another stream from 🍿 Browse');
    });
    vp = {
        getCurrentTime: () => v.currentTime || 0,
        seekTo: (t) => {
            if (!Number.isFinite(t) || Math.abs(v.currentTime - t) < 0.1) return;
            programmaticSeekTo = t;
            v.currentTime = t;
        },
        play: () => { if (!audioGate.play()) ignoreNextStateChange = false; },
        pause: () => { if (!audioGate.pause()) ignoreNextStateChange = false; },
        isBuffering: () => audioGate.buffering || v.seeking || v.readyState < 3,
        canSyncProgress: () => !v.paused && !audioGate.buffering && !v.seeking && v.readyState >= 3 && performance.now() >= syncAfter,
        destroy: () => { audioGate.destroy(); clearTimeout(slowTimer); if (hls) hls.destroy(); v.pause(); v.removeAttribute('src'); v.load(); v.remove(); }
    };
}

function ensurePlayer(state) {
    const kind = state.kind || 'yt';
    const key = kind === 'direct' ? state.src : state.videoId;
    if (!key) return false;
    if (!vp || currentSrc !== key) {
        kind === 'direct' ? createDirectPlayer(state.src) : createYouTubePlayer(state.videoId);
    }
    return true;
}


function wireVideoEvents() {
    socket.on('video-loaded', data => {
        ensurePlayer(data);
        setNowPlaying(data.title);
        if (window.tracks && data.kind === 'direct') window.tracks.setContent(data.content);
        addSystemMessage(`🎬 ${data.user} loaded ${data.title ? `“${data.title}”` : 'a video'}`);
    });
    socket.on('video-playpause-sync', data => {
        isVideoPlaying = data.isPlaying;
        updatePlayPauseButton();
        if (!vp || !isPlayerReady) { pendingState = { isPlaying: data.isPlaying, currentTime: data.currentTime }; return; }
        ignoreNextStateChange = true;
        if (data.currentTime) vp.seekTo(data.currentTime);
        data.isPlaying ? vp.play() : vp.pause();
    });
    socket.on('video-progress-sync', data => {
        if (!vp || !isPlayerReady || vp.isBuffering?.()) return;
        if (vp.canSyncProgress && !vp.canSyncProgress()) return;
        if (Math.abs(vp.getCurrentTime() - data.currentTime) > 2) vp.seekTo(data.currentTime);
    });
    socket.on('video-seek', data => {
        // Skip seeks to where we already are, so a stray echo can't start a loop.
        if (vp && isPlayerReady && Math.abs(vp.getCurrentTime() - data.currentTime) > 0.5) vp.seekTo(data.currentTime);
    });
    socket.on('video-sync', state => {
        if (!ensurePlayer(state)) return;
        setNowPlaying(state.title);
        if (window.tracks && state.kind === 'direct') window.tracks.setContent(state.content);
        isVideoPlaying = state.isPlaying;
        updatePlayPauseButton();
        if (!isPlayerReady) { pendingState = { isPlaying: state.isPlaying, currentTime: state.currentTime }; return; }
        ignoreNextStateChange = true;
        if (state.currentTime) vp.seekTo(state.currentTime);
        state.isPlaying ? vp.play() : vp.pause();
    });

    // Periodically share our position so late joiners / drifters stay in sync.
    setInterval(() => {
        if (vp && isPlayerReady && isVideoPlaying && !vp.isBuffering?.()) {
            socket.emit('video-progress', { currentTime: vp.getCurrentTime() });
        }
    }, 4000);
}

function setNowPlaying(title) {
    const el = document.getElementById('nowPlaying');
    el.textContent = title || ''; // the post's title, Reddit-style
    el.style.display = title ? 'block' : 'none';
}

function youtubeId(url) {
    const m = url.match(/(?:youtu\.be\/|[?&]v=|\/(?:shorts|embed|live)\/)([\w-]{11})/);
    return m ? m[1] : null;
}

// Loads a link from the Browse window's "YouTube" / "Paste link" tabs.
function loadVideo(inputId) {
    const input = document.getElementById(inputId);
    const url = input.value.trim();
    if (!url) { input.focus(); return; }
    const videoId = youtubeId(url);
    if (videoId) {
        socket.emit('load-video', { kind: 'yt', videoId, url });
    } else if (inputId === 'youtubeUrl') {
        showToast('That doesn’t look like a YouTube video link'); return;
    } else if (/^https?:\/\/\S+\.(mp4|webm|ogg|ogv|m4v|mov|m3u8)(\?\S*)?$/i.test(url)) {
        socket.emit('load-video', { kind: 'direct', src: url });
    } else {
        showToast('Paste a direct video link (.mp4, .webm, .mov or .m3u8)'); return;
    }
    input.value = '';
    document.getElementById('browseModal').classList.remove('show');
}

function togglePlayPause() {
    if (!vp || !isPlayerReady) { showToast('Load a video first'); return; }
    const shouldPlay = !isVideoPlaying;
    isVideoPlaying = shouldPlay;
    updatePlayPauseButton();
    ignoreNextStateChange = true;
    socket.emit('video-playpause', { isPlaying: shouldPlay, currentTime: vp.getCurrentTime() });
    shouldPlay ? vp.play() : vp.pause();
}

function updatePlayPauseButton() {
    const btn = document.getElementById('playPauseBtn');
    btn.querySelector('use').setAttribute('href', isVideoPlaying ? '#i-pause' : '#i-play');
    btn.querySelector('.label').textContent = isVideoPlaying ? 'Pause' : 'Play';
}

function syncVideo() {
    if (!vp || !isPlayerReady) { showToast('Load a video first'); return; }
    socket.emit('sync-request', { currentTime: vp.getCurrentTime(), isPlaying: isVideoPlaying });
    addSystemMessage('🔄 Syncing everyone...');
}

// ---------------- Controls & share ----------------
// ---------------- Comments panel ----------------
// A collapsible rail on wide screens, a bottom sheet on phones (non-modal, so the
// video stays visible and playable above it). Unread
// messages are counted on the toggle while the panel isn't visible.
const wideLayout = window.matchMedia('(min-width: 60rem)');
let railOpen = true;   // wide screens: rail shown unless collapsed
let sheetOpen = false; // phones: sheet hidden until opened
let unreadCount = 0;
let theater = false;     // full-screen mode: video fills the screen
let theaterChat = false; // full-screen mode: see-through comments dropped down

function isChatVisible() {
    if (theater) return theaterChat;
    return wideLayout.matches ? railOpen : sheetOpen;
}

const unreadBadges = () => ['chatUnread', 'theaterUnread'].map(id => document.getElementById(id));

function applyChatLayout() {
    const visible = isChatVisible();
    appEl.classList.toggle('rail-collapsed', !railOpen);
    appEl.classList.toggle('sheet-open', sheetOpen);
    appEl.classList.toggle('theater-chat', theater && theaterChat);
    document.getElementById('chatPanel').inert = !visible;
    document.getElementById('chatToggle').setAttribute('aria-expanded', String(visible));
    document.getElementById('theaterChatBtn').setAttribute('aria-expanded', String(theater && theaterChat));
    if (visible) {
        unreadCount = 0;
        unreadBadges().forEach(b => { b.hidden = true; });
    }
}

function setChatOpen(open) {
    if (theater) theaterChat = open;
    else if (wideLayout.matches) railOpen = open;
    else sheetOpen = open;
    applyChatLayout();
    if (!open && document.getElementById('chatPanel').contains(document.activeElement)) {
        document.getElementById(theater ? 'theaterChatBtn' : 'chatToggle').focus();
    }
}

function noteUnread() {
    if (isChatVisible()) return;
    unreadCount++;
    unreadBadges().forEach(b => {
        b.textContent = unreadCount > 99 ? '99+' : String(unreadCount);
        b.hidden = false;
    });
}

// ---------------- Full-screen mode ----------------
// Uses the browser's real full screen where it exists (not on iPhone, which
// only allows it for a bare <video>); either way the page switches to a
// video-only layout with comments as a drop-down overlay.
let idleTimer = null;
function markActive() {
    appEl.classList.remove('idle');
    clearTimeout(idleTimer);
    if (theater) idleTimer = setTimeout(() => appEl.classList.add('idle'), 3000);
}

function setTheater(on) {
    if (on === theater) return;
    theater = on;
    theaterChat = false;
    appEl.classList.toggle('theater', on);
    const btn = document.getElementById('fullscreenBtn');
    btn.setAttribute('aria-pressed', String(on));
    if (on) {
        const el = document.documentElement;
        const req = el.requestFullscreen || el.webkitRequestFullscreen;
        if (req) Promise.resolve(req.call(el)).then(() => {
            if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {});
        }).catch(() => {});
        markActive();
    } else {
        clearTimeout(idleTimer);
        appEl.classList.remove('idle');
        if (document.fullscreenElement || document.webkitFullscreenElement) {
            try { Promise.resolve((document.exitFullscreen || document.webkitExitFullscreen).call(document)).catch(() => {}); } catch (_) {}
        }
        btn.focus();
    }
    applyChatLayout();
}

function wireTheater() {
    document.getElementById('fullscreenBtn').addEventListener('click', () => setTheater(true));
    document.getElementById('theaterExitBtn').addEventListener('click', () => setTheater(false));
    document.getElementById('theaterChatBtn').addEventListener('click', () => {
        setChatOpen(!theaterChat);
        // Keyboards only: on phones focusing would pop the on-screen keyboard over the video.
        if (theaterChat && matchMedia('(hover: hover)').matches) document.getElementById('messageInput').focus({ preventScroll: true });
    });
    document.getElementById('chatTuck').addEventListener('click', () => setChatOpen(false));
    // Leaving real full screen (Esc, system gesture) also leaves the layout.
    const onFsChange = () => {
        if (theater && !(document.fullscreenElement || document.webkitFullscreenElement)) setTheater(false);
    };
    document.addEventListener('fullscreenchange', onFsChange);
    document.addEventListener('webkitfullscreenchange', onFsChange);
    ['pointermove', 'pointerdown', 'keydown'].forEach(ev => document.addEventListener(ev, () => { if (theater) markActive(); }, { passive: true }));
}

function wireChatPanel() {
    document.getElementById('chatToggle').addEventListener('click', () => setChatOpen(!isChatVisible()));
    document.getElementById('chatClose').addEventListener('click', () => setChatOpen(false));
    document.addEventListener('keydown', e => {
        if (e.key !== 'Escape' || e.defaultPrevented) return;
        if (document.querySelector('.modal.show')) return;
        if (theater && theaterChat) setChatOpen(false);
        else if (theater) setTheater(false); // the CSS-only full screen (iPhone) has no system Esc
        else if (sheetOpen && !wideLayout.matches) setChatOpen(false);
    });
    wireTheater();
    wideLayout.addEventListener('change', applyChatLayout);
    applyChatLayout();
}

function wireControls() {
    wireChatPanel();
    // Phones pin the controls to the bottom; share their height with the CSS.
    const controls = document.querySelector('.video-controls');
    new ResizeObserver(() => {
        document.documentElement.style.setProperty('--controls-h', `${controls.offsetHeight}px`);
    }).observe(controls);
    // The empty player's "Browse" does the same as the main Browse button.
    document.getElementById('emptyBrowseBtn').addEventListener('click', () => document.getElementById('browseBtn').click());
    [['loadBtn', 'videoUrl'], ['youtubeLoadBtn', 'youtubeUrl']].forEach(([btn, input]) => {
        document.getElementById(btn).addEventListener('click', () => loadVideo(input));
        document.getElementById(input).addEventListener('keydown', e => { if (e.key === 'Enter') loadVideo(input); });
    });
    document.getElementById('browseBtn').addEventListener('click', () => sendStat('browse'));
    document.getElementById('callBtn').addEventListener('click', () => { if (!document.getElementById('callBtn').classList.contains('is-on')) sendStat('call'); });
    document.getElementById('playPauseBtn').addEventListener('click', togglePlayPause);
    document.getElementById('syncBtn').addEventListener('click', syncVideo);
    document.getElementById('sendBtn').addEventListener('click', sendMessage);

    const msgInput = document.getElementById('messageInput');
    msgInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendMessage(); });
    msgInput.addEventListener('input', () => {
        socket.emit('typing-start');
        clearTimeout(typingTimer);
        typingTimer = setTimeout(() => socket.emit('typing-stop'), 1000);
    });

    document.getElementById('shareBtn').addEventListener('click', async () => {
        const link = location.href;
        try {
            await navigator.clipboard.writeText(link);
            showToast('Invite link copied 🔗');
        } catch {
            prompt('Copy this invite link:', link);
        }
    });

    // Image / GIF sharing (sent over the encrypted channel)
    const fileInput = document.getElementById('fileInput');
    document.getElementById('imgBtn').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
        sendImageFromFile(fileInput.files[0]);
        fileInput.value = '';
    });
    document.getElementById('gifBtn').addEventListener('click', openGifPicker);
    document.getElementById('gifSearch').addEventListener('input', e => scheduleGifSearch(e.target.value));
    // Close modals when clicking the dark backdrop, or their ✕ (full-screen on phones).
    document.querySelectorAll('.modal').forEach(m => {
        m.addEventListener('click', e => { if (e.target === m) m.classList.remove('show'); });
    });
    document.querySelectorAll('.modal-close').forEach(b => {
        b.addEventListener('click', () => b.closest('.modal').classList.remove('show'));
    });

    // Cosmetic Reddit-style vote widget
    let vote = 0; // -1, 0, 1
    const up = document.getElementById('upvoteArrow');
    const down = document.getElementById('downvoteArrow');
    const count = document.getElementById('voteCount');
    const renderVote = () => {
        count.textContent = 1 + vote;
        up.classList.toggle('upvoted', vote === 1);
        down.classList.toggle('downvoted', vote === -1);
    };
    up.addEventListener('click', () => { vote = vote === 1 ? 0 : 1; renderVote(); });
    down.addEventListener('click', () => { vote = vote === -1 ? 0 : -1; renderVote(); });
}

// ---------------- Polls ----------------
function wirePollEvents() {
    socket.on('poll-started', poll => {
        currentPoll = poll;
        pollVotes.clear();
        hasVotedInCurrentPoll = false;
        showPoll(poll);
    });
    socket.on('poll-vote', vote => { pollVotes.set(vote.user, vote.option); updatePollResults(); });
    socket.on('poll-ended', () => {
        setTimeout(() => { document.getElementById('pollModal').classList.remove('show'); currentPoll = null; }, 5000);
    });
}

function startPollTimer() {
    const delay = (10 + Math.random() * 5) * 60 * 1000; // 10-15 min
    setTimeout(() => {
        if (document.querySelectorAll('#chatMessages .message').length > 5) {
            socket.emit('start-poll', genericPolls[Math.floor(Math.random() * genericPolls.length)]);
        }
        startPollTimer();
    }, delay);
}

function showPoll(poll) {
    document.getElementById('pollQuestion').textContent = poll.question;
    const container = document.getElementById('pollOptions');
    container.style.display = 'block';
    container.innerHTML = '';
    poll.options.forEach((option, i) => {
        const div = document.createElement('div');
        div.className = 'poll-option';
        div.textContent = option;
        div.onclick = () => votePoll(i, option);
        container.appendChild(div);
    });
    document.getElementById('pollResults').style.display = 'none';
    document.getElementById('pollModal').classList.add('show');
}

function votePoll(index, optionText) {
    if (hasVotedInCurrentPoll) return;
    hasVotedInCurrentPoll = true;
    const opts = document.querySelectorAll('.poll-option');
    opts[index].classList.add('voted');
    opts.forEach(o => o.style.pointerEvents = 'none');
    socket.emit('poll-vote', { pollId: currentPoll.id, option: optionText, user: currentUser });
    setTimeout(() => {
        document.getElementById('pollOptions').style.display = 'none';
        document.getElementById('pollResults').style.display = 'block';
        updatePollResults();
    }, 800);
}

function updatePollResults() {
    if (!currentPoll) return;
    const container = document.getElementById('pollResults');
    container.innerHTML = '<h3 style="margin-bottom:15px;color:#46d160">Results so far</h3>';
    const total = pollVotes.size;
    const counts = new Map();
    pollVotes.forEach(opt => counts.set(opt, (counts.get(opt) || 0) + 1));
    currentPoll.options.forEach(option => {
        const count = counts.get(option) || 0;
        const pct = total > 0 ? Math.round((count / total) * 100) : 0;
        const div = document.createElement('div');
        div.className = 'poll-result';
        div.innerHTML = `<div><div class="label"></div><div class="poll-result-bar" style="width:${pct}%"></div></div>
            <div style="color:#ff4500;font-weight:bold">${count}</div>`;
        div.querySelector('.label').textContent = option;
        container.appendChild(div);
    });
}
