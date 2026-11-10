/* TV mode: the same Reddate screens, driven by a remote control.
 *
 * Opened as /?tv=1 (the Android TV app does this), or automatically on a TV
 * browser. It adds: remote-control (D-pad) navigation, a sign-in screen that
 * shows a QR code and a code to approve on your phone, a "Who's watching?"
 * picker, and auto-starting a room. No chat and no Lounge on TV (the CSS hides
 * them and app.js skips loading the Lounge).
 *
 * The Android app can expose `window.ReddateNative` (for the native player and
 * the Back button); everything here also works in a plain browser for testing.
 */
(function () {
    const html = document.documentElement;
    if (!html.classList.contains('tv')) return; // the inline script in <head> decides

    const $ = id => document.getElementById(id);
    const native = window.ReddateNative || null;

    // ---- DEV ONLY: while testing against a computer on the local network, send errors there. ----
    // Active only when the page was loaded from a private address (never on reddate.xyz).
    const DEV_LOG = /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(location.hostname);
    function devlog(kind, data) {
        if (!DEV_LOG) return;
        try {
            const body = JSON.stringify({ kind, data, t: Date.now() });
            if (navigator.sendBeacon) navigator.sendBeacon(`http://${location.hostname}:3091/log`, body);
            else { const x = new XMLHttpRequest(); x.open('POST', `http://${location.hostname}:3091/log`); x.send(body); }
        } catch (e) { /* ignore */ }
    }
    window.__devlog = devlog;
    if (DEV_LOG) {
        window.addEventListener('error', e => devlog('error', { message: e.message, src: String(e.filename || '').split('/').pop(), line: e.lineno, col: e.colno, stack: e.error && e.error.stack && String(e.error.stack).slice(0, 400) }));
        window.addEventListener('unhandledrejection', e => devlog('rejection', { reason: String(e.reason && (e.reason.stack || e.reason.message || e.reason)).slice(0, 400) }));
        const origErr = console.error;
        console.error = function () { devlog('console.error', Array.from(arguments).map(String).join(' ').slice(0, 300)); return origErr.apply(console, arguments); };
        // A pulse every 5 seconds: if the page is put to sleep behind the video player, it stops.
        setInterval(() => devlog('hb', { vis: document.visibilityState, sock: typeof socket !== 'undefined' && socket ? socket.connected : null }), 5000);
        devlog('hello', {
            ua: navigator.userAgent, native: typeof window.ReddateNative,
            hasPlayer: window.ReddateNative && window.ReddateNative.hasPlayer ? window.ReddateNative.hasPlayer() : null,
            size: `${innerWidth}x${innerHeight} dpr${devicePixelRatio}`
        });
    }

    function icon(name) {
        const ns = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('class', 'icon');
        svg.setAttribute('aria-hidden', 'true');
        const use = document.createElementNS(ns, 'use');
        use.setAttribute('href', `#i-${name}`);
        svg.appendChild(use);
        return svg;
    }

    function el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    }

    // ---------- size everything for a couch ----------
    function scale() {
        // Sized by screen width: 24px on a 1920-wide page, 12px on the 960-wide page a 1080p Android TV
        // reports (it has twice the pixel density), so the layout looks the same on both.
        html.style.fontSize = `${Math.min(30, Math.max(9, (innerWidth / 1920) * 24))}px`;
    }
    scale();
    addEventListener('resize', scale);

    // ---------- remote-control navigation ----------
    const FOCUSABLE = 'a[href], button, input:not([type=hidden]), select, textarea, [tabindex]:not([tabindex="-1"])';

    function visible(e) {
        if (e.disabled || e.hidden || e.closest('[inert]') || e.closest('[hidden]')) return false;
        const r = e.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return false;
        const cs = getComputedStyle(e);
        return cs.visibility !== 'hidden' && cs.display !== 'none';
    }

    // Focus stays inside the front-most layer: an open dialog, then the TV overlay, then the page.
    function scope() {
        const shown = [...document.querySelectorAll('.modal.show .modal-content')];
        if (shown.length) return shown[shown.length - 1];
        const overlay = $('tvRoot');
        if (overlay && !overlay.hidden) return overlay;
        if ($('managePage') && !$('managePage').hidden) return $('managePage');
        if ($('titlePage') && !$('titlePage').hidden) return $('titlePage');
        if ($('app') && !$('app').classList.contains('hidden')) return $('app');
        if ($('home') && !$('home').hidden) return $('home');
        return document.body;
    }

    function candidates() { return [...scope().querySelectorAll(FOCUSABLE)].filter(visible); }

    function center(r) { return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }

    function move(dir) {
        const list = candidates();
        if (!list.length) return false;
        let cur = document.activeElement;
        if (!cur || !list.includes(cur)) { focusEl(list[0]); return true; }
        const cr = cur.getBoundingClientRect();
        const cc = center(cr);
        let best = null, bestScore = Infinity;
        for (const c of list) {
            if (c === cur) continue;
            const r = c.getBoundingClientRect();
            const rc = center(r);
            const dx = rc.x - cc.x, dy = rc.y - cc.y;
            const primary = dir === 'right' ? dx : dir === 'left' ? -dx : dir === 'down' ? dy : -dy;
            if (primary < 2) continue; // not in that direction
            const horizontal = dir === 'left' || dir === 'right';
            // Elements lined up in the other axis count as straight ahead.
            const overlap = horizontal
                ? Math.min(cr.bottom, r.bottom) - Math.max(cr.top, r.top) > 0
                : Math.min(cr.right, r.right) - Math.max(cr.left, r.left) > 0;
            const secondary = overlap ? 0 : (horizontal ? Math.abs(dy) : Math.abs(dx));
            const score = primary + secondary * 3;
            if (score < bestScore) { bestScore = score; best = c; }
        }
        if (!best) return false;
        focusEl(best);
        return true;
    }

    // Move the focus ring; only scroll when the element is near or past the screen edge, so
    // the headings and tabs above a row don't slide out of view for no reason.
    // ---------- Home, the Android TV way: a side menu, a banner, and rows ----------
    // Up/Down moves between rows (each row remembers where you were in it, like
    // Android TV apps), Left/Right moves along a row, Left at the start of a row
    // opens the side menu.
    const rowItems = row => [...row.querySelectorAll('.poster-card:not(.is-skeleton)')].filter(visible);
    const homeRows = () => [...document.querySelectorAll('#homeRows:not([hidden]) .row')].filter(r => rowItems(r).length);
    const allRows = () => [...document.querySelectorAll('#homeRows:not([hidden]) .row')];
    const heroButtons = () => [...document.querySelectorAll('#homeHero:not([hidden]) .hero-actions .btn')];
    const railItems = () => [...document.querySelectorAll('#tvRail .tv-rail-item')];
    let lastContent = null;

    function focusRowItem(it, vertical) {
        it.focus({ preventScroll: true });
        it.scrollIntoView({ block: vertical ? 'center' : 'nearest', inline: 'nearest', behavior: 'instant' });
        return true;
    }
    function focusInRow(row, from) {
        const items = rowItems(row);
        let target = row._last && row._last.isConnected && items.includes(row._last) ? row._last : null;
        if (!target) {
            const x = from ? center(from.getBoundingClientRect()).x : -Infinity;
            target = items.reduce((best, it) => (Math.abs(center(it.getBoundingClientRect()).x - x) < Math.abs(center(best.getBoundingClientRect()).x - x) ? it : best), items[0]);
        }
        return focusRowItem(target, true);
    }
    function toRail() { const r = railItems(); const home = $('railHome'); if (r.length) focusEl(home || r[0]); return true; }

    function moveHome(dir) {
        const cur = document.activeElement;
        if (!cur || $('home').hidden || scope() !== $('home')) return false;
        if (cur.closest('#tvRail')) {
            const items = railItems();
            const i = items.indexOf(cur);
            if (dir === 'up' && i > 0) return focusEl(items[i - 1]) || true;
            if (dir === 'down' && i < items.length - 1) return focusEl(items[i + 1]) || true;
            if (dir === 'right') {
                const back = lastContent && lastContent.isConnected && visible(lastContent) ? lastContent : (heroButtons()[0] || null);
                if (back) focusEl(back); else { const r = homeRows()[0]; if (r) focusInRow(r); }
            }
            return true;
        }
        lastContent = cur;
        const row = cur.closest('#homeRows .row');
        if (row) {
            const items = rowItems(row);
            const i = items.indexOf(cur);
            row._last = cur;
            if (dir === 'left') return i > 0 ? focusRowItem(items[i - 1]) : toRail();
            if (dir === 'right') return i < items.length - 1 ? focusRowItem(items[i + 1]) : true;
            const rows = allRows();
            const r = rows.indexOf(row);
            if (window.reddateHome) window.reddateHome.loadAhead(row, 5);
            if (dir === 'up') {
                if (r > 0) { const prev = rows.slice(0, r).reverse().find(x => rowItems(x).length); if (prev) return focusInRow(prev, cur); }
                const hb = heroButtons();
                if (hb.length) { focusEl(hb[0]); window.scrollTo({ top: 0, behavior: 'instant' }); return true; }
                return toRail();
            }
            if (dir === 'down') {
                const next = rows.slice(r + 1).find(x => !x._spec || rowItems(x).length || !x._loaded);
                if (!next) { const eb = document.querySelector('#homeRows .home-edit .btn'); if (eb) focusEl(eb); return true; }
                if (!rowItems(next).length) { if (window.reddateHome) window.reddateHome.loadRow(next); return true; } // still loading: stay put
                return focusInRow(next, cur);
            }
        }
        if (cur.closest('#homeRows .home-edit')) {
            if (dir === 'up') { const rs = homeRows(); if (rs.length) return focusInRow(rs[rs.length - 1], cur); }
            if (dir === 'left') return toRail();
            return true;
        }
        const hb = heroButtons();
        if (hb.includes(cur)) {
            const i = hb.indexOf(cur);
            if (dir === 'left') return i > 0 ? (focusEl(hb[i - 1]) || true) : toRail();
            if (dir === 'right') return i < hb.length - 1 ? (focusEl(hb[i + 1]) || true) : true;
            if (dir === 'down') { const r = homeRows()[0]; if (r) { focusInRow(r); if (window.reddateHome) window.reddateHome.loadAhead(r, 3); } return true; }
            return true; // nothing above the banner
        }
        return false; // search results etc.: normal spatial movement
    }

    function focusEl(e) {
        e.focus({ preventScroll: true });
        const r = e.getBoundingClientRect();
        const margin = innerHeight * 0.14;
        if (r.top < margin || r.bottom > innerHeight - margin) e.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    }

    // ---------- Back ----------
    // Remember the last poster you were on so Back from a title returns right there.
    let lastPoster = null;
    document.addEventListener('focusin', e => { if (e.target.closest && e.target.closest('.poster-grid')) lastPoster = e.target; });

    function back() {
        if (window.reddatePages && window.reddatePages.isOpen()) { window.reddatePages.close(); setTimeout(() => { const r = $('railHome'); if (lastContent && lastContent.isConnected && visible(lastContent)) focusEl(lastContent); else if (r) focusEl(r); }, 30); return; }
        if (!root.hidden && (root.dataset.kind === 'invite' || root.dataset.kind === 'chat')) { hideScreen(); focusFirstControl(); return; }
        const modal = [...document.querySelectorAll('.modal.show')].pop();
        if (modal) {
            const detail = $('detailView');
            if (modal.id === 'browseModal' && detail && detail.style.display !== 'none') {
                $('detailBackBtn').click();
                setTimeout(() => { if (lastPoster && lastPoster.isConnected && visible(lastPoster)) focusEl(lastPoster); else { const f = candidates()[0]; if (f) focusEl(f); } }, 60);
                return;
            }
            const x = modal.querySelector('.modal-close');
            if (x) { x.click(); return; }
        }
        if (typeof theater !== 'undefined' && theater) { if (window.__tvBackYt && window.__tvBackYt()) return; setTheater(false); focusFirstControl(); return; }
        if ($('titlePage') && !$('titlePage').hidden) { window.reddateHome.closeTitle(); return; }
        if (html.classList.contains('tv-search')) { closeSearch(); return; }
        // In the room: back to Home (the room keeps going). On Home: leave the app.
        if (document.documentElement.dataset.screen === 'room') { window.reddateRoom.showHome(); focusFirstPoster(); return; }
        if (native && native.exit) native.exit();
    }
    window.ReddateTV = Object.assign(window.ReddateTV || {}, { back }); // the Android app calls this from its Back button

    function focusFirstControl() {
        const b = $('browseBtn');
        if (b && visible(b)) focusEl(b);
    }

    // Home: focus the banner's Play, else the first poster, once the catalog has loaded.
    function focusFirstPoster() {
        let tries = 0;
        const t = setInterval(() => {
            const target = document.querySelector('#homeHero:not([hidden]) .btn-primary') || document.querySelector('#homeRows .poster-card:not(.is-skeleton)');
            if (target && visible(target)) { clearInterval(t); focusEl(target); }
            else if (++tries > 40) clearInterval(t);
        }, 250);
    }

    // ---------- keys ----------
    const DIRS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

    document.addEventListener('keydown', e => {
        const t = e.target;
        const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') && t.type !== 'checkbox' && t.type !== 'button';

        if (e.key === 'Escape' || e.key === 'Backspace' || e.key === 'GoBack' || e.key === 'BrowserBack') {
            if (typing && e.key === 'Backspace') return; // deleting text
            e.preventDefault();
            back();
            return;
        }

        // Full screen playback: the remote is the player's remote.
        const inTheater = typeof theater !== 'undefined' && theater;
        if (inTheater && ytBarOpen() && root.hidden && ytBarKey(e.key, e)) { e.preventDefault(); return; }
        if (inTheater && !document.querySelector('.modal.show') && root.hidden && !(window.reddatePages && window.reddatePages.isOpen())) {
            if (e.key === 'Enter' || e.key === ' ' || e.key === 'MediaPlayPause') { e.preventDefault(); togglePlayPause(); return; }
            if (e.key === 'ArrowLeft' || e.key === 'MediaRewind') { e.preventDefault(); seekBy(-10); return; }
            if (e.key === 'ArrowRight' || e.key === 'MediaFastForward') { e.preventDefault(); seekBy(10); return; }
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); ytBarKey(e.key); return; }
            return;
        }

        const dir = DIRS[e.key];
        if (!dir) return;
        // Let text fields keep their caret movement until it hits an edge.
        if (typing && (dir === 'left' || dir === 'right')) {
            const atStart = t.selectionStart === 0 && t.selectionEnd === 0;
            const atEnd = t.selectionStart === t.value.length;
            if ((dir === 'left' && !atStart) || (dir === 'right' && !atEnd)) return;
        }
        e.preventDefault();
        if (!moveHome(dir)) move(dir);
    }, true);

    // Remember the last thing you were on outside the menu, and keep the banner on the focused poster.
    document.addEventListener('focusin', e => {
        const t = e.target;
        if (!t || !t.closest) return;
        if (t.closest('#home') && !t.closest('#tvRail')) lastContent = t;
        if (t.matches('#homeRows .poster-card') && t._meta && window.reddateHome) window.reddateHome.previewHero(t._meta);
    });

    // Seeking from the remote counts as the viewer's own seek, so everyone in the room follows.
    function seekBy(sec) {
        if (typeof vp === 'undefined' || !vp || !isPlayerReady) return;
        const to = Math.max(0, vp.getCurrentTime() + sec);
        steer(() => vp.seekTo(to));
        onPlayerSeek(to);
        showToast(`${sec > 0 ? '+' : '−'}${Math.abs(sec)}s`);
    }

    // ---------- the TV overlay: sign-in and profile screens ----------
    const root = el('div', 'tv-root');
    root.id = 'tvRoot';
    document.body.appendChild(root);

    /** The Reddate mark (two overlapping screens) and the name, as on every other Reddate screen. */
    function tvMark() {
        const d = el('div', 'tv-wordmark');
        d.innerHTML = '<svg viewBox="22 24 64 56" width="40" height="35" aria-hidden="true"><rect x="22" y="24" width="52" height="36" rx="8" fill="#ff7a3c"/><rect x="34" y="44" width="52" height="36" rx="8" fill="#f6f1ea"/><path d="M42 44h32v8a8 8 0 0 1-8 8H34v-8a8 8 0 0 1 8-8z" fill="#ff3b1f"/></svg><span>Reddate</span>';
        return d;
    }
    // One colour per person, the same palette the TV app's player uses.
    function personColor(name) {
        const c = ['#9ad1ff', '#ffe08a', '#c9f27a', '#e0a6ff', '#8fe3c9', '#ffb27a'];
        let h = 0; for (const ch of String(name || '').toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) | 0;
        return c[Math.abs(h) % c.length];
    }
    function showScreen(build) {
        root.hidden = false;
        root.innerHTML = '';
        const card = el('div', 'tv-card');
        build(card);
        root.appendChild(card);
        const f = candidates()[0];
        if (f) focusEl(f);
    }
    function hideScreen() { root.hidden = true; root.innerHTML = ''; delete root.dataset.kind; }

    // "Invite phones": a QR code and link so phones can join this TV's room.
    async function showInvite() {
        const R = window.reddateRoom;
        if (!R.isLive()) {
            const joined = waitForJoin();
            R.goLive(); // wait for the generated code before showing the invitation
            const result = await joined;
            if (!result?.ok) { showToast(result?.message || 'Could not create the room. Try again.'); return; }
        }
        const link = `${window.reddateWebOrigin || location.origin}/join/${encodeURIComponent(window.reddateRoom.roomCode() || roomId)}`;
        showScreen(c => {
            root.dataset.kind = 'invite';
            const left = el('div', 'tv-pair-text');
            left.appendChild(tvMark());
            left.appendChild(el('h1', null, 'Watch together'));
            left.appendChild(el('p', 'tv-sub', `Scan the code, or on a phone or computer open ${location.host}/watch and enter this code.`));
            const code = window.reddateRoom.roomCode();
            if (code) left.appendChild(el('div', 'tv-code mono', code));
            // Your other signed-in devices: send them the invite directly.
            const devs = el('div', 'tv-devices');
            left.appendChild(devs);
            if (window.reddateDevices) window.reddateDevices.list().then(list => list.forEach(d => {
                const b = el('button', 'btn', `Send to ${d.profile ? d.profile + ' · ' : ''}${d.device}`);
                b.onclick = () => { window.reddateDevices.invite(d.id); b.textContent = `Sent to ${d.device}`; b.disabled = true; };
                devs.appendChild(b);
            }));
            const close = el('button', 'btn btn-primary tv-big', 'Close');
            close.onclick = () => { hideScreen(); focusFirstControl(); };
            left.appendChild(close);
            c.classList.add('tv-pair');
            c.append(left);
            // The code as a picture too: a phone scans it and lands in this room.
            const qr = el('div', 'tv-qr');
            c.appendChild(qr);
            qrSvg(link).then(svg => { qr.innerHTML = svg; }).catch(() => { qr.remove(); c.classList.remove('tv-pair'); });
            focusEl(close);
        });
    }

    // "Watch together" starts an empty room and shows its QR code. The phone scans it, joins,
    // brings its addons, and picks what to play; the TV plays it.
    function startWithPhone() {
        let who = 'TV';
        try { who = localStorage.getItem('reddate-name') || 'TV'; } catch (e) { /* fine */ }
        window.reddateRoom.enterRoom(who, null, () => showInvite());
    }

    // Search on TV: the search field appears at the top; Back closes it.
    function openSearch() {
        html.classList.add('tv-search');
        const input = $('homeSearch');
        setTimeout(() => { input.focus(); input.select(); }, 30);
    }
    function closeSearch() {
        html.classList.remove('tv-search');
        const input = $('homeSearch');
        if (input.value) { input.value = ''; input.dispatchEvent(new Event('input')); }
        toRail();
    }

    // The side menu (Google TV style): icons, with labels when it has focus.
    function buildRail() {
        if ($('tvRail') || !$('home')) return;
        const rail = el('nav', 'tv-rail');
        rail.id = 'tvRail';
        rail.setAttribute('aria-label', 'Menu');
        const item = (id, ic, label, fn) => {
            const b = el('button', 'tv-rail-item');
            b.id = id;
            b.append(icon(ic), el('span', 'tv-rail-label', label));
            b.onclick = fn;
            rail.appendChild(b);
        };
        item('railSearch', 'search', 'Search', openSearch);
        item('railHome', 'home', 'Home', () => { if (html.classList.contains('tv-search')) closeSearch(); window.scrollTo({ top: 0, behavior: 'instant' }); focusFirstPoster(); });
        item('railTogether', 'users', 'Watch together', startWithPhone);
        item('railYouTube', 'youtube', 'YouTube', () => window.reddatePages.openYouTube());
        item('railAddons', 'plus', 'Addons', () => window.reddatePages.openAddons());
        const acct = window.reddateAccount;
        if (acct && acct.isEnabled && acct.isEnabled()) item('railAccount', 'user', acct.profileName() || 'Account', () => acct.open());
        $('home').appendChild(rail);
    }

    // A YouTube video plays in the page's own full-screen player, so the room's tools sit on a small bar over it:
    // Up shows Invite, Chat and Close; Left/Right choose, OK presses, Down or Back hides it.
    let ytBar = null, ytBarTimer = 0;
    const ytBarOpen = () => !!(ytBar && ytBar.classList.contains('on') && ytBar.dataset.focus === '1');
    function ytBarShow(focus) {
        if (!ytBar) {
            ytBar = el('div', 'tv-ytbar');
            ytBar.setAttribute('role', 'toolbar');
            [['Invite', () => { ytBarHide(); showInvite(); }], ['Chat', () => { ytBarHide(); showChat(); }], ['Close video', () => { ytBarHide(); setTheater(false); focusFirstControl(); }]].forEach(([t, fn]) => {
                const b = el('button', 'btn', t); b.type = 'button'; b.onclick = fn; ytBar.appendChild(b);
            });
            document.body.appendChild(ytBar);
        }
        ytBar.classList.add('on');
        ytBar.dataset.focus = focus ? '1' : '0';
        clearTimeout(ytBarTimer);
        ytBarTimer = setTimeout(ytBarHide, focus ? 8000 : 4000);
        if (focus) { const b = ytBar.querySelector('button'); if (b) focusEl(b); }
    }
    function ytBarHide() {
        clearTimeout(ytBarTimer);
        if (ytBar) { ytBar.classList.remove('on'); ytBar.dataset.focus = '0'; }
        if (ytBar && ytBar.contains(document.activeElement)) document.activeElement.blur();
    }
    function ytBarKey(key, ev) {
        if (!ytBarOpen()) { ytBarShow(true); return true; }
        const bs = [...ytBar.querySelectorAll('button')], i = bs.indexOf(document.activeElement);
        clearTimeout(ytBarTimer); ytBarTimer = setTimeout(ytBarHide, 8000);
        if (key === 'ArrowDown' || key === 'ArrowUp') { ytBarHide(); return true; }
        if (key === 'ArrowLeft') { focusEl(bs[Math.max(0, i - 1)] || bs[0]); return true; }
        if (key === 'ArrowRight') { focusEl(bs[Math.min(bs.length - 1, i + 1)] || bs[0]); return true; }
        if (key === 'Enter' || key === ' ') { (bs[i] || bs[0]).click(); return true; }
        return false;
    }
    // The remote belongs to Reddate, not to YouTube's own buttons: the player is made unfocusable (inert) so the keys
    // stay on this page (play/pause, skip, the bar). A video starting shows the bar for a moment, so people know it is there.
    new MutationObserver(() => {
        const f = document.querySelector('#videoPlayer iframe');
        if (!f || window.__nativeOpen) return;
        if (!f.inert) { f.inert = true; f.setAttribute('tabindex', '-1'); if (document.activeElement === f) { f.blur(); window.focus(); } }
        if (!f.dataset.barShown) { f.dataset.barShown = '1'; setTimeout(() => { if (typeof theater !== 'undefined' && theater) ytBarShow(false); }, 1500); }
    }).observe($('videoPlayer'), { childList: true, subtree: true });
    // Back closes the bar before it leaves the video.
    const backYt = () => { if (ytBar && ytBar.classList.contains('on')) { ytBarHide(); return true; } return false; };
    window.__tvBackYt = backYt;

    // An "Invite phones" button next to Browse / Play / Sync once the app is on screen.
    function addInviteButton() {
        const controls = document.querySelector('.video-controls');
        if (!controls || $('tvInviteBtn')) return;
        const b = el('button', 'btn', 'Invite');
        b.id = 'tvInviteBtn';
        b.onclick = showInvite;
        const c = el('button', 'btn', 'Chat');
        c.id = 'tvChatBtn';
        c.onclick = showChat;
        controls.append(b, c);
    }

    // ---------- native screens ----------
    // The TV app draws Home, title pages, search, profiles… natively (Jetpack Compose). This page stays
    // underneath as the engine: rooms, sync, chat, accounts. The app asks it things through rpc(), and
    // the page tells the app when one of its own screens (sign-in, addons, account, chat, a YouTube
    // video) needs to be on top.
    let appEntered = false;
    const nativeUi = !!(native && native.hasNativeUi && native.hasNativeUi());
    const toNative = obj => { if (native && native.event) native.event(JSON.stringify(obj)); };
    function wantWeb() {
        if (!appEntered || !root.hidden) return true;
        if (window.reddatePages && window.reddatePages.isOpen()) return true;
        if (document.querySelector('.modal.show')) return true;
        return typeof theater !== 'undefined' && theater && !window.__nativeOpen; // a YouTube / web video is on screen
    }
    let lastWeb = null;
    function checkSurface() {
        if (!nativeUi) return;
        const w = wantWeb();
        if (w === lastWeb) return;
        lastWeb = w;
        toNative({ type: 'surface', web: w });
    }
    if (nativeUi) {
        html.classList.add('tv-native');
        new MutationObserver(() => requestAnimationFrame(checkSurface)).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class', 'hidden'] });
        setInterval(checkSurface, 1000);
        document.addEventListener('reddate:account', () => toNative({ type: 'account' }));
        // Signed out (from the TV's Account screen, or because another device removed this one): start over at the
        // sign-in screen. A fresh page is the cleanest way to drop the room, the rows and the profile.
        document.addEventListener('reddate:account', () => {
            const A = window.reddateAccount;
            if (!appEntered || !A || !A.isEnabled() || A.isSignedIn() || /[?&]embed=1/.test(location.search)) return;
            setTimeout(() => { if (!A.isSignedIn()) location.reload(); }, 400);
        });
        // Only tell the app to rebuild Home when its rows really changed: a rebuild loses the remote's place
        // (it used to jump to the menu after a subtitle choice or a progress save changed a setting).
        window.__homeMaybeChanged = f => homeMaybeChanged(f);
        let rowsSig = '', cwSig = '[]';
        const rowsNow = () => { try { return JSON.stringify(window.reddateHome.nativeRows()); } catch (e) { return ''; } };
        // Continue watching: which titles (not the minutes), so a progress save doesn't rebuild anything.
        const cwNow = () => { try { return JSON.stringify(window.reddateContinue.list().map(e => [e.k, e.id, e.next || 0])); } catch (e) { return '[]'; } };
        const homeMaybeChanged = force => {
            const sig = rowsNow(), cw = cwNow();
            if (!force && sig && sig === rowsSig && cw === cwSig) return;
            rowsSig = sig; cwSig = cw;
            toNative({ type: 'home-changed' });
        };
        setTimeout(() => homeMaybeChanged(false), 3000);
        document.addEventListener('reddate:prefs', () => setTimeout(() => homeMaybeChanged(false), 50));
        document.addEventListener('reddate:vault-updated', () => setTimeout(() => homeMaybeChanged(false), 300));
        document.addEventListener('reddate:account', () => setTimeout(() => homeMaybeChanged(false), 1500));
        document.addEventListener('reddate:addons-changed', () => homeMaybeChanged(true)); // added on the phone
    }
    function sendPayload(payload) {
        // A YouTube video from Reddate YT (or any addon) comes as a youtube.com link: it plays in the YouTube player.
        const ytFromLink = payload && payload.kind === 'direct' ? youtubeIdOf(String(payload.src || '')) : null;
        if (ytFromLink) payload = { kind: 'yt', videoId: ytFromLink, url: payload.src, title: payload.title };
        if (window.reddateAutoPlayNext) window.reddateAutoPlayNext();
        if (payload.startAt) { window.reddateResumeAt(payload.startAt); delete payload.startAt; }
        // Remember this stream's kind for the show (or movie), so the next episode picks the same.
        const c = payload.content;
        if (payload.kind === 'direct' && c && window.reddateAddons.rememberChoice) window.reddateAddons.rememberChoice(c.show || c.id, payload.src);
        const room = window.reddateRoom;
        const send = () => socket.emit('load-video', payload);
        if (room.isInRoom()) send();
        else room.enterRoom(room.savedName() || 'TV', null, send, { lazy: true });
    }
    const youtubeIdOf = url => { const m = String(url).match(/(?:youtu\.be\/|[?&]v=|\/(?:shorts|embed|live)\/)([\w-]{11})/); return m ? m[1] : null; };
    const RPC = {
        state() {
            const A = window.reddateAccount, R = window.reddateRoom;
            const inRoom = R.isInRoom();
            return {
                entered: appEntered, accounts: A.isEnabled(), signedIn: A.isSignedIn(),
                profile: A.profileName(), profileId: A.activeProfileId(), profiles: A.profiles(),
                inRoom, roomCode: R.roomCode(), invite: inRoom ? `${window.reddateWebOrigin || location.origin}/join/${encodeURIComponent(R.roomCode() || R.roomId())}` : '',
                nowPlaying: inRoom ? document.getElementById('nowPlaying').textContent : '',
                people: typeof roomUsers !== 'undefined' ? roomUsers.map(u => u.name) : [],
                isGuest: inRoom && R.isGuest(), hostName: inRoom ? R.hostName() : ''
            };
        },
        // Home rows: after the addons have loaded (so a slow addon's rows are in the first list).
        rows: async () => { await window.reddateAddons.manage.whenLoaded(7000); return window.reddateHome.nativeRows(); },
        meta: ({ type, id }) => window.reddateAddons.fullMeta(type, id),
        streams: ({ type, id, key }) => window.reddateAddons.streamsFor(type, id, key),
        streamsMore: ({ type, id, key }) => window.reddateAddons.streamsMore(type, id, key),
        streamInfo: ({ type, id }) => window.reddateAddons.lookupInfo(type, id),
        streamNotes: ({ type, id }) => window.reddateAddons.notesFor(type, id),
        continueRow: () => window.reddateContinue.list(),
        forgetContinue({ k }) { window.reddateContinue.remove(String(k)); return true; },
        // Continue watching: the same kind of stream as last time, starting where you stopped.
        async resolveResume({ k }) {
            const e = window.reddateContinue.list().find(x => x.k === k);
            if (!e) throw new Error('Not in Continue watching any more');
            const list = await window.reddateAddons.streamsFor(e.t, e.id, e.sh || e.id);
            if (!list.length) throw new Error('No streams found for this right now');
            const best = window.reddatePickRemembered(list);
            // The best match first, then the next closest ones: the TV checks them and falls back if the first is dead.
            const rest = list.filter(s => s !== best).sort((a, b) => (b.match - a.match));
            const candidates = [best, ...rest].slice(0, 8).map(s => ({ url: s.url, addon: s.addon, name: s.name, title: s.title, quality: s.quality, filename: s.filename, logo: s.logo, bitrate: s.bitrate, match: s.match }));
            return {
                label: e.n,
                candidates,
                payload: { kind: 'direct', src: best.url, title: e.n, startAt: e.p,
                    content: { type: e.t, id: e.id, filename: (best.filename || best.title || '').slice(0, 200), art: e.a || undefined, show: e.sh || undefined } }
            };
        },
        search: ({ q }) => window.reddateHome.nativeSearch(String(q || '')),
        play({ payload }) {
            if (!payload || (payload.kind !== 'direct' && payload.kind !== 'yt')) throw new Error('Nothing to play');
            sendPayload(payload);
            return true;
        },
        playLink({ url }) {
            const u = String(url || '').trim();
            const id = youtubeIdOf(u);
            if (id) { sendPayload({ kind: 'yt', videoId: id, url: u }); return true; }
            if (/^https?:\/\/\S+\.(mp4|webm|ogg|ogv|m4v|mov|m3u8|mkv)(\?\S*)?$/i.test(u)) { sendPayload({ kind: 'direct', src: u }); return true; }
            throw new Error('That doesn’t look like a YouTube link or a video file link.');
        },
        resume() {
            if (typeof vp === 'undefined' || !vp) return false;
            if (vp.reopen) vp.reopen(); else setTheater(true);
            return true;
        },
        leaveRoom() { window.reddateRoom.leave(); return true; },
        joinCode: ({ code }) => window.reddateJoinByCode(String(code || '')),
        async together() {
            const R = window.reddateRoom;
            if (R.isInRoom() && R.isLive()) return { ok: true };
            const joined = waitForJoin();
            R.enterRoom(R.savedName() || 'TV', null);
            R.goLive();
            return joined;
        },
        chooseProfile({ id }) { window.reddateAccount.chooseProfile(id); return true; },
        async addProfile({ name }) { const id = await window.reddateAccount.addProfile(name); return { ok: !!id, id: id || '' }; },
        async renameProfile({ id, name }) { return { ok: await window.reddateAccount.renameProfile(id, name) }; },
        async removeProfile({ id }) { return { ok: await window.reddateAccount.removeProfile(id) }; },
        openWeb({ screen }) {
            if (screen === 'addons') window.reddatePages.openAddons();
            else if (screen === 'account') window.reddateAccount.open();
            else if (screen === 'profiles') window.reddateAccount.openManage();
            else if (screen === 'chat') showChat();
            else if (screen === 'invite') showInvite();
            checkSurface();
            return true;
        },
        // ---- the app's own Addons and Account screens ----
        async addons() { await window.reddateAddons.ready; await window.reddateAddons.manage.describeAll(6000); return window.reddateAddons.manage.list(); },
        async addonAdd({ url }) { const r = await window.reddateAddons.manage.add(String(url || '')); (window.__homeMaybeChanged || (() => {}))(true); return r; },
        async addonRemove({ url }) { await window.reddateAddons.manage.remove(String(url)); (window.__homeMaybeChanged || (() => {}))(true); return true; },
        async syncAddons() { return window.reddateAddons.manage.resync(); },
        async addonRemoveMany({ urls }) { await window.reddateAddons.manage.removeMany((urls || []).map(String)); (window.__homeMaybeChanged || (() => {}))(true); return true; },
        addonEnable({ url, on }) { window.reddateAddons.manage.setEnabled(String(url), !!on); (window.__homeMaybeChanged || (() => {}))(true); return true; },
        addonSuggested: () => window.reddateAddons.manage.suggested(),
        async addonRestore({ url }) { const r = await window.reddateAddons.manage.restore(String(url)); (window.__homeMaybeChanged || (() => {}))(true); return r; },
        // Home rows: which are shown and in what order (the old page's "Home rows" tab).
        homeRows: () => window.reddateHome.rowList(),
        setHomeRows({ rows }) { window.reddateHome.setRows((rows || []).map(r => ({ key: String(r.key), title: String(r.title || ''), visible: !!r.visible }))); return true; },
        // The TV came back to the screen (or woke up): check for changes made on other devices right away.
        async refreshVault() { await window.reddateAccount.refresh(); return true; },
        accountInfo() {
            const A = window.reddateAccount;
            return { signedIn: A.isSignedIn(), email: A.email(), verified: A.verified(), profile: A.profileName() || '', profiles: A.profiles().length, device: A.deviceName(), site: window.reddateWebOrigin || location.origin };
        },
        // The browser app signs in with email and password itself, then hands the session to this engine.
        async adoptToken({ token }) { return window.reddateAccount.adoptToken(String(token || '')); },
        // One catalog page (a row's items), fetched the way the page fetches addon data.
        getJson: ({ url }) => window.reddateAddons.getJson(String(url)),
        ready: async () => { await window.reddateAddons.ready; return true; },
        resendConfirm: () => window.reddateAccount.resendConfirm(),
        async signOut() { await window.reddateAccount.signOut(); return true; },
        // Opening the invite is what makes the room real: until then nothing is on the server.
        devices: () => { if (window.reddateRoom) window.reddateRoom.goLive(); return window.reddateDevices ? window.reddateDevices.list() : []; },
        goLive() { if (window.reddateRoom) window.reddateRoom.goLive(); return true; },
        // Upcoming releases (the Calendar): in cinemas, digital / VOD, and new TV episodes for a country.
        async calendar({ region }) {
            const rg = region === 'WW' ? 'WW' : /^[A-Z]{2}$/.test(String(region || '')) ? region : 'US';
            const r = await fetch(`/api/calendar?region=${rg}&days=45`);
            if (!r.ok) throw new Error('The calendar is unavailable right now.');
            return r.json();
        },
        // Connected services (Trakt, WeTrakr, Simkl): the list, connecting with a code, and turning reporting on or off.
        async trackers() { const r = await window.reddateAccount.api('/api/trackers'); if (!r.ok) throw new Error(r.data.error || 'Sign in first.'); return r.data.services; },
        async trackerConnect({ svc }) { const r = await window.reddateAccount.api(`/api/trackers/${encodeURIComponent(svc)}/connect`, { method: 'POST' }); if (!r.ok) throw new Error(r.data.error || 'Couldn’t start that.'); return r.data; },
        async trackerPoll({ svc }) { const r = await window.reddateAccount.api(`/api/trackers/${encodeURIComponent(svc)}/poll`, { method: 'POST' }); if (!r.ok) throw new Error(r.data.error || 'Couldn’t check that.'); return r.data; },
        async trackerDisconnect({ svc }) { await window.reddateAccount.api(`/api/trackers/${encodeURIComponent(svc)}`, { method: 'DELETE' }); return true; },
        async trackerScrobble({ svc, on }) { await window.reddateAccount.api(`/api/trackers/${encodeURIComponent(svc)}`, { method: 'PUT', body: { scrobble: !!on } }); return true; },
        inviteDevice({ id }) { window.reddateDevices.invite(id); return true; },
        mediaTracks: ({ url }) => (window.reddateAddons.readTracks ? window.reddateAddons.readTracks(url) : null),
        // Chat without needing a player on screen: the room's recent lines, sending, and "typing…".
        chatHistory() {
            const room = window.reddateRoom && window.reddateRoom.roomId ? window.reddateRoom.roomId() : '';
            return chatLog.filter(m => m.room === room).map(m => ({ user: m.user || '', text: m.t === 'img' ? 'sent a photo' : m.v, self: !!m.self, at: m.at || 0 }));
        },
        sendChat({ text }) {
            const v = String(text || '').trim();
            if (!v) return false;
            if (!window.reddateRoom || !window.reddateRoom.isInRoom()) throw new Error('You’re not in a room right now.');
            window.reddateChat.send(v);
            return true;
        },
        typing({ on }) { if (typeof socket !== 'undefined' && socket && socket.connected) socket.emit(on ? 'typing-start' : 'typing-stop'); return true; },
        inviteAll() { window.reddateDevices.inviteAll(); return true; },
        answerInvite({ roomId: id, accept }) { window.reddateDevices.answer(String(id), !!accept); return true; },
        back() { back(); setTimeout(checkSurface, 50); return true; }
    };
    window.ReddateTV = Object.assign(window.ReddateTV || {}, {
        // The native app asks; the answer comes back through ReddateNative.reply(id, json).
        rpc(id, method, argsJson) {
            Promise.resolve().then(() => {
                if (!RPC[method]) throw new Error(`unknown ${method}`);
                return RPC[method](argsJson ? JSON.parse(argsJson) : {});
            }).then(r => native.reply(id, JSON.stringify({ ok: true, r: r === undefined ? null : r })),
                e => native.reply(id, JSON.stringify({ ok: false, error: String((e && e.message) || e) })));
        }
    });

    // The engine page stays loaded for days on a TV. When the site's scripts change, reload it at a quiet moment
    // (not in a party, nothing playing) so fixes reach the TV without anyone restarting the app.
    (function selfUpdate() {
        let first = null;
        const check = () => {
            fetch('/api/web-version', { cache: 'no-store' }).then(r => r.json()).then(d => {
                if (!d || !d.v) return;
                if (first === null) { first = d.v; return; }
                if (d.v === first) return;
                const R = window.reddateRoom;
                const busy = window.__nativeOpen || (R && R.isInRoom && R.isInRoom());
                if (!busy) location.reload();
            }).catch(() => {});
        };
        check();
        setInterval(check, 5 * 60 * 1000);
    })();

    // ---------- chat on the TV ----------
    // New messages float in over the video for a few seconds, then fade. "Chat" shows the
    // conversation, switches the pop-ups on or off, and replies with the TV's keyboard.
    const CHAT_KEY = 'reddate-tv-chat';
    let chatOn = true;
    try { chatOn = localStorage.getItem(CHAT_KEY) !== '0'; } catch (e) { /* fine */ }
    const chatLog = [];
    function setChatOn(on) {
        chatOn = on;
        try { localStorage.setItem(CHAT_KEY, on ? '1' : '0'); } catch (e) { /* fine */ }
        if (!on && $('tvChatStack')) $('tvChatStack').innerHTML = '';
    }
    window.ReddateTV = Object.assign(window.ReddateTV || {}, { chatOn: () => chatOn, setChatOn });

    function chatStack() {
        let s = $('tvChatStack');
        if (!s) { s = el('div', 'tv-chat-stack'); s.id = 'tvChatStack'; s.setAttribute('aria-live', 'polite'); document.body.appendChild(s); }
        return s;
    }
    function popChat(m) {
        const s = chatStack();
        const b = el('div', 'tv-chat-bubble');
        b.append(el('b', null, m.user || 'Someone'), document.createTextNode(m.t === 'img' ? ' sent a photo' : ` ${m.v}`));
        s.appendChild(b);
        while (s.children.length > 4) s.firstChild.remove();
        setTimeout(() => b.classList.add('is-gone'), 7000);
        setTimeout(() => b.remove(), 7600);
    }
    document.addEventListener('reddate:chat', e => {
        const m = e.detail;
        m.room = window.reddateRoom && window.reddateRoom.roomId ? window.reddateRoom.roomId() : '';
        m.at = Date.now();
        // Every line, whatever screen is up: the browser app keeps its own chat (the TV app ignores this).
        toNative({ type: 'chat-msg', user: m.user || '', text: m.t === 'img' ? 'sent a photo' : m.v, self: !!m.self, at: m.at, room: m.room });
        chatLog.push(m);
        if (chatLog.length > 50) chatLog.shift();
        if (!root.hidden && root.dataset.kind === 'chat') { showChat(); return; } // the chat screen is open: refresh it
        if (window.__nativeOpen && native && native.command) {
            native.command(JSON.stringify({ cmd: 'chat', user: m.user || '', text: m.t === 'img' ? 'sent a photo' : m.v, self: !!m.self, rname: m.reply ? String(m.reply.name || '').slice(0, 40) : '', rtext: m.reply ? String(m.reply.text || '').slice(0, 120) : '' }));
            return;
        }
        if (chatOn && !m.self) popChat(m);
    });

    function showChat() {
        const keepTyped = root.dataset.kind === 'chat' && root.querySelector('.tv-chat-input') ? root.querySelector('.tv-chat-input').value : '';
        showScreen(c => {
            root.dataset.kind = 'chat';
            c.classList.add('tv-chat');
            const head = el('div', 'tv-chat-head');
            head.appendChild(el('h1', null, 'Party chat'));
            const toggle = el('button', 'btn', chatOn ? 'Pop-ups: On' : 'Pop-ups: Off');
            toggle.onclick = () => { setChatOn(!chatOn); toggle.textContent = chatOn ? 'Pop-ups: On' : 'Pop-ups: Off'; };
            head.appendChild(toggle);
            c.appendChild(head);
            const list = el('div', 'tv-chat-list');
            if (!chatLog.length) list.appendChild(el('p', 'tv-sub', 'No messages yet. Say hi!'));
            chatLog.slice(-15).forEach(m => {
                const who = m.self ? 'You' : (m.user || 'Someone');
                const row = el('div', `tv-chat-line ${m.self ? 'is-self' : ''}`);
                if (!m.self) { const av = el('span', 'tv-chat-av', who.trim().charAt(0).toUpperCase() || '?'); av.style.background = personColor(who); row.appendChild(av); }
                const bub = el('div', 'tv-chat-bub');
                if (!m.self) { const n = el('b', null, who); n.style.color = personColor(who); bub.appendChild(n); }
                bub.appendChild(el('span', null, m.t === 'img' ? 'sent a photo' : m.v));
                row.appendChild(bub);
                list.appendChild(row);
            });
            c.appendChild(list);
            // Quick replies: one press sends them, so nobody types with the remote.
            const quick = el('div', 'tv-quick');
            ['Pause!', 'Next one?', 'Snack break', '😂', '🔥', '👍', '❤️'].forEach(q => {
                const b = el('button', 'btn tv-quick-btn', q);
                b.type = 'button';
                b.onclick = () => window.reddateChat.send(q);
                quick.appendChild(b);
            });
            c.appendChild(quick);
            const form = el('form', 'tv-chat-form');
            const input = el('input', 'lobby-input tv-chat-input');
            input.placeholder = 'Type a reply';
            input.maxLength = 500;
            input.value = keepTyped;
            input.setAttribute('aria-label', 'Reply');
            input.enterKeyHint = 'send';
            const send = el('button', 'btn btn-primary', 'Send');
            send.type = 'submit';
            form.append(input, send);
            form.onsubmit = e => { e.preventDefault(); const v = input.value.trim(); if (!v) return; input.value = ''; window.reddateChat.send(v); };
            c.appendChild(form);
            list.scrollTop = list.scrollHeight;
        });
        // Straight to the reply box (the screen is on the page only now, so focus it here, not while building).
        const inp = root.querySelector('.tv-chat-input');
        if (inp) {
            focusEl(inp);
            // The app brings this page to the front just after, and the TV then moves focus to the first button:
            // put it back on the reply box once that has happened.
            [200, 600].forEach(ms => setTimeout(() => { if (inp.isConnected && document.activeElement !== inp) focusEl(inp); }, ms));
        }
        const list = root.querySelector('.tv-chat-list');
        if (list) list.scrollTop = list.scrollHeight;
    }

    function splash(text) {
        showScreen(c => {
            c.appendChild(tvMark());
            c.appendChild(el('p', 'tv-sub', text));
        });
    }

    // QR codes: a small library, fetched only when the sign-in screen is shown.
    let qrPromise = null;
    function loadQr() {
        if (window.qrcode) return Promise.resolve(window.qrcode);
        if (!qrPromise) {
            qrPromise = new Promise((resolve, reject) => {
                const s = document.createElement('script');
                s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js';
                s.onload = () => resolve(window.qrcode);
                s.onerror = () => { qrPromise = null; reject(new Error('qr library failed to load')); };
                document.head.appendChild(s);
            });
        }
        return qrPromise;
    }
    async function qrSvg(text) {
        const qrcode = await loadQr();
        const qr = qrcode(0, 'M');
        qr.addData(text);
        qr.make();
        return qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
    }

    const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    // The browser's own SHA-256 needs a secure page (https) and a modern engine. A TV's built-in
    // browser may have neither, so there is a small built-in fallback (our inputs are short ASCII tokens).
    function sha256Js(ascii) {
        const K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
            0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
            0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
            0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
        const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
        const rot = (v, n) => (v >>> n) | (v << (32 - n));
        const bytes = [];
        for (let i = 0; i < ascii.length; i++) bytes.push(ascii.charCodeAt(i) & 0xff);
        const bitLen = bytes.length * 8;
        bytes.push(0x80);
        while (bytes.length % 64 !== 56) bytes.push(0);
        for (let i = 0; i < 8; i++) bytes.push(i < 4 ? 0 : (bitLen >>> ((7 - i) * 8)) & 0xff);
        const w = new Array(64);
        for (let o = 0; o < bytes.length; o += 64) {
            for (let i = 0; i < 16; i++) w[i] = (bytes[o + 4 * i] << 24) | (bytes[o + 4 * i + 1] << 16) | (bytes[o + 4 * i + 2] << 8) | bytes[o + 4 * i + 3];
            for (let i = 16; i < 64; i++) {
                const s0 = rot(w[i - 15], 7) ^ rot(w[i - 15], 18) ^ (w[i - 15] >>> 3);
                const s1 = rot(w[i - 2], 17) ^ rot(w[i - 2], 19) ^ (w[i - 2] >>> 10);
                w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
            }
            let [a, b, c, d, e, f, g, hh] = h;
            for (let i = 0; i < 64; i++) {
                const t1 = (hh + (rot(e, 6) ^ rot(e, 11) ^ rot(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
                const t2 = ((rot(a, 2) ^ rot(a, 13) ^ rot(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
                hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
            }
            h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
            h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
        }
        return h.map(x => (x >>> 0).toString(16).padStart(8, '0')).join('');
    }
    async function sha256Hex(text) {
        if (window.crypto && crypto.subtle) {
            try {
                const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
                return Array.from(new Uint8Array(h), x => x.toString(16).padStart(2, '0')).join('');
            } catch (e) { /* fall through */ }
        }
        return sha256Js(text);
    }
    window.__sha256Js = sha256Js; // exposed so it can be tested
    const tvName = () => (native && native.deviceName ? native.deviceName() : 'Android TV');

    // Sign-in: show a code + QR; a signed-in phone approves it; we keep our own token.
    let pairingRun = 0;
    async function pairing() {
        const run = ++pairingRun;
        for (;;) {
            if (run !== pairingRun) return false;
            const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
            const start = await fetch('/api/device/start', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: tvName(), tokenHash: await sha256Hex(token) })
            }).then(r => r.json()).catch(() => null);
            if (!start || !start.userCode) {
                showScreen(c => {
                    c.appendChild(tvMark());
                    c.appendChild(el('p', 'tv-sub', 'Can’t reach Reddate. Check the TV’s internet connection.'));
                    const retry = el('button', 'btn btn-primary tv-big', 'Try again');
                    retry.onclick = () => { pairingRun++; pairing().then(afterSignIn); };
                    c.appendChild(retry);
                });
                return false;
            }
            const link = `${window.reddateWebOrigin || location.origin}/?link=${start.userCode}`;
            let svg = '';
            try { svg = await qrSvg(link); } catch (e) { /* the code alone still works */ }
            showScreen(c => {
                c.classList.add('tv-pair');
                const left = el('div', 'tv-pair-text');
                left.appendChild(tvMark());
                left.appendChild(el('h1', null, 'Sign in on your phone'));
                const steps = el('ol', 'tv-steps');
                ['Scan the code with your phone’s camera', 'Sign in (or create an account)', 'Tap “Yes, add it”'].forEach(t => steps.appendChild(el('li', null, t)));
                left.appendChild(steps);
                left.appendChild(el('p', 'tv-sub', `Or open ${location.host}/app on any device, go to Account → Devices & TVs, and enter:`));
                left.appendChild(el('div', 'tv-code mono', start.userCode));
                const right = el('div', 'tv-qr');
                if (svg) right.innerHTML = svg; else right.appendChild(el('p', 'tv-sub', 'QR code unavailable — use the code'));
                c.append(left, right);
            });
            // Wait for approval (or for the code to expire, then make a fresh one).
            const until = Date.now() + (start.expiresIn - 5) * 1000;
            while (Date.now() < until) {
                await new Promise(r => setTimeout(r, (start.interval || 3) * 1000));
                if (run !== pairingRun) return false;
                const p = await fetch('/api/device/poll', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ deviceCode: start.deviceCode })
                }).then(r => r.json()).catch(() => ({ status: 'pending' }));
                if (p.status === 'approved') {
                    splash('Signing in…');
                    return window.reddateAccount.adoptToken(token);
                }
                if (p.status === 'expired') break;
            }
        }
    }

    function whoIsWatching() {
        const acct = window.reddateAccount;
        showScreen(c => {
            c.appendChild(tvMark());
            c.appendChild(el('h1', null, 'Who’s watching?'));
            const row = el('div', 'tv-profiles');
            acct.profiles().forEach(p => {
                const b = el('button', 'tv-profile');
                b.appendChild(el('span', 'avatar tv-avatar', (p.name || '?').trim().charAt(0).toUpperCase() || '?'));
                b.appendChild(el('span', 'tv-profile-name', p.name));
                b.onclick = () => { acct.chooseProfile(p.id); enterApp(p.name); };
                row.appendChild(b);
            });
            c.appendChild(row);
        });
    }

    // ---------- start ----------
    function enterApp(name) {
        appEntered = true;
        pairingRun++;
        hideScreen();
        const who = name || (window.reddateAccount && window.reddateAccount.profileName()) || 'TV';
        try { localStorage.setItem('reddate-name', who); } catch (e) { /* fine */ }
        addInviteButton();
        buildRail();
        if (document.documentElement.dataset.screen === 'lobby') {
            // Opened from an invite link: join that room straight away.
            $('usernameInput').value = who;
            $('lobbyBtn').click();
        } else {
            window.reddateRoom.showHome(); // the catalog; a room starts when something is played
            focusFirstPoster();
        }
        if (DEV_LOG) {
            let tries = 0;
            const t = setInterval(() => {
                if (typeof socket !== 'undefined' && socket) {
                    clearInterval(t);
                    devlog('socket', { connected: socket.connected, room: roomId });
                    socket.on('video-loaded', d => {
                        devlog('video-loaded', { kind: d.kind, src: String(d.src).slice(0, 80) });
                        setTimeout(() => devlog('after-video-loaded', {
                            hasVp: typeof vp !== 'undefined' && !!vp, ready: typeof isPlayerReady !== 'undefined' && isPlayerReady,
                            playerChildren: document.querySelector('#videoPlayer').children.length, status: document.getElementById('playerStatus').textContent
                        }), 1500);
                    });
                } else if (++tries > 40) clearInterval(t);
            }, 250);
        }
    }

    function afterSignIn(signedIn) {
        if (!signedIn) return;
        const acct = window.reddateAccount;
        if (acct.profiles().length > 1) {
            // The native app has its own "Who's watching?" screen; otherwise the page's.
            if (nativeUi) { enterApp(acct.profileName()); toNative({ type: 'pick-profile' }); } else whoIsWatching();
        } else enterApp(acct.profileName());
    }

    async function boot() {
        splash('Starting…');
        const acct = window.reddateAccount;
        if (!acct.isReady()) await new Promise(r => document.addEventListener('reddate:account-ready', r, { once: true }));
        if (!acct.isEnabled()) { enterApp(null); return; }            // accounts are off on this server
        if (acct.isSignedIn()) { afterSignIn(true); return; }
        afterSignIn(await pairing());
    }

    // A video loading puts the TV into full-screen playback; Back returns to the menus.
    let hadVideo = false;
    new MutationObserver(() => {
        const has = !!document.querySelector('#videoPlayer > *');
        if (has && !hadVideo && !document.querySelector('.modal.show')) {
            hadVideo = true;
            setTimeout(() => { if (!theater) setTheater(true); }, 400);
        }
        if (!has) hadVideo = false;
    }).observe($('videoPlayer'), { childList: true });

    // Keep the focus ring on something whenever a dialog opens or closes.
    new MutationObserver(() => {
        const cur = document.activeElement;
        if (!cur || cur === document.body || !candidates().includes(cur)) {
            const first = candidates()[0];
            if (first && !root.hidden) focusEl(first);
        }
    }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });

    // "Browse" in the room goes to Home: put the focus on the catalog.
    document.addEventListener('click', e => { if (e.target.closest('#browseBtn, #emptyBrowseBtn')) focusFirstPoster(); }, true);
    // Addons / YouTube page: put the focus on its first control.
    new MutationObserver(() => {
        const pg = $('managePage');
        if (!pg || pg.hidden) return;
        setTimeout(() => { const f = [...pg.querySelectorAll(FOCUSABLE)].filter(visible)[0]; if (f && !pg.contains(document.activeElement)) focusEl(f); }, 120);
    }).observe($('managePage'), { attributes: true, attributeFilter: ['hidden'] });
    // Opening a title: focus its Play button (or the first episode for a show).
    new MutationObserver(() => {
        if ($('titlePage').hidden) return;
        setTimeout(() => { const p = $('titlePlay'); if (p && !p.disabled && visible(p)) focusEl(p); else { const f = candidates().find(c => c.id !== 'detailBackBtn'); if (f) focusEl(f); } }, 300);
    }).observe($('titlePage'), { attributes: true, attributeFilter: ['hidden'] });

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
