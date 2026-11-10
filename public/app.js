/* Reddate client.
 *
 * A room is just an id in the URL fragment (#room=<id>). Anyone with the link
 * can join, so treat the link like a password. The server relays chat as-is and
 * never stores it (it is not end-to-end encrypted).
 */

function bytesToB64url(bytes) {
    let bin = '';
    bytes.forEach(b => bin += String.fromCharCode(b));
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Room ids are short codes people can read out or type: 8 letters/digits without look-alikes (0/O, 1/I/L).
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function randomRoomId() {
    return Array.from(crypto.getRandomValues(new Uint8Array(8)), b => CODE_CHARS[b % CODE_CHARS.length]).join('');
}
const prettyCode = id => id === roomId && roomCode ? roomCode : (/^[A-Z0-9]{5}$/.test(id || '') ? id : (/^[A-Z2-9]{8}$/.test(id || '') ? `${id.slice(0, 4)}-${id.slice(4)}` : ''));
const parseCode = text => window.partyCode.parse(text)?.code || '';

// ---------------- Fragment parsing ----------------
// (Older invite links also carried "&k=…"; it's ignored now.)
function parseFragment() {
    const params = new URLSearchParams(location.hash.replace(/^#/, ''));
    return { roomId: params.get('room') };
}

// ---------------- App state ----------------
let socket = null;
let roomId = null;
let roomCode = '', requireExistingRoom = false;
let joinWaiters = [];
function finishJoin(result) { const pending = joinWaiters; joinWaiters = []; pending.forEach(f => f(result)); }
function waitForJoin() {
    return new Promise(resolve => {
        const done = result => { clearTimeout(timer); resolve(result); };
        const timer = setTimeout(() => { joinWaiters = joinWaiters.filter(f => f !== done); resolve({ ok: false, message: 'Could not join. Check your connection and try again.' }); }, 15000);
        joinWaiters.push(done);
    });
}
let currentUser = 'Guest';

let vp = null;              // unified player adapter (YouTube or HTML5 <video>)
let currentSrc = '';        // videoId (yt) or url (direct) currently loaded
let isPlayerReady = false;
let isVideoPlaying = false;
let typingTimer = null;

// Generic trigger words -> reaction emoji. Detected client-side on decrypted
// text, so no plaintext ever leaves the browser.
const rainTriggers = {
    love: '❤️', heart: '❤️', lol: '😂', haha: '😂', omg: '😲',
    wow: '🤩', sad: '😢', fire: '🔥', party: '🎉', gg: '🎮'
};

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

// ---------------- Screens: Home (catalog) → room (player) ----------------
// The app opens on Home. A room only exists once you start watching (or open
// an invite link): the connection to the server is made straight away, but you
// join a room only then.
const lobbyEl = document.getElementById('lobby');   // now just "you've been invited — pick a name"
const appEl = document.getElementById('app');       // the room: player, comments, Lounge
const homeEl = document.getElementById('home');     // the catalog
const usernameInput = document.getElementById('usernameInput');
const lobbyBtn = document.getElementById('lobbyBtn');

const existing = parseFragment();
// /join and /join/CODE: the guest page. Same room, only the player, chat, subtitles and audio.
// /lounge/CODE: the same guest page, but only chat plus voice and video (no player).
const LOUNGE = /^\/lounge(\/|$)/i.test(location.pathname) || /[?&]lounge=1(&|$)/.test(location.search);
const LEAN = /^\/(join|lounge)(\/|$)/i.test(location.pathname);
const leanCode = LEAN ? parseCode(decodeURIComponent((location.pathname.split('/')[2] || ''))) : '';
if (LEAN) document.documentElement.classList.add('lean');
if (LOUNGE) document.documentElement.classList.add('lounge');
// Inside the browser app's player (/lounge/CODE?frame=1&dev=…): the same Lounge as a panel. It joins by itself, shares the
// device name with the player (so host rights match) and tells the player about new lines.
const FRAME = LOUNGE && /[?&]frame=1(&|$)/.test(location.search);
const FRAME_DEV = (new URLSearchParams(location.search).get('dev') || 'Browser').slice(0, 40);
if (FRAME) document.documentElement.classList.add('frame');
let inRoom = false;
let afterJoin = []; // things to do once the server confirms we're in the room

const NAME_KEY = 'reddate-name';
function savedName() {
    const fromProfile = window.reddateAccount && window.reddateAccount.profileName && window.reddateAccount.profileName();
    if (fromProfile) return fromProfile;
    try { return localStorage.getItem(NAME_KEY) || ''; } catch (e) { return ''; }
}
function rememberName(name) { try { localStorage.setItem(NAME_KEY, name); } catch (e) {} }

function showScreen(which) {
    homeEl.hidden = which !== 'home';
    appEl.classList.toggle('hidden', which !== 'room');
    lobbyEl.classList.toggle('hidden', which !== 'lobby');
    document.documentElement.dataset.screen = which;
    if (which === 'home') window.scrollTo(0, 0);
}

// Watching alone needs no room: the server only hears about it once someone is invited (or a party is started).
// Until then the room lives only here, and what would have gone to the server is answered locally.
let roomLive = true;
function goLive() {
    if (!inRoom || roomLive) return;
    roomLive = true;
    if (roomId && location.hash !== `#room=${encodeURIComponent(roomId)}`) history.replaceState(null, '', `${location.pathname}${location.search}#room=${encodeURIComponent(roomId)}`);
    if (socket && socket.connected) joinRoomNow(); // carries what's playing, so the room starts exactly where we are
    if (window.reddateNativeInfo) setTimeout(window.reddateNativeInfo, 50);
}

// Join (or create) a room and show the player. `then` runs once we're in. opts.lazy: just watching alone, no room yet.
function enterRoom(name, id, then, opts) {
    requireExistingRoom = !!opts?.requireExisting;
    const lazy = !!(opts && opts.lazy) && !inRoom && !id;
    if (inRoom && !roomLive && !(opts && opts.lazy)) {
        if (id && id !== roomId) { inRoom = false; roomLive = true; } // joining someone else's room: the unshared solo one is simply dropped
        else goLive(); // asked for a real room: now it is one
    }
    currentUser = (name || savedName() || 'Guest').slice(0, 40);
    rememberName(currentUser);
    const switching = inRoom && id && id !== roomId; // e.g. accepting an invite from another room
    if (switching) { destroyPlayer(); setNowPlaying(''); party = null; }
    if (switching) roomCode = '';
    roomId = id || roomId || randomRoomId();
    if (!lazy && location.hash !== `#room=${encodeURIComponent(roomId)}`) history.replaceState(null, '', `${location.pathname}${location.search}#room=${encodeURIComponent(roomId)}`);
    if (then) afterJoin.push(then);
    document.getElementById('postAuthor').textContent = `Posted by u/${currentUser}`;
    const codeEl = document.getElementById('roomCode');
    codeEl.textContent = !lazy && prettyCode(roomId) ? `Room ${prettyCode(roomId)}` : '';
    codeEl.hidden = lazy || !prettyCode(roomId);
    renderShareCode();
    showScreen('room');
    if (!inRoom || switching) {
        inRoom = true;
        roomLive = !lazy;
        if (lazy) { const q = afterJoin; afterJoin = []; q.forEach(f => f()); }
        else if (socket && socket.connected) joinRoomNow();
    } else if (afterJoin.length) {
        const q = afterJoin; afterJoin = []; q.forEach(f => f());
    }
}

window.reddateRoom = {
    enterRoom,
    isInRoom: () => inRoom,
    roomId: () => roomId,
    roomCode: () => (roomLive ? prettyCode(roomId) : ''),
    savedName,
    showHome: () => showScreen('home'),
    showRoom: () => { if (inRoom) showScreen('room'); },
    // Leave the room on purpose: the server forgets you, the player closes, "Now playing" goes away.
    leave: () => { if (socket && socket.connected && inRoom && roomLive) socket.emit('leave-room'); leaveToHome(); },
    goLive,
    isLive: () => roomLive,
    isGuest: () => !!party && !isHost(),
    setGuestsCanPause: on => socket && socket.emit('party-setting', { guestsCanPause: !!on }),
    guestsCanPause: () => !!(party && party.guestsCanPause),
    hostName: () => (party ? party.hostName : '')
};

// Phones and computers open on the lobby: pick a name, then create a room or join one by its code.
// Invite links open the same card as "Join room". (The TV app opens on Home instead.)
const codeInput = document.getElementById('codeInput');
const codeBtn = document.getElementById('codeBtn');
const lobbyError = document.getElementById('lobbyError');
function clearLobbyError() {
    lobbyError.hidden = true;
    lobbyError.textContent = '';
    usernameInput.removeAttribute('aria-invalid');
    codeInput.removeAttribute('aria-invalid');
}
function showLobbyError(message, input) {
    lobbyError.textContent = message;
    lobbyError.hidden = false;
    if (input) { input.setAttribute('aria-invalid', 'true'); input.focus(); }
}
usernameInput.addEventListener('input', clearLobbyError);
codeInput.addEventListener('input', clearLobbyError);
usernameInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); (codeInput.value.trim() && !existing.roomId ? codeBtn : lobbyBtn).click(); }
});
lobbyBtn.addEventListener('click', () => enterFromLobby(false));
codeInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); codeBtn.click(); } });
// Is anyone in a room with this code right now? (Typing a wrong code shouldn't quietly create an empty room.)
function roomExists(code) {
    return new Promise(resolve => {
        if (!socket || !socket.connected) { resolve({ ok: false, message: 'Connecting. Try again in a moment.' }); return; }
        socket.timeout(8000).emit('resolve-room', { code }, (error, result) => resolve(error ? { ok: false, message: 'Could not check the code. Try again.' } : result));
    });
}
// Joining a watch party needs an account and a profile name.
function accountName() {
    const A = window.reddateAccount;
    return A && A.isSignedIn && A.isSignedIn() ? (A.profileName() || '') : '';
}
function askToSignIn(msg) {
    showToast(msg || 'Sign in to join this party');
    const A = window.reddateAccount;
    if (A && A.open) A.open();
}
async function enterFromLobby(joining) {
    if (lobbyBtn.disabled || codeBtn.disabled) return;
    clearLobbyError();
    const code = joining ? parseCode(codeInput.value) : '';
    if (joining && !code) { showLobbyError('Enter a 5-character room code or a valid invite link.', codeInput); return; }
    let name = usernameInput.value.trim();
    if (joining && LEAN) {
        name = accountName();
        if (!name) { askToSignIn('Sign in with your Reddate account and pick a profile to join'); return; }
    } else if (!name) { showLobbyError('Enter your name to create or join a room.', usernameInput); return; }
    const actionBtn = joining ? codeBtn : lobbyBtn;
    const label = actionBtn.textContent;
    actionBtn.textContent = joining || existing.roomId ? 'Joining…' : 'Creating…';
    lobbyBtn.disabled = codeBtn.disabled = true;
    lobbyEl.setAttribute('aria-busy', 'true');
    try {
        let id = existing.roomId || null;
        if (joining) {
            const found = await roomExists(code);
            if (!found?.ok) { showLobbyError(found?.message || 'That party has ended.', codeInput); return; }
            id = found.roomId;
        }
        const joined = waitForJoin();
        enterRoom(name, id, null, { requireExisting: !!id });
        const result = await joined;
        if (!result?.ok) { inRoom = false; showScreen('lobby'); showLobbyError(result?.message || 'Could not join the room. Try again.'); }
    } catch (error) {
        showLobbyError(error.message || 'Could not join the room. Try again.');
    } finally {
        actionBtn.textContent = label;
        lobbyBtn.disabled = codeBtn.disabled = false;
        lobbyEl.removeAttribute('aria-busy');
    }
}
function joinByCode() { return enterFromLobby(true); }
window.reddateJoinByCode = async text => {
    const code = parseCode(text);
    if (!code) return { ok: false, message: 'Enter a 5-character room code or invite link.' };
    const found = await roomExists(code);
    if (!found?.ok) return found || { ok: false, message: 'That party has ended.' };
    if (inRoom && roomLive && roomId === found.roomId) return { ok: true };
    const result = waitForJoin();
    enterRoom(savedName() || 'Guest', found.roomId, null, { requireExisting: true });
    // Joining a room already joined needs no new server event.
    return result;
};
codeBtn.addEventListener('click', joinByCode);
if (LEAN) {
    // The guest page: join only, with your account and profile.
    document.getElementById('lobbyCreate').hidden = true;
    const f = usernameInput.closest('.field'); if (f) f.hidden = true;
    document.querySelector('.lobby-or').hidden = true;
    document.getElementById('lobbyTitle').textContent = LOUNGE ? 'Join the lounge.' : 'Join your friends.';
    if (leanCode) codeInput.value = prettyCode(leanCode) || leanCode;
    const tag = document.getElementById('lobbyTagline'); if (tag) tag.textContent = 'Sign in with your Reddate account and pick a profile to join.';
    document.title = LOUNGE ? 'Lounge · Reddate' : 'Join a watch party · Reddate';
    if (LOUNGE && tag) tag.textContent = 'Sign in with your Reddate account and pick a profile to join the lounge: chat, voice and video.';
    // Once signed in with a profile, a code in the address joins by itself.
    const auto = () => { if (leanCode && !inRoom && accountName()) joinByCode(); };
    document.addEventListener('reddate:account-ready', auto);
    document.addEventListener('reddate:account', auto);
    if (FRAME) { let tries = 0; const t = setInterval(() => { if (inRoom || ++tries > 60) return clearInterval(t); auto(); }, 700); }
}
codeInput.addEventListener('keydown', e => { if (e.key === 'Enter') joinByCode(); });

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
    socket = io();
    // Alone, with no room on the server yet: what the room would have answered is answered here.
    const rawEmit = socket.emit.bind(socket);
    const QUIET_SOLO = new Set(['video-playpause', 'video-seek', 'video-progress', 'sync-request', 'buffering', 'typing-start', 'typing-stop', 'room-users-refresh']);
    const WANTS_ROOM = new Set(['invite-all', 'invite-device', 'party-setting']);
    socket.emit = (ev, ...args) => {
        if (inRoom && !roomLive) {
            if (WANTS_ROOM.has(ev)) goLive();
            else if (ev === 'load-video') {
                const d = args[0] || {};
                const kind = d.kind === 'direct' ? 'direct' : 'yt';
                const now = Date.now();
                const data = { videoId: kind === 'yt' ? String(d.videoId || '') : '', src: kind === 'direct' ? String(d.src || '') : '', kind, title: String(d.title || ''), content: kind === 'direct' ? (d.content || null) : null, isPlaying: false, currentTime: 0, lastUpdate: now, serverTime: serverNow(), user: currentUser };
                setTimeout(() => socket.listeners('video-loaded').forEach(f => f(data)), 0);
                return socket;
            } else if (QUIET_SOLO.has(ev)) return socket;
            else if (ev === 'send-message') { const ack = args[args.length - 1]; if (typeof ack === 'function') ack({ ok: true }); return socket; }
            else if (ev === 'room-check') { const ack = args[args.length - 1]; if (typeof ack === 'function') ack({ users: [] }); return socket; }
        }
        return rawEmit(ev, ...args);
    };

    socket.on('connect', () => {
        document.getElementById('connectionStatus').classList.remove('disconnected');
        document.getElementById('connectionText').textContent = 'Connected';
        sayHello(); // before joining: a party only takes signed-in people
        // Anything saved on your phone while this screen was offline (standby, a network blip) is taken now.
        if (window.reddateAccount && window.reddateAccount.refresh) setTimeout(() => window.reddateAccount.refresh(), 400);
        if (inRoom && roomLive) joinRoomNow();
        checkClock();
    });
    socket.on('vault-changed', () => { if (window.reddateAccount && window.reddateAccount.refresh) window.reddateAccount.refresh(); });
    socket.on('join-denied', d => {
        const messages = { locked: 'This room is locked by the host.', none: 'No party with that code right now.', code: d?.message || 'That room code is already in use.', busy: `${d?.name || 'That profile'} is already in this party on another device. Pick a different profile.`, profile: 'Pick a profile first, then join again.', signin: 'Sign in to join this party.' };
        finishJoin({ ok: false, message: messages[d?.reason] || 'Could not join the party.' });
        afterJoin = [];
        requireExistingRoom = false;
        inRoom = false;
        showScreen('lobby');
        if (d?.reason === 'code') { roomId = null; roomCode = ''; showToast(messages.code); return; }
        if (d && d.reason === 'locked') { showToast('This room is locked by the host'); return; }
        if (d && d.reason === 'none') { showToast('No party with that code right now.'); return; }
        if (d && d.reason === 'busy') {
            const m = `${d.name || 'That profile'} is already in this party on another device. Pick a different profile.`;
            showToast(m);
            if (window.ReddateNative && window.ReddateNative.event) { try { window.ReddateNative.event(JSON.stringify({ type: 'notice', text: m })); } catch (_) {} }
            return;
        }
        askToSignIn(d && d.reason === 'profile' ? 'Pick a profile first, then join again' : 'This party is for signed-in people. Sign in to join.');
    });
    socket.on('disconnect', () => {
        document.getElementById('connectionStatus').classList.add('disconnected');
        document.getElementById('connectionText').textContent = 'Disconnected';
    });

    socket.on('joined', data => {
        window.reddateBrowserSession.save({ roomId: data.roomId, roomCode: data.code, name: currentUser });
        roomCode = data.code || roomCode;
        requireExistingRoom = false;
        const codeEl = document.getElementById('roomCode');
        codeEl.textContent = roomCode ? `Room ${roomCode}` : '';
        codeEl.hidden = !roomCode;
        renderShareCode();
        finishJoin({ ok: true });
        if (window.reddateNativeInfo) window.reddateNativeInfo();
        addSystemMessage('Connected. Share the room code or invite link to bring someone in.');
        setTimeout(flushChat, 300); // anything typed while we were away
        const q = afterJoin; afterJoin = []; q.forEach(f => f());
    });
    socket.on('device-invite', onDeviceInvite);
    socket.on('party', onParty);
    socket.on('control-denied', () => noControl());
    socket.on('kicked', d => { showToast(`${(d && d.by) || 'The host'} removed you from the party`); leaveToHome(); });
    // Every host has gone: the party is over for everyone.
    socket.on('party-ended', d => {
        const msg = d && d.reason ? 'The party closed after 30 minutes of inactivity' : `${(d && d.host) || 'The host'} ended the party`;
        if (window.__nativeOpen && window.ReddateNative) window.ReddateNative.command(JSON.stringify({ cmd: 'toast', text: msg }));
        showToast(msg);
        leaveToHome();
        if (window.ReddateNative && window.ReddateNative.event) {
            window.ReddateNative.event(JSON.stringify({ type: 'notice', text: msg }));
            window.ReddateNative.event(JSON.stringify({ type: 'account' }));
        }
    });
    socket.on('connect', () => { party = null; }); // the server re-sends it when we rejoin
    socket.on('room-users', list => {
        roomUsers = Array.isArray(list) ? list : [];
        if (window.reddateNativeInfo) window.reddateNativeInfo();
    });
    socket.on('user-count', c => {
        userCount = c;
        document.getElementById('userCount').textContent = `${c} online`;
    });
    socket.on('system-message', d => {
        addSystemMessage(d.message);
        // On the TV's player: who came or went, as a short line that goes away by itself.
        const m = d && typeof d.message === 'string' ? /^(.{1,40}?) (joined the room|left the room)/.exec(d.message) : null;
        if (m && window.__nativeOpen && window.ReddateNative) {
            window.ReddateNative.command(JSON.stringify({ cmd: 'presence', text: `${m[1]} ${m[2] === 'left the room' ? 'left' : 'joined'}` }));
        }
    });

    socket.on('new-message', data => {
        if (!data || (data.t !== 'text' && data.t !== 'img') || typeof data.v !== 'string') return;
        addMessage(data, data.username, 'other');
        if (data.t === 'text') detectTriggers(data.v);
        noteUnread();
        document.dispatchEvent(new CustomEvent('reddate:chat', { detail: { user: data.username, t: data.t, v: data.v, self: false, reply: data.reply } }));
    });

    // A reaction sent from the Lounge: the TV fills its screen with it.
    socket.on('lounge', d => {
        if (d && d.k === 'burst' && typeof d.e === 'string' && d.id !== socket.id && window.__nativeOpen && window.ReddateNative) {
            window.ReddateNative.command(JSON.stringify({ cmd: 'burst', e: d.e.slice(0, 12), by: String(d.by || '').slice(0, 30) }));
        }
    });

    // The pinned message, for the TV's chat panel.
    socket.on('lounge-pin', p => {
        if (!window.__nativeOpen || !window.ReddateNative) return;
        window.ReddateNative.command(JSON.stringify({ cmd: 'pin', on: !!p, name: p ? String(p.name || '').slice(0, 40) : '', text: p ? String(p.text || '').slice(0, 200) : '', img: !!(p && p.img), by: p ? String(p.by || '').slice(0, 30) : '' }));
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
        // The TV's player shows it too, as "Sam is typing…" beside the picture.
        if (window.__nativeOpen && window.ReddateNative) {
            window.ReddateNative.command(JSON.stringify({ cmd: 'typing', user: String(data.username || 'Someone').slice(0, 30), on: !!data.isTyping }));
        }
    });

    wireVideoEvents();
    wireControls();

    // Hand the connected socket to the voice room (voice.js).
    if (window.initVoice && !document.documentElement.classList.contains('tv')) window.initVoice(socket, showToast);

    // Addon browser (addons.js).
    if (window.initAddons) window.initAddons(socket, { getRoomId: () => roomId, toast: showToast });
}


// ---------------- Chat ----------------
const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // 2 MB cap on uploads

// A message is { t: 'text' | 'img', v: <string> }: text, or an image as a data URL / https link.
function sendChat(msg) {
    if (!socket) return;
    if (LOUNGE) { msg.mid = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); if (window.loungeReply) { const r = window.loungeReply.take(); if (r) msg.reply = r; } }
    addMessage(msg, currentUser, 'self');
    if (msg.t === 'text') detectTriggers(msg.v);
    chatOutbox.push({ msg, sending: false });
    flushChat();
    document.dispatchEvent(new CustomEvent('reddate:chat', { detail: { user: currentUser, t: msg.t, v: msg.v, self: true, reply: msg.reply } }));
}
// For the TV: send a chat line typed on the TV's keyboard.
window.reddateChat = { send: text => { const v = String(text || '').trim().slice(0, 2000); if (v && inRoom) sendChat({ t: 'text', v }); } };

async function sendMessage() {
    const input = document.getElementById('messageInput');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    socket.emit('typing-stop');
    sendChat({ t: 'text', v: text });
}

// A picture is sent as one message, so it is shrunk first: the longest side to 1280 px, as a JPEG, under about 700 KB.
// (A big original used to be larger than the connection allows and threw the sender out of the room.)
const IMAGE_SEND_MAX = 700 * 1024;
function shrinkImage(file) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
            URL.revokeObjectURL(url);
            let side = 1280, q = 0.82;
            for (let i = 0; i < 6; i++) {
                const k = Math.min(1, side / Math.max(img.width, img.height));
                const c = document.createElement('canvas');
                c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
                const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(img, 0, 0, c.width, c.height);
                const out = c.toDataURL('image/jpeg', q);
                if (out.length * 0.75 <= IMAGE_SEND_MAX) return resolve(out);
                side = Math.round(side * 0.8); q = Math.max(0.5, q - 0.08);
            }
            reject(new Error('too big'));
        };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('unreadable')); };
        img.src = url;
    });
}
function sendImageFromFile(file) {
    if (!file) return;
    if (!file.type.startsWith('image/')) { showToast('Please pick an image or GIF'); return; }
    if (file.size > 12 * 1024 * 1024) { showToast('That picture is too large (max 12 MB)'); return; }
    if (file.type === 'image/gif') {
        // An animated GIF can't be shrunk here; small ones go as they are.
        if (file.size > IMAGE_SEND_MAX) { showToast('That GIF is too large to send (max 700 KB). Try one from the GIF button.'); return; }
        const reader = new FileReader();
        reader.onload = () => sendChat({ t: 'img', v: reader.result });
        reader.readAsDataURL(file);
        return;
    }
    showToast('Sending picture…');
    shrinkImage(file).then(v => sendChat({ t: 'img', v })).catch(() => showToast('Couldn’t send that picture. Try another one.'));
}

// ---------------- GIF picker (GIPHY) ----------------
// Opens on trending GIFs, searches as you type, loads more as you scroll, and
// sends the picked GIF through chat like any image.
// GIPHY requires these calls to come from the browser; searches are visible to
// GIPHY — the picker says so.
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
    if (msg.mid) div.dataset.mid = msg.mid;
    if (msg.reply && msg.reply.name) {
        const q = document.createElement('div');
        q.className = 'reply-quote'; q.dataset.mid = msg.reply.mid || '';
        const qn = document.createElement('b'); qn.textContent = msg.reply.name;
        q.append(qn, document.createTextNode(' ' + (msg.reply.text || '')));
        div.insertBefore(q, body);
    }
    if (msg.t === 'img') {
        const img = document.createElement('img');
        img.alt = 'shared image';
        img.loading = 'lazy';
        // data URL (uploaded) or https link (GIF); anything else is dropped
        if (/^(https:\/\/|data:image\/(png|jpeg|gif|webp);base64,)/.test(msg.v)) { img.src = msg.v; body.appendChild(img); }
        else body.textContent = '[image]';
    } else {
        body.textContent = msg.v;  // textContent — never innerHTML, avoids injection
    }
    chat.appendChild(div);
    chat.scrollTop = chat.scrollHeight;
    document.dispatchEvent(new CustomEvent('lounge:message', { detail: { div, msg, kind, username } }));
    return div;
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

// While a stream loads, the player shows the title's artwork instead of a black box.
let nextCover = null;
let currentContent = null; // { type, id, filename } of an addon title, for subtitles
let lastLoaded = null;      // the room's video as last announced, to rebuild the room if the server restarts
let roomSubtitle = null;
let roomAudio = null;
let subtitleRevision = 0;

function setSubtitleMedia(data) {
    if (data.mediaId !== lastLoaded?.mediaId) {
        roomSubtitle = null;
        roomAudio = null;
        subtitleRevision = 0;
        window.tracks?.setMedia(data.mediaId, data.src);
    }
    window.tracks?.setSettingsOwner(ownsRoomSettings(data));
}

function ownsRoomSettings(data = lastLoaded) {
    return !!(party ? isHost() : data?.settingsOwner === socket?.id);
}

function shareRoomSubtitle({ mediaId, state }) {
    if (!roomLive || !inRoom || !ownsRoomSettings()) return;
    if (!socket?.connected || mediaId !== lastLoaded?.mediaId) { showToast('Reconnect to the room before changing subtitles.'); return; }
    socket.timeout(10000).emit('set-subtitles', { mediaId, state }, (error, result) => {
        if (error || !result?.ok) showToast(result?.message || 'The subtitle could not be shared. Try again.');
    });
}

function shareRoomAudio({ mediaId, state }) {
    if (!roomLive || !inRoom || !ownsRoomSettings() || mediaId !== lastLoaded?.mediaId) return;
    socket.timeout(8000).emit('set-audio', { mediaId, state }, (error, result) => {
        if (error || !result?.ok) showToast('Could not share the starting audio language.');
    });
}

// Rejoin our room. After a server restart the room is gone; whoever comes back first brings it back as it was
// (what's on, where it was, who hosts), so nobody has to start again.
function joinRoomNow() {
    if (!socket || !roomId) return;
    const v = lastLoaded;
    const restore = v && (v.src || v.videoId) ? {
        kind: v.kind, src: v.src, videoId: v.videoId, title: v.title, content: v.content,
        currentTime: Math.max(0, roomPos()), isPlaying: !!anchor.isPlaying, host: !!(party ? isHost() : true)
    } : null;
    socket.emit('join-room', { roomId, username: currentUser, restore, requireExisting: requireExistingRoom, resumeId: window.reddateBrowserSession.clientId() });
}

// Chat lines wait until the server confirms them: one typed during a reconnect is sent again once we're back.
const chatOutbox = [];
function flushChat() {
    if (!socket || !socket.connected || !inRoom) return;
    chatOutbox.slice().forEach(item => {
        if (item.sending) return;
        item.sending = true;
        socket.timeout(6000).emit('send-message', item.msg, (err, r) => {
            item.sending = false;
            if (!err && r && r.ok) { const i = chatOutbox.indexOf(item); if (i >= 0) chatOutbox.splice(i, 1); }
        });
    });
}
setInterval(flushChat, 3000);
let roomUsers = [];        // [{ id, name, buffering }]
function showCover() {
    hideCover();
    const c = nextCover || {};
    const cover = document.createElement('div');
    cover.className = 'player-cover';
    cover.id = 'playerCover';
    if (c.art) cover.style.setProperty('--cover-image', `url("${String(c.art).replace(/"/g, '%22')}")`);
    const text = document.createElement('div');
    text.className = 'cover-text';
    if (c.title) { const t = document.createElement('div'); t.className = 'cover-title'; t.textContent = c.title; text.appendChild(t); }
    const st = document.createElement('div');
    st.className = 'cover-status';
    st.innerHTML = '<span class="spinner"></span>';
    st.append('Loading stream…');
    text.appendChild(st);
    cover.appendChild(text);
    stageEl().parentElement.appendChild(cover);
}
function coverMessage(msg) {
    const st = document.querySelector('#playerCover .cover-status');
    if (st) { st.textContent = msg; st.classList.add('is-error'); }
}
function hideCover() {
    const c = document.getElementById('playerCover');
    if (c) c.remove();
}

function destroyPlayer() {
    if (typeof currentDuration !== 'undefined') currentDuration = 0;
    if (vp && vp.destroy) { try { vp.destroy(); } catch (_) {} }
    vp = null;
    isPlayerReady = false;
    stageEl().innerHTML = '';
    hideCover();
    setPlayerStatus('');
    if (window.tracks) window.tracks.detach(); // subtitles / audio tracks (tracks.js)
}

function setPlayerStatus(text) { document.getElementById('playerStatus').textContent = text; }

// ---------------- Your devices ----------------
// Signed in on several devices? Each tells the server who it is, so the invite card can list your
// other open devices and send them "come watch this with me".
function sayHello() {
    const A = window.reddateAccount;
    const token = A && A.sessionToken && A.sessionToken();
    if (!socket || !socket.connected || !token) return;
    const N = window.ReddateNative;
    const device = FRAME ? FRAME_DEV : (N && N.deviceName ? N.deviceName() : (A.deviceName ? A.deviceName() : 'Browser'));
    socket.emit('hello', { token, device, profile: A.profileName() || '', embed: FRAME });
}
document.addEventListener('reddate:account', sayHello);
document.addEventListener('reddate:account-ready', sayHello);
window.reddateDevices = {
    list: () => new Promise(resolve => {
        if (!socket || !socket.connected) { resolve([]); return; }
        const t = setTimeout(() => resolve([]), 4000);
        socket.emit('my-devices', {}, list => { clearTimeout(t); resolve(Array.isArray(list) ? list : []); });
    }),
    invite: id => socket.emit('invite-device', { to: id })
};
function onDeviceInvite(d) {
    if (!d || typeof d.roomId !== 'string' || d.roomId === roomId) return;
    const N = window.ReddateNative;
    if (N && N.hasNativeUi && N.event) { N.event(JSON.stringify({ type: 'invite', ...d })); return; } // the TV app shows its own pop-up
    const what = d.title ? `“${d.title}”` : 'something';
    const home = window.reddateHome;
    const join = () => answerInvite(d.roomId, true);
    const no = () => answerInvite(d.roomId, false);
    if (home && home.confirm) home.confirm(`${d.from || 'You'} invites you to watch together`, `${what}, from ${d.device || 'another device'}.`, 'Join', join, no);
    else if (confirm(`${d.from} invites you to watch ${what} together. Join?`)) join(); else no();
}
// Yes: go straight to what they're watching. No: they're told.
function answerInvite(id, accept) {
    socket.emit('invite-answer', { roomId: id, accept });
    if (accept) enterRoom(savedName() || currentUser, id);
}
window.reddateDevices.answer = answerInvite;
window.reddateDevices.inviteAll = () => socket.emit('invite-all');

// ---------------- Watch party (host controls playback) ----------------
let party = null; // { host, hostName, away, max } when this room is a watch party
const isHost = () => !party || party.host === (socket && socket.id) || (Array.isArray(party.hosts) && !!socket && party.hosts.includes(socket.id));
function noControl() {
    const msg = party && party.away ? 'The host is reconnecting. Hang on a moment.' : `Only ${party ? party.hostName : 'the host'} controls playback in this watch party`;
    showToast(msg);
    if (window.__nativeOpen && window.ReddateNative) window.ReddateNative.command(JSON.stringify({ cmd: 'toast', text: msg }));
}
// Guests in a watch party control their own player: pausing or seeking only affects them, and they
// drift "out of sync" until they press Sync (or say yes when asked). The host's actions move everyone
// who is still in sync.
let detached = false;   // this guest has gone their own way
let pendingLoaded = null; // the host's new video, waiting for this guest's answer
let handleLoadedRef = null; // set up with the video events
let askedAt = 0;        // when we last asked "sync with the host?"
const clockText = sec => { const t = Math.max(0, Math.floor(sec)); const h = Math.floor(t / 3600); return `${h ? h + ':' : ''}${String(Math.floor(t / 60) % 60).padStart(h ? 2 : 1, '0')}:${String(t % 60).padStart(2, '0')}`; };
// Never further than the video is long (a room left "playing" for hours would say it's hours ahead).
const behindBy = () => (vp ? Math.min(roomPos(), currentDuration > 0 ? currentDuration : Infinity) - vp.getCurrentTime() : 0);

function renderShareCode() {
    document.getElementById('shareRoomCode').textContent = roomCode;
    document.getElementById('roomShare').hidden = !roomLive || !roomCode;
}
function renderRoomChip() {
    const codeEl = document.getElementById('roomCode');
    const base = prettyCode(roomId) ? `Room ${prettyCode(roomId)}` : '';
    const bits = [base];
    if (party) bits.push(`👑 ${party.away ? 'host reconnecting' : party.hostName}`);
    if (party && !isHost() && detached) bits.push('Not synced');
    codeEl.textContent = bits.filter(Boolean).join(' · ');
    codeEl.hidden = !codeEl.textContent;
    renderShareCode();
}
function setDetached(on) {
    if (detached === on) return;
    detached = on;
    renderRoomChip();
    if (on) {
        const msg = `You’re not synced with ${party ? party.hostName : 'the host'}. Press Sync to catch up.`;
        showToast(msg);
        if (window.__nativeOpen && window.ReddateNative) window.ReddateNative.command(JSON.stringify({ cmd: 'toast', text: msg }));
    }
    if (window.reddateNativeInfo) window.reddateNativeInfo();
}
// Back in step with the host.
function resync() {
    if (!vp || !isPlayerReady) return;
    setDetached(false);
    fixes = []; fixGap = 8000; seekFails = 0;
    applyAnchor();
}
// A guest who has been off on their own presses play again: offer to rejoin the room.
function maybeAskSync() {
    if (!party || isHost() || !detached || !vp) return;
    if (Date.now() - askedAt < 20000) return;
    const behind = behindBy();
    if (Math.abs(behind) < 5) { resync(); return; } // basically there: just step back in
    askedAt = Date.now();
    const host = party.hostName || 'the host';
    const at = clockText(roomPos());
    if (window.__nativeOpen && window.ReddateNative) {
        window.ReddateNative.command(JSON.stringify({ cmd: 'ask-sync', host, at }));
        return;
    }
    const home = window.reddateHome;
    if (home && home.confirm) home.confirm(`Sync with ${host}?`, `${host} is at ${at}.`, 'Sync', resync, () => {});
    else if (confirm(`Sync with ${host}? ${host} is at ${at}.`)) resync();
}
function leaveToHome() {
    window.reddateBrowserSession.clear();
    destroyPlayer();
    try { if (typeof theater !== 'undefined' && theater) setTheater(false); } catch (e) { /* fine */ }
    setNowPlaying('');
    inRoom = false; roomLive = true; party = null; detached = false; roomId = null; roomCode = ''; requireExistingRoom = false;
    renderShareCode();
    history.replaceState(null, '', `${location.pathname}${location.search}`);
    showScreen(document.documentElement.classList.contains('tv') ? 'home' : 'lobby');
}

let behindPinged = false;
setInterval(() => {
    if (!window.reddateNativeInfo) return;
    // Also tell the TV when a guest has fallen behind while still "synced", so it can offer one-press catch-up.
    const behindNow = !!(party && !isHost() && behindBy() >= 3);
    if (detached || behindNow || behindPinged) window.reddateNativeInfo();
    behindPinged = behindNow;
}, 1000);

function onParty(p) {
    party = p && typeof p === 'object' ? p : null;
    if (!party) detached = false;
    renderRoomChip();
    if (window.reddateNativeInfo) window.reddateNativeInfo();
}

// ---------------- Sync ----------------
// The room has one "anchor": the position at a moment in server time, and whether it's playing.
// Every player steers itself toward it. Nobody's player is ever pulled to someone else's position,
// so a viewer on a slow connection catches up on their own instead of dragging the room back, and
// two players can't bounce corrections off each other.
let anchor = { isPlaying: false, currentTime: 0, at: 0 }; // `at` is server time (ms)
let clockOffset = 0, bestRtt = Infinity;
const serverNow = () => Date.now() + clockOffset;
function checkClock() {
    const t0 = Date.now();
    socket.emit('time', {}, st => {
        const t1 = Date.now();
        if (typeof st !== 'number' || t1 - t0 > Math.max(bestRtt * 2, 400)) return; // a slow round trip says little
        bestRtt = Math.min(bestRtt, t1 - t0);
        clockOffset = st - (t0 + t1) / 2;
    });
}
function setAnchor(isPlaying, currentTime, at) {
    anchor = { isPlaying: !!isPlaying, currentTime: Math.max(0, Number(currentTime) || 0), at: at || serverNow() };
}
function roomPos() { return anchor.isPlaying ? anchor.currentTime + (serverNow() - anchor.at) / 1000 : anchor.currentTime; }

// Our own commands to the player take a moment to settle; events in that window are ours, not the viewer's.
let steerUntil = 0;
// Players can take seconds to finish a seek or a pause on a big file, so our own steering is ignored for a while.
function steer(fn) { steerUntil = Date.now() + 4000; fn(); }
// Did the viewer do this? The TV's player says so itself; in a browser, only a click or key press just before counts.
let lastUserInput = 0;
['pointerdown', 'keydown', 'touchstart'].forEach(ev => document.addEventListener(ev, () => { lastUserInput = Date.now(); }, true));
const byViewer = () => (vp && vp.kind === 'native') || Date.now() - lastUserInput < 2500;

// Bring the player in line with the anchor (a remote play/pause/seek, joining, or the player just got ready).
function applyAnchor() {
    if (!vp || !isPlayerReady) return;
    isVideoPlaying = anchor.isPlaying;
    updatePlayPauseButton();
    const target = roomPos();
    steer(() => {
        if (Math.abs(vp.getCurrentTime() - target) > 1) {
            // While the room plays on, a jump takes a moment to start here: aim that far ahead (learned from past jumps).
            if (anchor.isPlaying) { pendingSeekAt = Date.now(); seekAim = target + seekLag / 1000; vp.seekTo(seekAim); } else vp.seekTo(target);
        }
        anchor.isPlaying ? vp.play() : vp.pause();
    });
}
// How long a jump takes on this device before the picture moves again. Learned from each jump, so a slow phone
// aims further ahead than a fast computer. A guest who lands ahead waits (paused) for the room instead of jumping back.
let seekLag = 2500, pendingSeekAt = 0, holdUntil = 0, seekAim = 0, seekFails = 0;
// A video this viewer just started (from the TV app's Play) begins playing as soon as it's ready.
let autoPlayOnReady = false;
window.reddateAutoPlayNext = () => { autoPlayOnReady = true; };
let resumeAt = 0; // continue watching: where to start the next video this viewer starts
window.reddateResumeAt = sec => { resumeAt = Math.max(0, Number(sec) || 0); };
function applyPending() {
    applyAnchor();
    if (autoPlayOnReady && isHost() && !anchor.isPlaying) {
        autoPlayOnReady = false;
        const at = resumeAt; resumeAt = 0;
        setTimeout(() => {
            if (!vp || !isPlayerReady) return;
            if (at > 5) { // pick up where you left off, for everyone in the room
                steer(() => vp.seekTo(at));
                setAnchor(false, at);
                socket.emit('video-seek', { currentTime: at });
            }
            if (!isVideoPlaying) togglePlayPause();
        }, 300);
    } else autoPlayOnReady = false;
}

// The closest match to what you played before (if it's a good one), else the first (best quality).
function pickRemembered(list) {
    const best = list.reduce((b, s) => (s.match > b.match ? s : b), list[0]);
    return best.match >= 9 ? best : list[0];
}
window.reddatePickRemembered = pickRemembered;
// Play the next episode by itself when one ends (on unless the viewer turned it off).
const autoNextOn = () => !window.reddatePrefs || window.reddatePrefs.get('autoNext', true) !== false;

// ---------------- Continue watching ----------------
// Each profile keeps where it got to in each movie or show (newest first, 12 at most). Shows keep
// one entry, for the episode you're on. Saved with the profile, so it follows you to other devices.
let currentDuration = 0; // seconds, when the player knows it
window.reddateContinue = (function () {
    const P = () => window.reddatePrefs;
    const list = () => (P() ? P().get('cw', []) || [] : []);
    const blocked = new Set();
    // Unsaved progress belongs to the profile it was made in: if the profile changed meanwhile, it is dropped
    // rather than written into (or shown in) someone else's list.
    const who = () => (window.reddateAccount && window.reddateAccount.activeProfileId ? window.reddateAccount.activeProfileId() : null) || '';
    let pending = null, pendingWho = '', timer = null;
    const mine = () => (pending && pendingWho === who() ? pending : null);
    const flush = () => { timer = null; const l = mine(); pending = null; if (l) P().set('cw', l); };
    const save = l => { pending = l.slice(0, 12); pendingWho = who(); if (!timer) timer = setTimeout(flush, 20000); };
    function upsert(e) {
        const l = (mine() || list()).filter(x => x.k !== e.k);
        l.unshift(e);
        save(l);
    }
    return {
        list: () => (mine() || list()).filter(e => e.p > 30 || e.next).map(e => ({ ...e })),
        record(c, label, pos, dur) {
            if (!c || !c.id || !(pos > 0)) return;
            const k = c.show || c.id;
            if (blocked.has(k)) return;
            if (dur > 0 && pos / dur > 0.93) return; // nearly done: handled when it ends
            const was = (mine() || list()).find(x => x.k === k);
            const keepNext = was && was.next && was.id === c.id && pos < 30; // just started the next episode: still "Up next"
            upsert({ k, id: c.id, t: c.type, sh: c.show || '', n: String(label || '').slice(0, 80), a: c.art || '', p: Math.round(pos), d: Math.round(dur || 0), at: Date.now(), ...(keepNext ? { next: 1 } : {}) });
        },
        finished(c, next) { // next = { id, label } for a show's following episode
            if (!c) return;
            const k = c.show || c.id;
            if (next) upsert({ k, id: next.id, t: 'series', sh: c.show, n: next.label, a: c.art || '', p: 0, d: 0, at: Date.now(), next: 1 });
            else { save((mine() || list()).filter(x => x.k !== k)); }
            flush();
        },
        // Removed on purpose: not recorded again until that title is started afresh (a room still "playing" it
        // would otherwise put it straight back a few seconds later).
        remove(k) { blocked.add(k); save((mine() || list()).filter(x => x.k !== k)); flush(); },
        unblock(k) { blocked.delete(k); },
        flush
    };
})();
setInterval(() => {
    if (!vp || !isPlayerReady || !isVideoPlaying || !currentContent || (party && !isHost() && false)) return;
    const dur = currentDuration || (vp.duration ? vp.duration() : 0);
    if (!(dur > 0)) return; // a live stream has no place to come back to
    window.reddateContinue.record(currentContent, document.getElementById('nowPlaying').textContent, vp.getCurrentTime(), dur);
}, 15000);
window.addEventListener('pagehide', () => window.reddateContinue.flush());

// The player says it started or stopped. Only news if it differs from what the room is doing.
function onPlayerPlayPause(playing) {
    if (!vp || Date.now() < steerUntil) return;
    if (party && !isHost()) {
        // A guest. If the host allows it, their pause or play is everyone's (like a shared remote).
        // Anything the player did by itself (buffering, a slow seek) is not theirs: back to the room.
        if (playing === anchor.isPlaying) return;
        if (!byViewer()) { applyAnchor(); return; }
        if (!party.guestsCanPause) { noControl(); applyAnchor(); return; }
    }
    if (playing === anchor.isPlaying) return;
    const t = vp.getCurrentTime();
    setAnchor(playing, t);
    isVideoPlaying = playing;
    updatePlayPauseButton();
    socket.emit('video-playpause', { isPlaying: playing, currentTime: t });
}
// The viewer moved the playhead.
function onPlayerSeek(t) {
    if (party && !isHost()) { // seeking stays with the host: a guest's jump is undone
        if (Math.abs(t - roomPos()) >= 1.5 && byViewer()) { noControl(); applyAnchor(); }
        return;
    }
    if (Math.abs(t - roomPos()) < 1.5) return; // where the room already is
    setAnchor(anchor.isPlaying, t);
    steerUntil = Math.max(steerUntil, Date.now() + 5000); // no automatic corrections while a far jump settles
    fixes = []; fixGap = 8000;
    socket.emit('video-seek', { currentTime: t });
}

// Once a second: steer toward the anchor. Small drift on a video file is fixed by playing a touch
// faster or slower (invisible); bigger drift by a seek, with back-off so a struggling connection
// isn't sent into a buffer-seek-buffer loop.
let buffering = false, bufferStart = 0, lastBufferMs = 0, bufferTold = false;
let lastFix = 0, fixGap = 8000, fixes = [], slowWarned = false, lastSample = null;
function setBuffering(on) {
    if (on === buffering) return;
    buffering = on;
    if (on) bufferStart = Date.now();
    else {
        lastBufferMs = Date.now() - bufferStart;
        if (bufferTold) { bufferTold = false; socket.emit('buffering', { on: false }); }
    }
}
function driftTick() {
    if (!vp || !isPlayerReady) { lastSample = null; return; }
    const now = Date.now();
    const pos = vp.getCurrentTime();
    const advancing = vp.isAdvancing ? vp.isAdvancing() : isVideoPlaying;
    // Tell the room when we've been stuck loading for a while.
    if (buffering && !bufferTold && now - bufferStart > 2500 && anchor.isPlaying) { bufferTold = true; socket.emit('buffering', { on: true }); }
    // YouTube doesn't report the viewer's seeks, so spot jumps the clock can't explain.
    if (vp.kind === 'yt' && lastSample && now > steerUntil) {
        const predicted = lastSample.pos + (lastSample.advancing ? (now - lastSample.t) / 1000 : 0);
        if (Math.abs(pos - predicted) > 3) onPlayerSeek(pos);
    }
    lastSample = { pos, t: now, advancing };
    if (pendingSeekAt && advancing && !buffering) {
        const lag = now - pendingSeekAt;
        // A jump that landed far from where it was aimed: this stream can't seek (no index), it starts over instead.
        if (seekAim && Math.abs(pos - seekAim) > 15) seekFails++;
        else if (lag < 30000) { seekLag = Math.min(15000, Math.max(800, seekLag * 0.5 + lag * 0.5)); seekFails = 0; }
        pendingSeekAt = 0; seekAim = 0;
        if (seekFails >= 2 && !detached && party && !isHost()) {
            setDetached(true);
            showToast('This stream can’t jump to where the party is, so you’re watching from here. Try another stream to stay in sync.');
            if (window.__nativeOpen && window.ReddateNative) window.ReddateNative.command(JSON.stringify({ cmd: 'toast', text: 'This stream can’t skip ahead, so you’re watching from here.' }));
        }
    }
    if (now < holdUntil) return; // waiting for the room to reach us

    if (detached) { if (vp.setRate) vp.setRate(1); return; } // their own pace
    // A live stream has no shared position to keep in step: everyone is at "now".
    if (vp.kind === 'native' && isPlayerReady && !(currentDuration > 0)) { if (vp.setRate) vp.setRate(1); return; }
    if (!anchor.isPlaying || !advancing || buffering || now < steerUntil) { if (vp.setRate) vp.setRate(1); return; }
    const drift = pos - roomPos(); // + ahead, - behind
    const off = Math.abs(drift);
    // A guest ahead of the room: pause just long enough for it to arrive (exact, and no rebuffering).
    if (drift > 0.8 && drift < 15 && party && !isHost()) {
        if (vp.setRate) vp.setRate(1);
        holdUntil = now + drift * 1000;
        steer(() => vp.pause());
        setTimeout(() => { if (vp && anchor.isPlaying && !detached) steer(() => vp.play()); }, drift * 1000);
        return;
    }
    if (vp.setRate) {
        if (off > 0.4 && off < 5) { vp.setRate(drift < 0 ? (off > 1.5 ? 1.15 : 1.08) : 0.93); return; }
        vp.setRate(1);
    }
    // The host (or someone watching alone) is the room's truth: far ahead of the anchor can only mean they
    // moved the playhead themselves, so the room follows them. Never drag them back to where they were.
    // The one leading (a party's host, or someone on their own) is the room's truth, ahead or behind: the room follows
    // their picture and theirs is never pulled around (pulling it is what looped a stream that can't seek).
    const leads = party ? isHost() : roomUsers.length <= 1;
    if (off >= (vp.setRate ? 5 : 3.5) && leads) { onPlayerSeek(pos); return; }
    if (seekFails >= 2) return; // this stream can't seek: don't keep throwing it back to the start
    if (off < (vp.setRate ? 5 : 3.5) || now - lastFix < fixGap) return;
    // Behind usually means slow loading: aim a little ahead to cover the time the jump takes to buffer.
    const lead = drift < 0 ? seekLag / 1000 : 0;
    lastFix = now;
    fixes = fixes.filter(t => now - t < 60000);
    fixes.push(now);
    fixGap = fixes.length >= 3 ? Math.min(60000, fixGap * 2) : 8000;
    if (fixes.length >= 3 && !slowWarned) {
        slowWarned = true;
        showToast('Your connection is struggling, so you may run a few seconds behind. Press Sync to catch up.');
    }
    if (lead) { pendingSeekAt = now; seekAim = roomPos() + lead; }
    steer(() => vp.seekTo(roomPos() + lead));
}
setInterval(driftTick, 1000);

// The tab or window is closing (or leaving for another page): say goodbye now, so the others' count drops at once
// instead of a minute later. Nothing is lost: a page restored from the back button reconnects and rejoins.
window.addEventListener('pagehide', () => {
    if (inRoom && roomLive && socket && socket.connected) socket.emit('bye');
});
// Tell the room's trail when this page is paused, hidden or offline: a dropped connection can then be explained.
['visibilitychange', 'freeze', 'resume', 'pagehide', 'pageshow', 'online', 'offline'].forEach(ev => {
    const target = ev === 'online' || ev === 'offline' || ev === 'pagehide' || ev === 'pageshow' ? window : document;
    target.addEventListener(ev, () => {
        if (inRoom && roomLive && socket && socket.connected) socket.emit('diag', { why: ev, state: document.visibilityState });
    });
});
// Self-heal: every few seconds make sure the server still has us in our room; rejoin if not.
setInterval(() => {
    if (!inRoom || !roomLive || !socket || !socket.connected || !roomId) return;
    socket.emit('room-check', {}, r => {
        if (r && r.roomId === roomId) {
            // In the room, but the list on screen disagrees with the server's: ask for the real one.
            const mine = roomUsers.map(u => u.id).sort().join();
            if (Array.isArray(r.users) && r.users.slice().sort().join() !== mine) socket.emit('room-users-refresh');
            return;
        }
        if (window.__devlog) window.__devlog('room-rejoin', { want: roomId, server: r && r.roomId });
        joinRoomNow();
    });
}, 4000);

function createYouTubePlayer(videoId) {
    // A host app that has its own player (the browser app) plays YouTube there, with the same controls as
    // any other video, instead of in this hidden page.
    if (window.ReddateNative && window.ReddateNative.hasYouTube && window.ReddateNative.hasYouTube()) { createNativePlayer(videoId, { yt: true }); return; }
    if (!window.YT || !YT.Player) { setTimeout(() => createYouTubePlayer(videoId), 300); return; }
    destroyPlayer();
    if (window.tracks) window.tracks.attachYouTube();
    currentSrc = videoId;
    const mount = document.createElement('div');
    stageEl().appendChild(mount);
    let ytState = -1;
    const yt = new YT.Player(mount, {
        height: '100%', width: '100%', videoId,
        playerVars: { autoplay: 0, controls: 1, rel: 0, modestbranding: 1 },
        events: {
            onReady: () => { isPlayerReady = true; updatePlayPauseButton(); applyPending(); },
            onStateChange: (e) => {
                ytState = e.data;
                setBuffering(e.data === YT.PlayerState.BUFFERING);
                if (e.data === YT.PlayerState.PLAYING || e.data === YT.PlayerState.PAUSED) onPlayerPlayPause(e.data === YT.PlayerState.PLAYING);
            }
        }
    });
    vp = {
        kind: 'yt',
        isAdvancing: () => ytState === YT.PlayerState.PLAYING,
        getCurrentTime: () => (yt.getCurrentTime ? yt.getCurrentTime() : 0) || 0,
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

// Inside the Android TV app: play through the app's native player (ExoPlayer) instead of the
// browser's <video>, so MKV, HEVC, Dolby Digital and the like work. The room logic doesn't change:
// this fills the same `vp` adapter. Events the viewer causes (remote presses) are broadcast; events
// caused by room commands arrive marked `echo` and are not.
// The streams lined up for the episode that's starting: the first that plays wins.
let episodeFallback = null;
function loadEpisodeStream() {
    const f = episodeFallback;
    const s = f && f.list[f.i];
    if (!s || !socket) return;
    socket.emit('load-video', { kind: 'direct', src: s.url, title: f.label, content: { type: 'series', id: f.id, filename: (s.filename || s.title || '').slice(0, 200), art: f.art, show: f.show } });
}

function createNativePlayer(src, opts) {
    const isYt = !!(opts && opts.yt);
    destroyPlayer();
    currentSrc = src;
    const N = window.ReddateNative;
    const sid = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`; // this playback session
    let pos = 0, at = Date.now(), playing = false, closed = false, nativeBuffering = false, nativeRate = 1;
    const now = () => (playing && !nativeBuffering ? pos + Math.min(2, (Date.now() - at) / 1000) * nativeRate : pos);
    const mark = (sec, isPlaying) => { pos = sec; at = Date.now(); if (isPlaying !== undefined) playing = isPlaying; };
    // Tell the account's connected trackers (Trakt, WeTrakr, Simkl) what is playing: started, paused, stopped. Only titles they
    // know (an IMDb or TMDB id), never a bare link or a YouTube video.
    let lastTrack = '', lastTrackAt = 0, tracking = false;
    const track = (action, progressOverride) => {
        try {
            const A = window.reddateAccount, c = currentContent;
            if (!A || !A.isSignedIn || !A.isSignedIn() || !A.api || !c || !c.id || !currentDuration) return;
            const key = `${action}:${c.id}`, t = Date.now();
            if (key === lastTrack && t - lastTrackAt < 1500) return; // the same news twice in a row
            lastTrack = key; lastTrackAt = t;
            if (action === 'start') tracking = true;
            if (action === 'stop') tracking = false;
            const progress = progressOverride !== undefined ? progressOverride : Math.max(0, Math.min(100, (now() / currentDuration) * 100));
            A.api('/api/trackers/scrobble', { method: 'POST', body: { action, type: c.type, id: c.id, progress } });
        } catch (e) { /* trackers are a bonus: never get in the way of playing */ }
    };
    // The title is the new video's own name (none for a bare link), never the previous one's.
    const open = (startSec, playWhenReady) => {
        closed = false;
        window.__nativeOpen = true;
        if (window.__devlog) window.__devlog('native-open', { sid, startSec, playWhenReady });
        const subPref = window.tracks ? window.tracks.getPref() : '';
        const chatOn = window.ReddateTV && window.ReddateTV.chatOn ? window.ReddateTV.chatOn() : true;
        N.open(JSON.stringify({ sid, url: isYt ? `https://www.youtube.com/watch?v=${src}` : src, kind: isYt ? 'yt' : 'direct', videoId: isYt ? src : undefined, art: art || '', title: nextCover ? (nextCover.title || '') : (document.getElementById('nowPlaying').textContent || ''), startMs: Math.round(startSec * 1000), playWhenReady, subPref, chatOn }));
        setTimeout(sendInfo, 800);
    };

    // What the TV player's options need: the invite, who's here, online subtitles, and the show's episodes.
    let subs = [], subsLoading = !!currentContent, episodes = [], showName = '';
    const sendInfo = () => {
        if (closed || currentSrc !== src) return;
        const info = {
            // The code is shown only in the invite panel, whose device list (below) is what makes the room real.
            room: prettyCode(roomId) || roomId || '',
            live: !!roomLive, // a real room on the server (a party); watching alone is private until then
            invite: roomId ? `${window.reddateWebOrigin || location.origin}/join/${encodeURIComponent(roomCode || roomId)}` : '',
            people: roomUsers.map(u => ({ id: u.id, name: u.name, you: (u.ids || [u.id]).includes(socket.id), buffering: !!u.buffering, host: !!(party && (u.ids || [u.id]).some(i => party.host === i || (Array.isArray(party.hosts) && party.hosts.includes(i)))), main: !!(party && (u.ids || [u.id]).includes(party.host)) })).sort((a, b) => b.you - a.you),
            subs, subsLoading, roomSubtitle, roomAudio, isSettingsOwner: ownsRoomSettings(),
            subPref: window.tracks ? window.tracks.getPref() : '',
            episodes, current: currentContent ? currentContent.id : '', show: currentContent ? (currentContent.show || '') : '', showName, autoNext: autoNextOn(),
            hostOnly: !!party, isHost: isHost(), isMain: !!(party && socket && party.host === socket.id), hostName: party ? party.hostName : '', guestsCanPause: !!(party && party.guestsCanPause),
            detached: !!(party && !isHost() && detached), behind: Math.round(Math.max(0, behindBy()))
        };
        N.command(JSON.stringify({ cmd: 'info', info }));
    };
    window.reddateNativeInfo = sendInfo;
    if (currentContent && window.tracks && window.tracks.listFor) {
        window.tracks.listFor(currentContent).then(list => { subs = list; subsLoading = false; sendInfo(); });
    }
    // Play an episode of the show that's on, with the stream closest to the one you chose before.
    function playEpisode(id) {
        const fail = text => N.command(JSON.stringify({ cmd: 'episode-failed', text }));
        if (!currentContent || !currentContent.show) { fail('Episodes aren\u2019t available for this video.'); return; }
        const ep = episodes.find(x => x.id === id);
        const label = ep ? `${showName} S${ep.season}E${ep.episode}` : showName;
        const show = currentContent.show, art = currentContent.art;
        window.reddateAddons.streamsFor('series', id, show).then(list => {
            if (!list.length) { fail('No streams found for that episode'); return; }
            // The closest match to what you chose before first, then the next closest (same quality, audio,
            // source…): if a link is dead, the next one plays by itself (see episodeFallback).
            const best = pickRemembered(list);
            const ordered = [best, ...list.filter(x => x !== best).sort((a, b) => (b.match || 0) - (a.match || 0))].slice(0, 8);
            episodeFallback = { id, label, show, art, list: ordered, i: 0 };
            window.reddateAddons.rememberChoice(show, best.url);
            if (window.reddateAutoPlayNext) window.reddateAutoPlayNext();
            loadEpisodeStream();
        }).catch(() => fail('Couldn\u2019t load that episode'));
    }
    if (currentContent && currentContent.type === 'series' && currentContent.show && window.reddateAddons) {
        window.reddateAddons.fullMeta('series', currentContent.show).then(m => {
            if (!m || currentSrc !== src) return;
            showName = m.name || '';
            episodes = (m.videos || []).map(v => ({
                id: v.id, season: Number(v.season) || 0, episode: Number(v.episode) || 0, title: v.title || v.name || '',
                thumbnail: typeof v.thumbnail === 'string' && v.thumbnail.startsWith('https://') ? v.thumbnail : '',
                rating: v.rating || '', runtime: v.runtime || ''
            })).sort((a, b) => a.season - b.season || a.episode - b.episode);
            sendInfo();
        }).catch(() => {});
    }

    // Keep the player area from looking empty while the native screen is on top of the page.
    const note = document.createElement('div');
    note.className = 'native-note';
    note.textContent = 'Playing in the TV player';
    stageEl().appendChild(note);
    const art = nextCover && nextCover.art;
    showCover();
    setPlayerStatus('⏳ Loading stream…');

    window.ReddateTV = window.ReddateTV || {};
    window.ReddateTV.onNative = ev => {
        if (window.__devlog && ev.type !== 'tick') window.__devlog('native', ev); // dev-only (local-network testing)
        if (currentSrc !== src || ev.sid !== sid) return; // a leftover event from an earlier player isn't the viewer's
        switch (ev.type) {
            case 'ready':
                setPlayerStatus('');
                hideCover();
                currentDuration = (ev.durationMs || 0) / 1000;
                isPlayerReady = true;
                updatePlayPauseButton();
                applyPending();
                break;
            case 'tick':
                mark(ev.posMs / 1000, ev.playing);
                nativeBuffering = !!ev.buffering;
                setBuffering(nativeBuffering);
                break;
            case 'state':
                mark(ev.posMs / 1000, ev.playing);
                track(ev.playing ? 'start' : 'pause');
                if (!ev.echo) onPlayerPlayPause(ev.playing);
                break;
            case 'seek':
                mark(ev.posMs / 1000);
                if (playing) track('start'); // a seek while playing is reported as a fresh start at the new place
                if (!ev.echo) onPlayerSeek(ev.posMs / 1000);
                break;
            case 'error':
                // An episode picked in the player (or the next one starting by itself): try the next closest stream.
                if (isHost() && episodeFallback && episodeFallback.list[episodeFallback.i] && episodeFallback.list[episodeFallback.i].url === src && episodeFallback.i + 1 < episodeFallback.list.length) {
                    episodeFallback.i++;
                    N.command(JSON.stringify({ cmd: 'toast', text: 'That link didn\u2019t answer. Trying a similar one\u2026' }));
                    setTimeout(loadEpisodeStream, 300);
                    break;
                }
                // The TV app can swap in the next stream (if this viewer chose it).
                if (N.event) N.event(JSON.stringify({ type: 'play-failed', src, host: isHost(), pos: Math.max(0, Math.round(vp && vp.getCurrentTime ? vp.getCurrentTime() : 0)) }));
                setPlayerStatus('⚠️ This TV can\'t play that stream — pick another one in Browse.');
                coverMessage('This TV can’t play that stream. Pick another one.');
                showToast('This TV can\'t play that stream — try another');
                break;
            case 'action':
                if (ev.action === 'sync') syncVideo();
                if (ev.action === 'invite-all') window.reddateDevices.inviteAll();
                break;
            case 'sync-answer':
                if (ev.yes) { resync(); }
                break;
            case 'join-answer':
                if (ev.yes && pendingLoaded && handleLoadedRef) { setDetached(false); handleLoadedRef(pendingLoaded); }
                pendingLoaded = null;
                break;
            case 'set-host':
                if (typeof ev.id === 'string' && socket && socket.connected) socket.emit('set-host', { to: ev.id, on: !!ev.on });
                break;
            case 'kick':
                if (typeof ev.id === 'string') socket.emit('kick-user', { to: ev.id });
                break;
            case 'guests-pause-on':
            case 'guests-pause-off':
                socket.emit('party-setting', { guestsCanPause: ev.action === 'guests-pause-on' });
                break;
            case 'invite-answer':
                if (typeof ev.roomId === 'string') answerInvite(ev.roomId, !!ev.accept);
                break;
            case 'episode':
                // Another episode picked in the TV player: it plays for the room with the same kind of
                // stream as before (addon, quality, language…).
                if (!isHost()) { noControl(); N.command(JSON.stringify({ cmd: 'episode-failed', text: 'Only the host picks the episode.' })); break; }
                if (typeof ev.id === 'string') playEpisode(ev.id);
                break;
            case 'ended':
                track('stop', 100);
                // The host's video stopped at its end: the room stops there too, or everyone else would be
                // told they're "behind" a clock that keeps running past the end.
                if (isHost() && party && anchor.isPlaying) {
                    const t = typeof ev.posMs === 'number' ? ev.posMs / 1000 : (vp && vp.getCurrentTime ? vp.getCurrentTime() : 0);
                    mark(t, false);
                    setAnchor(false, t);
                    isVideoPlaying = false;
                    updatePlayPauseButton();
                    socket.emit('video-playpause', { isPlaying: false, currentTime: t });
                }
                // End of an episode: on to the next one (same kind of stream), or done.
                if (!isHost() || !currentContent) break;
                {
                    const i = episodes.findIndex(x => x.id === currentContent.id);
                    const nx = i >= 0 ? episodes[i + 1] : null;
                    const nextLabel = nx ? `${showName} S${nx.season}E${nx.episode}` : '';
                    window.reddateContinue.finished(currentContent, nx ? { id: nx.id, label: nextLabel } : null);
                    if (nx && autoNextOn() && ev.auto) {
                        // The TV app starts the next episode itself (it asks for it through an 'episode' event).
                    } else if (nx && autoNextOn()) {
                        N.command(JSON.stringify({ cmd: 'toast', text: `Up next: S${nx.season}E${nx.episode} ${nx.title || ''}` }));
                        setTimeout(() => { if (currentSrc === src) playEpisode(nx.id); }, 4000);
                    } else if (nx) {
                        N.command(JSON.stringify({ cmd: 'toast', text: `Next: S${nx.season}E${nx.episode}. Open Episodes to play it.` }));
                    }
                }
                break;
            case 'autonext':
                if (window.reddatePrefs) window.reddatePrefs.set('autoNext', !!ev.on);
                sendInfo();
                break;
            case 'subpref':
                if (window.tracks && typeof ev.lang === 'string') window.tracks.setPref(ev.lang);
                break;
            case 'subtitle':
                if (ev.state && typeof ev.state === 'object') {
                    window.tracks?.makeSubtitlePersonal();
                    window.tracks?.applyShared(ev.state, true, true);
                    shareRoomSubtitle({ mediaId: lastLoaded?.mediaId, state: ev.state });
                }
                break;
            case 'audio':
                if (ev.state) shareRoomAudio({ mediaId: lastLoaded?.mediaId, state: ev.state });
                break;
            case 'chat':
                if (window.reddateChat && typeof ev.text === 'string') window.reddateChat.send(ev.text);
                break;
            case 'burst':
                if (socket && socket.connected && typeof ev.e === 'string') socket.emit('lounge', { k: 'burst', e: ev.e.slice(0, 12) });
                break;
            case 'typing':
                if (socket && socket.connected) socket.emit(ev.on ? 'typing-start' : 'typing-stop');
                break;
            case 'chatpref':
                if (window.ReddateTV && window.ReddateTV.setChatOn) window.ReddateTV.setChatOn(!!ev.on);
                break;
            case 'leave-room':
                // "Stop watching": the viewer left on purpose. They leave the room (a host's leaving ends the party).
                if (window.reddateContinue && currentContent) { const k = currentContent.show || currentContent.id; try { window.reddateContinue.record(currentContent, document.getElementById('nowPlaying').textContent, vp ? vp.getCurrentTime() : 0, currentDuration); window.reddateContinue.flush(); } catch (e) { /* fine */ } }
                closed = true;
                window.__nativeOpen = false;
                playing = false;
                try { if (typeof theater !== 'undefined' && theater) setTheater(false); } catch (e) { /* fine */ }
                try { window.reddateRoom.leave(); } catch (e) { /* fine */ }
                break;
            case 'closed':
                // The viewer left the native screen: back to the menus. The room carries on without them.
                closed = true;
                window.__nativeOpen = false;
                playing = false;
                if (typeof theater !== 'undefined' && theater) setTheater(false);
                break;
        }
    };

    vp = {
        getCurrentTime: () => now(),
        seekTo: t => { mark(t); if (!closed) N.command(JSON.stringify({ cmd: 'seek', ms: Math.round(t * 1000) })); },
        kind: 'native',
        isAdvancing: () => playing && !nativeBuffering && !closed,
        setRate: r => { if (r !== nativeRate && !closed) { nativeRate = r; N.command(JSON.stringify({ cmd: 'rate', r })); } },
        play: () => { if (closed) open(roomPos(), true); else N.command('{"cmd":"play"}'); },
        reopen: () => { if (closed) open(roomPos(), anchor.isPlaying); },
        pause: () => { if (!closed) N.command('{"cmd":"pause"}'); },
        destroy: () => { if (tracking) track('stop'); try { N.command('{"cmd":"stop"}'); } catch (_) {} if (window.ReddateTV) window.ReddateTV.onNative = null; window.reddateNativeInfo = null; window.__nativeOpen = false; }
    };
    open(Math.max(0, roomPos()), anchor.isPlaying);
}

function createDirectPlayer(src) {
    if (window.ReddateNative && window.ReddateNative.hasPlayer && window.ReddateNative.hasPlayer()) { createNativePlayer(src); return; }
    destroyPlayer();
    currentSrc = src;
    const v = document.createElement('video');
    let hls = null;
    // Native HLS whenever the browser has it (Safari, and Chrome since 141): it picks an audio rendition the
    // device can decode (AAC next to Dolby) and needs no CORS. hls.js is only for browsers without it (Firefox).
    // Don't require v.audioTracks here: Chrome has native HLS but no audioTracks, and sending it to hls.js
    // left Dolby streams silent and CORS-less streams unplayable.
    if (isHlsUrl(src) && !v.canPlayType('application/vnd.apple.mpegurl')) {
        loadHlsJs().then(Hls => {
            if (currentSrc !== src || !Hls || !Hls.isSupported()) return;
            hls = new Hls();
            if (window.tracks) window.tracks.attachHls(hls);
            hls.loadSource(src);
            hls.attachMedia(v);
        }).catch(() => showToast('Could not load the HLS player'));
    } else {
        v.src = src;
    }
    v.controls = true;
    v.playsInline = true;
    v.style.background = '#000'; // sized by #videoPlayer (fixed height on desktop, 16:9 on phones)
    stageEl().appendChild(v);
    showCover();
    const audioGate = window.createPlaybackGate(v, {
        onPlayback: playing => { if (!v.ended) onPlayerPlayPause(playing); },
        onBuffering: on => { setBuffering(on); setPlayerStatus(on ? 'Buffering selected audio…' : ''); },
        onPlayError: () => showToast('Tap the video to resume playback')
    });
    if (window.tracks) window.tracks.attach(v, src);
    // Addon sources can take a minute to resolve; say so instead of showing a dead black box.
    setPlayerStatus('⏳ Loading stream…');
    const slowTimer = setTimeout(() => {
        if (!isPlayerReady && currentSrc === src) setPlayerStatus('⏳ Still loading — this source is slow. If it doesn\'t start soon, pick another stream in 🍿 Browse.');
    }, 15000);
    v.addEventListener('loadedmetadata', () => { currentDuration = isFinite(v.duration) ? v.duration : 0; });
    v.addEventListener('loadeddata', () => { clearTimeout(slowTimer); setPlayerStatus(''); hideCover(); isPlayerReady = true; updatePlayPauseButton(); applyPending(); });
    v.addEventListener('waiting', () => setBuffering(true));
    v.addEventListener('playing', () => setBuffering(audioGate.buffering));
    v.addEventListener('canplay', () => setBuffering(audioGate.buffering));
    // Only broadcast seeks the viewer made. Seeks applied from the room (remote
    // seek, sync, drift correction) must not be re-broadcast, or two players
    // echo the same seek back and forth forever and playback never advances.
    let programmaticSeekTo = null;
    let syncAfter = 0;
    v.addEventListener('seeking', () => { syncAfter = Date.now() + 2000; });
    v.addEventListener('seeked', () => {
        syncAfter = Date.now() + 1200;
        if (programmaticSeekTo !== null && Math.abs(v.currentTime - programmaticSeekTo) < 0.5) {
            programmaticSeekTo = null;
            return;
        }
        programmaticSeekTo = null;
        onPlayerSeek(v.currentTime);
    });
    v.addEventListener('error', () => {
        clearTimeout(slowTimer);
        setPlayerStatus('⚠️ This stream can\'t play in your browser — pick another one in 🍿 Browse.');
        coverMessage('This stream can’t play here. Pick another one.');
        showToast('This video can\'t play in your browser — try another stream from 🍿 Browse');
    });
    vp = {
        kind: 'direct',
        isAdvancing: () => !audioGate.buffering && !v.paused && !v.ended && !v.seeking && v.readyState >= 3 && Date.now() >= syncAfter,
        setRate: r => { if (v.playbackRate !== r) v.playbackRate = r; },
        getCurrentTime: () => v.currentTime || 0,
        seekTo: (t) => { programmaticSeekTo = t; v.currentTime = t; },
        play: () => audioGate.play(),
        pause: () => audioGate.pause(),
        destroy: () => { clearTimeout(slowTimer); audioGate.destroy(); if (hls) hls.destroy(); v.pause(); v.removeAttribute('src'); v.load(); v.remove(); }
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
    window.tracks?.configureRoom(shareRoomSubtitle, shareRoomAudio);
    socket.on('audio-updated', payload => {
        if (payload.mediaId !== lastLoaded?.mediaId || (roomAudio && payload.revision <= roomAudio.revision)) return;
        roomAudio = payload;
        window.tracks?.applyRoomAudio(payload.state);
        if (window.reddateNativeInfo) window.reddateNativeInfo();
    });
    socket.on('party', () => { window.tracks?.setSettingsOwner(ownsRoomSettings()); if (window.reddateNativeInfo) window.reddateNativeInfo(); });
    socket.on('room-settings-owner', data => {
        if (data.mediaId !== lastLoaded?.mediaId) return;
        lastLoaded.settingsOwner = data.settingsOwner;
        window.tracks?.setSettingsOwner(ownsRoomSettings());
        if (window.reddateNativeInfo) window.reddateNativeInfo();
    });
    socket.on('joined', () => window.tracks?.reportAudio(true));
    socket.on('subtitles-updated', payload => {
        if (payload.mediaId !== lastLoaded?.mediaId || payload.revision <= subtitleRevision) return;
        subtitleRevision = payload.revision;
        roomSubtitle = { ...payload, own: payload.sender === socket.id };
        window.tracks?.applyShared(payload.state, roomSubtitle.own);
        if (window.reddateNativeInfo) window.reddateNativeInfo();
    });
    socket.on('video-loaded', data => {
        if (party && !isHost() && detached) {
            // The host started something else while this guest was off on their own: ask first.
            const host = party.hostName || 'The host';
            const go = () => { setDetached(false); handleLoaded(data); };
            const home = window.reddateHome;
            if (window.__nativeOpen && window.ReddateNative) { pendingLoaded = data; window.ReddateNative.command(JSON.stringify({ cmd: 'ask-join', host, title: data.title || 'something else' })); }
            else if (home && home.confirm) home.confirm(`${host} switched to ${data.title ? '“' + data.title + '”' : 'something else'}`, 'Join them?', 'Join', go, () => {});
            return;
        }
        handleLoaded(data);
    });
    handleLoadedRef = data => handleLoaded(data);
    function handleLoaded(data) {
        setSubtitleMedia(data);
        lastLoaded = data;
        seekFails = 0; seekAim = 0; pendingSeekAt = 0; // a new video: learn afresh whether it can seek
        nextCover = { art: data.content && data.content.art, title: data.title };
        currentContent = data.kind === 'direct' ? data.content : null;
        if (currentContent && window.reddateContinue && window.reddateContinue.unblock) window.reddateContinue.unblock(currentContent.show || currentContent.id);
        setAnchor(false, 0, data.serverTime);
        ensurePlayer(data);
        setNowPlaying(data.title);
        if (window.tracks && data.kind === 'direct') window.tracks.setContent(data.content);
        addSystemMessage(`🎬 ${data.user} loaded ${data.title ? `“${data.title}”` : 'a video'}`);
    }
    socket.on('video-playpause-sync', data => {
        setAnchor(data.isPlaying, data.currentTime, data.serverTime);
        if (detached) { if (window.reddateNativeInfo) window.reddateNativeInfo(); return; } // off on their own: keep their pace
        applyAnchor();
        isVideoPlaying = anchor.isPlaying;
        updatePlayPauseButton();
    });
    socket.on('video-seek', data => {
        setAnchor(anchor.isPlaying, data.currentTime, data.serverTime);
        if (detached) return;
        applyAnchor();
    });
    socket.on('video-sync', state => {
        setSubtitleMedia(state);
        lastLoaded = state;
        nextCover = { art: state.content && state.content.art, title: state.title };
        currentContent = state.kind === 'direct' ? state.content : null;
        setAnchor(state.isPlaying, state.currentTime, state.serverTime);
        if (!ensurePlayer(state)) return;
        setNowPlaying(state.title);
        if (window.tracks && state.kind === 'direct') window.tracks.setContent(state.content);
        if (state.force && detached) setDetached(false); // the host pressed "Sync everyone"
        if (detached) return; // they pressed play on their own; they'll be asked when they're ready
        isVideoPlaying = state.isPlaying;
        updatePlayPauseButton();
        fixes = []; fixGap = 8000; slowWarned = false; // a fresh sync gets a fresh start
        applyAnchor();
    });
    // Someone else is stuck loading: say who, once in a while, so a stall isn't a mystery.
    const toldBuffering = new Map();
    socket.on('peer-buffering', d => {
        if (!d.on || !d.user) return;
        const last = toldBuffering.get(d.id) || 0;
        if (Date.now() - last < 90000) return;
        toldBuffering.set(d.id, Date.now());
        showToast(`${d.user}'s stream is loading slowly. They'll catch up.`);
    });

    // Report watching time (anonymous stats). These reports never move anyone's player.
    setInterval(() => {
        if (vp && isPlayerReady && isVideoPlaying) socket.emit('video-progress', {});
    }, 4000);
    setInterval(checkClock, 60000);
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
    if (party && !isHost() && !party.guestsCanPause) { noControl(); return; }
    const shouldPlay = !isVideoPlaying;
    const t = vp.getCurrentTime();
    isVideoPlaying = shouldPlay;
    updatePlayPauseButton();
    setAnchor(shouldPlay, t);
    socket.emit('video-playpause', { isPlaying: shouldPlay, currentTime: t });
    steer(() => (shouldPlay ? vp.play() : vp.pause()));
}

function updatePlayPauseButton() {
    const btn = document.getElementById('playPauseBtn');
    btn.querySelector('use').setAttribute('href', isVideoPlaying ? '#i-pause' : '#i-play');
    btn.querySelector('.label').textContent = isVideoPlaying ? 'Pause' : 'Play';
}

function syncVideo() {
    if (!vp || !isPlayerReady) { showToast('Load a video first'); return; }
    if (party && !isHost()) { // a guest: catch up with the host
        if (!detached && Math.abs(behindBy()) < 1.5) { showToast('You’re in sync'); return; }
        resync();
        showToast(`Synced with ${party.hostName || 'the host'}`);
        return;
    }
    fixes = []; fixGap = 8000;
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
    document.getElementById('chatPanel').inert = !(visible || LOUNGE); // the Lounge's chat is the page: always usable, also on phones
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
        // Inside an app (the TV app, or the browser app where this page is hidden), the app owns the screen:
        // this page asking for full screen would put a black, empty frame over everything.
        const req = window.ReddateNative ? null : (el.requestFullscreen || el.webkitRequestFullscreen);
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
        if (e.key !== 'Escape') return;
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

    document.getElementById('copyRoomCodeBtn').addEventListener('click', async () => {
        if (!roomCode || !roomLive) return;
        try { await navigator.clipboard.writeText(roomCode); showToast('Room code copied'); }
        catch { prompt('Copy this room code:', roomCode); }
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

    // Image / GIF sharing (sent through chat)
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

// ---------------- Start ----------------
// After every script on the page has loaded (the Lounge and TV scripts come after this one).
// Connect now; the screen depends on whether this is an invite link.
function restoreBrowserRoom() {
    if (FRAME) return false;
    const saved = window.reddateBrowserSession.resumeForRoom(existing.roomId || leanCode);
    if (!saved) return false;
    if (window.reddateAccount && !window.reddateAccount.isReady()) {
        document.addEventListener('reddate:account-ready', () => {
            sayHello();
            restoreBrowserRoom();
        }, { once: true });
        showScreen('room');
        setPlayerStatus('Restoring your room…');
        return true;
    }
    usernameInput.value = savedName() || saved.name;
    const joined = waitForJoin();
    enterRoom(usernameInput.value, saved.roomId, null, { requireExisting: true });
    joined.then(result => {
        if (!result?.ok) {
            inRoom = false;
            showScreen('lobby');
            showLobbyError(result?.message || 'Could not restore the room. Try joining again.');
        }
    });
    return true;
}

function boot() {
    startApp();
    const create = new URLSearchParams(location.search);
    if (location.pathname === '/classic' && create.get('create') === '1') {
        usernameInput.value = create.get('name') || savedName() || 'Guest';
        history.replaceState(null, '', '/classic');
        enterFromLobby(false);
        return;
    }
    if (restoreBrowserRoom()) return;
    const tv = document.documentElement.classList.contains('tv');
    if (existing.roomId || !tv) {
        if (existing.roomId) {
            lobbyBtn.textContent = 'Join room';
            document.getElementById('lobbyTitle').textContent = 'Join your friends.';
            document.getElementById('lobbyTagline').textContent = 'You’ve been invited to watch together. Pick a name and jump in.';
            document.getElementById('lobbyCode').hidden = true;
            document.getElementById('createHint').hidden = true;
        }
        usernameInput.value = savedName();
        showScreen('lobby');
        setTimeout(() => (usernameInput.value ? lobbyBtn : usernameInput).focus(), 50);
    } else {
        showScreen('home');
    }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();


// The Lounge page: one button starts voice and video (the page's own call button does the work).
(function () {
    if (!LOUNGE) return;
    const hero = document.getElementById('loungeHero'), go = document.getElementById('loungeCall'), call = document.getElementById('callBtn');
    // Reddate branding and plain chat wording instead of the Reddit-style labels.
    const wm = document.querySelector('.topbar .wordmark');
    if (wm) wm.innerHTML = '<svg class="lg-mark" viewBox="0 0 108 108" aria-hidden="true"><defs><linearGradient id="lgo" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff8a4c"/><stop offset="1" stop-color="#e8502a"/></linearGradient><clipPath id="lgb"><rect x="22" y="24" width="52" height="36" rx="8"/></clipPath></defs><rect x="22" y="24" width="52" height="36" rx="8" fill="url(#lgo)"/><rect x="34" y="44" width="52" height="36" rx="8" fill="#f6f1ea"/><rect x="34" y="44" width="52" height="36" rx="8" fill="#ff3b1f" clip-path="url(#lgb)"/></svg><span class="wm-text">Reddate</span> <small><svg class="icon" width="13" height="13" aria-hidden="true"><use href="#i-video"/></svg><span class="wm-pill"> Lounge</span></small>';
    const h2 = document.querySelector('.chat-header h2');
    if (h2) h2.firstChild.textContent = 'Lounge chat ';
    const inp = document.getElementById('messageInput'); if (inp) inp.placeholder = 'Message';
    const snd = document.getElementById('sendBtn'); if (snd) snd.textContent = 'Send';
    // The call button lives in the message bar, next to GIF: chat stays the page, voice and video are one tap away.
    const gif = document.getElementById('gifBtn');
    if (gif && call) {
        const b = document.createElement('button');
        b.type = 'button'; b.id = 'loungeCallBtn'; b.className = 'icon-btn lounge-call'; b.title = 'Join voice and video'; b.setAttribute('aria-label', 'Join voice and video');
        b.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-headphones"/></svg><span>Voice/Video</span>';
        b.addEventListener('click', () => call.click());
        gif.after(b);
    }
    if (hero) hero.hidden = true;
    // Everyone else gets their own colour (from their name), so a busy chat is easy to follow.
    const box = document.getElementById('chatMessages');
    const tint = m => {
        if (m.nodeType !== 1 || !m.classList.contains('message') || m.classList.contains('self') || m.classList.contains('system-message') || m.dataset.tint) return;
        const n = (m.querySelector('.username') || {}).textContent || '';
        let h = 0; for (const c of n) h = (h * 31 + c.charCodeAt(0)) % 360;
        m.dataset.tint = '1';
        m.style.setProperty('--tint-bg', `hsl(${h} 38% 20%)`);
        m.style.setProperty('--tint-name', `hsl(${h} 85% 72%)`);
    };
    if (box) { box.querySelectorAll('.message').forEach(tint); new MutationObserver(l => l.forEach(r => r.addedNodes.forEach(tint))).observe(box, { childList: true }); }
})();
