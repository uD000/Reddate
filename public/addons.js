/* Stremio-compatible addons: browse catalogs, pick a stream, watch together.
 *
 * Addons are plain HTTP services (manifest.json + /catalog, /meta, /stream
 * JSON endpoints) that send `Access-Control-Allow-Origin: *`, so the browser
 * talks to them directly — the Reddate server never proxies them.
 *
 * Addon URLs often embed personal auth tokens. A room's addon list is shared
 * with everyone in the room through the server, which keeps it in memory only
 * while the room exists and never logs it. The stream URL someone picks to play
 * also goes through the server, exactly like pasting a direct video link.
 *
 * initAddons() is called from app.js once the socket exists.
 */
window.initAddons = function (socket, { getRoomId, toast }) {
    // Built-ins: a catalog (browsing works before anything is added) and a
    // subtitle source. Reddate ships no stream source — rooms add their own.
    // The catalog is Reddate's own (TMDB, served by our server) when the server
    // has one configured, otherwise Stremio's public Cinemeta.
    const CINEMETA_URL = 'https://v3-cinemeta.strem.io/manifest.json';
    const OPENSUBS_URL = 'https://opensubtitles-v3.strem.io/manifest.json';
    let catalogUrl = CINEMETA_URL;
    // Reddate YT (hosted by our server, /yt): built in as a set-up entry; your own link (made on /yt) replaces it.
    const YT_URL = new URL('/yt/manifest.json', location.origin).toString();
    let BUILT_INS = [catalogUrl, YT_URL, OPENSUBS_URL];
    const ready = fetch('/api/catalog/config').then(r => r.json()).then(cfg => {
        if (cfg && cfg.enabled && cfg.manifest) {
            catalogUrl = new URL(cfg.manifest, location.origin).toString();
            BUILT_INS = [catalogUrl, YT_URL, OPENSUBS_URL];
        }
    }).catch(() => {}).then(() => Promise.allSettled(BUILT_INS.map(u => loadManifest(u).catch(() => null))));
    const isOwnCatalog = url => url === catalogUrl && url !== CINEMETA_URL;
    const CATALOG_TIMEOUT = 15000;
    const STREAM_TIMEOUT = 30000;

    let roomAddonUrls = [];           // manifest URLs shared by the room
    const manifests = new Map();      // manifest URL -> manifest JSON (or null if failed)
    let browseType = 'movie';
    let selectedCatalog = '';         // `${addonUrl}|${catalogId}`
    let searchTimer = null;
    let detailToken = 0;              // cancels stale detail/stream loads
    let gridToken = 0;                // cancels stale catalog/search loads

    const $ = id => document.getElementById(id);
    const modal = $('browseModal');

    // ---------- helpers ----------
    function baseOf(manifestUrl) { return manifestUrl.replace(/\/manifest\.json$/i, ''); }

    function normalizeManifestUrl(raw) {
        let u = raw.trim().replace(/^stremio:\/\//i, 'https://');
        if (!/^https?:\/\//i.test(u)) throw new Error('Addon URL must start with https://');
        // A link pasted twice in a row ("…/manifest.json/manifest.json") is the same link once.
        u = u.replace(/(\/manifest\.json)+(\/manifest\.json)+/ig, '/manifest.json');
        // One addon's link inside another's ("…/language=hindi|torbox=https://other.example/…/manifest.json"):
        // it can't work as typed. Say which link to use on its own.
        const nested = u.slice(8).match(/https?:\/\/[^\s|]+?\/manifest\.json/i);
        if (nested) {
            const e = new Error('That link has another addon\u2019s link inside it, so it can\u2019t work as it is. Add the inner one on its own: ' + nested[0]);
            e.nestedUrl = nested[0];
            throw e;
        }
        const url = new URL(u);
        url.hash = '';
        url.search = '';
        if (!/\/manifest\.json$/i.test(url.pathname)) url.pathname = url.pathname.replace(/\/+$/, '') + '/manifest.json';
        return url.toString();
    }

    async function getJson(url, timeout) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeout);
        try {
            const res = await fetch(url, { signal: ctrl.signal });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await res.json();
        } finally {
            clearTimeout(timer);
        }
    }


    const inflightManifests = new Map();
    const manifestSlots = (() => { let active = 0; const q = []; const next = () => { while (active < 8 && q.length) { const { fn, res, rej } = q.shift(); active++; fn().then(res, rej).finally(() => { active--; next(); }); } }; return fn => new Promise((res, rej) => { q.push({ fn, res, rej }); next(); }); })();
    function loadManifest(url) {
        if (manifests.has(url) && manifests.get(url)) return Promise.resolve(manifests.get(url));
        if (inflightManifests.has(url)) return inflightManifests.get(url);
        const p = manifestSlots(() => loadManifestNow(url)).finally(() => inflightManifests.delete(url));
        inflightManifests.set(url, p);
        return p;
    }
    async function loadManifestNow(url) {
        try {
            const m = await getJson(url, CATALOG_TIMEOUT);
            if (!m || typeof m !== 'object' || !m.id || (!Array.isArray(m.resources) && !Array.isArray(m.catalogs))) throw new Error('That link is not a Stremio addon manifest');
            if (!Array.isArray(m.resources)) m.resources = ['catalog'];
            manifests.set(url, m);
            return m;
        } catch (e) {
            manifests.set(url, null);
            throw e;
        }
    }

    // Wait (up to maxMs) for every addon that's switched on to have loaded: without this an addon whose manifest is
    // still on its way is silently left out of Home rows, stream lookups and details.
    async function manifestsReady(maxMs) {
        await ready;
        const pending = allAddonUrls().filter(u => !manifests.get(u)).map(u => loadManifest(u).catch(() => null));
        if (pending.length) await Promise.race([Promise.allSettled(pending), new Promise(r => setTimeout(r, maxMs))]);
    }

    // Every addon in play: built-ins first, then the room's.
    // Your choices (saved with your profile): addons switched off, and built-ins you removed.
    const P = () => window.reddatePrefs;
    const inPref = (key, url) => (P().get(key, []) || []).includes(P().hash(url));
    const isOff = url => inPref('addonsOff', url);
    const activeBuiltIns = () => BUILT_INS.filter(u => !inPref('builtinsRemoved', u));
    function allAddonUrls() { return [...activeBuiltIns(), ...roomAddonUrls].filter(u => !isOff(u)); }
    function togglePref(key, url, on) {
        const h = P().hash(url);
        const set = new Set(P().get(key, []) || []);
        if (on) set.add(h); else set.delete(h);
        P().set(key, [...set]);
    }
    function afterAddonChange() {
        refreshCatalogs();
        if (window.reddateHome) window.reddateHome.rebuild();
    }
    function loadedAddons() {
        return allAddonUrls().map(url => ({ url, m: manifests.get(url) })).filter(a => a.m);
    }

    // An addon's picture: its manifest's logo (or icon), resolved against the manifest's address, https only.
    function logoOf(url, m) {
        const raw = m && (m.logo || m.icon);
        if (typeof raw !== 'string' || !raw) return '';
        try {
            const u = new URL(raw, url);
            if (u.protocol === 'http:' && !/^(localhost|127\.|192\.168\.|10\.)/.test(u.hostname)) u.protocol = 'https:';
            return u.protocol === 'https:' || /^(localhost|127\.|192\.168\.|10\.)/.test(u.hostname) ? u.toString() : '';
        } catch (e) { return ''; }
    }

    let rememberChoiceFn = null; // set below, once the exports exist
    // ---------- stream fingerprints ----------
    const LANGS = ['hindi', 'english', 'tamil', 'telugu', 'malayalam', 'kannada', 'bengali', 'marathi', 'punjabi', 'spanish', 'french', 'german', 'italian', 'japanese', 'korean', 'chinese', 'arabic', 'russian', 'portuguese', 'turkish', 'indonesian', 'vietnamese', 'thai', 'polish', 'dutch', 'swedish', 'greek', 'hebrew', 'persian', 'urdu', 'malay', 'filipino', 'ukrainian', 'czech', 'romanian', 'hungarian', 'multi', 'dual'];
    function streamSig(s) {
        const name = String(s.name || ''), title = String(s.title || s.description || ''), file = String((s.behaviorHints && s.behaviorHints.filename) || '');
        const t = `${name} ${title} ${file}`.toLowerCase();
        const pick = (re, map) => { const m = t.match(re); return m ? (map ? map(m) : m[0]) : ''; };
        const source = (title.match(/source:\s*([\w.\- ]+?)(?:\s{2,}|💾|$)/i) || name.match(/•\s*([\w.\-]+)\s*$/) || title.match(/^\[([^\]]+)\]/) || [])[1] || '';
        const group = (file.match(/-([A-Za-z0-9]+)(?:\.[a-z0-9]{2,4})?$/) || [])[1] || '';
        return {
            a: String(s._addon || ''),
            q: qualityOf(s),
            src: source.trim().toLowerCase().slice(0, 30),
            c: pick(/x265|hevc|h\.?265/, () => 'hevc') || pick(/x264|h\.?264|avc/, () => 'h264') || pick(/\bav1\b/, () => 'av1'),
            f: pick(/\bmkv\b/) || pick(/\bmp4\b/) || pick(/\bhls\b|m3u8/, () => 'hls'),
            hdr: /10.?bit|hdr|dolby.?vision|\bdv\b/.test(t) ? 1 : 0,
            l: LANGS.filter(l => t.includes(l)).slice(0, 6),
            g: group.toLowerCase().slice(0, 20)
        };
    }
    // Higher = closer to the remembered one. Same addon and quality matter most, then source and language.
    function matchStream(sig, s) {
        const x = streamSig(s);
        let score = 0;
        const why = [];
        if (sig.a && x.a === sig.a) { score += 5; why.push(x.a); }
        if (sig.q && x.q === sig.q) { score += 4; why.push(x.q); }
        if (sig.src && x.src && x.src === sig.src) { score += 3; why.push(x.src); }
        if (sig.c && x.c === sig.c) score += 2;
        if (sig.f && x.f === sig.f) score += 1;
        if ((sig.hdr || 0) === (x.hdr || 0)) score += 1;
        const langs = (sig.l || []).filter(l => x.l.includes(l));
        if (langs.length) { score += 3 * langs.length; why.push(langs.join('/')); }
        if (sig.l && sig.l.length && !langs.length && x.l.length) score -= 3; // a different language than you chose
        if (sig.g && x.g && x.g === sig.g) score += 2;
        return { score, why: why.join(' · ') };
    }
    // "~2.6 Mbps" in a stream's description, as a number (0 if not given).
    function bitrateOf(s) {
        const m = `${s.name || ''} ${s.title || s.description || ''}`.match(/~?\s*([\d.]+)\s*Mbps/i);
        return m ? Math.min(200, parseFloat(m[1]) || 0) : 0;
    }

    function supports(m, resource, type, id) {
        for (const r of m.resources || []) {
            const name = typeof r === 'string' ? r : r.name;
            if (name !== resource) continue;
            const types = (typeof r === 'object' && r.types) || m.types || [];
            const prefixes = (typeof r === 'object' && r.idPrefixes) || m.idPrefixes;
            if (types.length && !types.includes(type)) continue;
            if (id && prefixes && prefixes.length && !prefixes.some(p => id.startsWith(p))) continue;
            return true;
        }
        return false;
    }

    function catalogExtras(c) {
        const names = new Set(c.extraSupported || []);
        const required = new Set(c.extraRequired || []);
        (c.extra || []).forEach(e => { names.add(e.name); if (e.isRequired) required.add(e.name); });
        return { search: names.has('search'), required };
    }

    function safeImg(url) { return typeof url === 'string' && /^https:\/\//i.test(url) ? url : ''; }

    function el(tag, cls, text) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
    }

    function setStatus(id, text) { $(id).textContent = text || ''; }

    function setLoading(id, text) {
        const s = $(id);
        s.textContent = '';
        s.append(el('span', 'spinner'), text);
    }

    // ---------- addon lists: yours, and the room's ----------
    // "Yours" are the addons you added: kept in your account when signed in,
    // otherwise on this device. They're what you browse and play with, and what an
    // empty room you start or join begins with. The room's list is what everyone
    // in a room shares; joining someone else's room never saves their addons
    // into yours (addon links can contain private tokens).
    const MINE_KEY = 'reddate-addons';
    const acct = () => (window.reddateAccount && window.reddateAccount.isSignedIn() ? window.reddateAccount : null);
    const clean = list => (Array.isArray(list) ? list.filter(u => typeof u === 'string' && /^https?:\/\//i.test(u)).slice(0, 60) : []);
    function loadMine() {
        if (acct()) return clean(acct().getAddons());
        try { return clean(JSON.parse(localStorage.getItem(MINE_KEY) || '[]')); } catch (e) { return []; }
    }
    function saveMine(list) {
        if (acct()) return; // the account keeps its own copy (addAddon/removeAddon below)
        try { localStorage.setItem(MINE_KEY, JSON.stringify(clean(list))); } catch (e) { /* private mode */ }
    }

    function publishAddons() {
        if (window.reddateRoom && window.reddateRoom.isInRoom()) socket.emit('set-addons', { addons: roomAddonUrls });
    }

    // Before any room: browse and play with your own addons.
    roomAddonUrls = loadMine();
    let knownMine = JSON.stringify(roomAddonUrls);
    const initialLoad = ready.then(() => Promise.allSettled(roomAddonUrls.map(u => loadManifest(u).catch(() => null)))).then(async () => {
        renderAddonList();
        refreshCatalogs();
        if (window.reddateHome) window.reddateHome.rebuild();
        document.dispatchEvent(new CustomEvent('reddate:addons-changed'));
        // One that failed (a slow start, a busy connection) gets another go a few seconds later.
        const failed = allAddonUrls().filter(u => !manifests.get(u));
        if (failed.length) {
            await new Promise(r => setTimeout(r, 4000));
            const got = await Promise.allSettled(failed.map(u => loadManifest(u).catch(() => null)));
            if (got.some(r => r.status === 'fulfilled' && r.value)) {
                renderAddonList(); refreshCatalogs();
                if (window.reddateHome) window.reddateHome.rebuild();
                document.dispatchEvent(new CustomEvent('reddate:addons-changed'));
            }
        }
    });
    // Signing in (or switching profile) changes which addons are yours.
    document.addEventListener('reddate:account', () => {
        if (window.reddateRoom && window.reddateRoom.isInRoom()) return; // a room's list stays as it is
        knownMine = JSON.stringify(loadMine());
        roomAddonUrls = loadMine();
        Promise.allSettled(roomAddonUrls.map(u => loadManifest(u).catch(() => null))).then(() => renderAddonList());
    });
    // Addons changed on another device (your phone): load them and refresh Home and the Addons page.
    document.addEventListener('reddate:vault-updated', async () => {
        // The vault also changes for watch progress and settings; only act when your addons did.
        const mineNow = loadMine();
        const prev = JSON.parse(knownMine || '[]');
        knownMine = JSON.stringify(mineNow);
        const R = window.reddateRoom;
        if (R && R.isInRoom()) {
            // In a room: a guest keeps the host's list; the host's (or a solo viewer's) changes go into the room.
            if (R.isGuest && R.isGuest()) return;
            // New to the account (not yet in the room's list), and gone from the account since the last change we saw.
            const added = mineNow.filter(u => !roomAddonUrls.includes(u));
            const removed = prev.filter(u => !mineNow.includes(u));
            if (!added.length && !removed.length) return;
            roomAddonUrls = [...new Set([...roomAddonUrls.filter(u => !removed.includes(u)), ...added])].slice(0, 60);
            await Promise.allSettled(added.map(u => loadManifest(u).catch(() => null)));
            publishAddons();
        } else {
            if (JSON.stringify(mineNow) === JSON.stringify(roomAddonUrls)) return;
            roomAddonUrls = mineNow;
        }
        await Promise.allSettled(roomAddonUrls.map(u => loadManifest(u).catch(() => null)));
        renderAddonList();
        refreshCatalogs();
        if (window.reddateHome) window.reddateHome.rebuild();
        document.dispatchEvent(new CustomEvent('reddate:addons-changed'));
    });

    let roomHasAddonList = false; // server sends 'addons-updated' before 'joined' if the room has one
    socket.on('connect', () => { roomHasAddonList = false; }); // every (re)join starts fresh
    socket.on('addons-updated', async data => {
        roomHasAddonList = true;
        roomAddonUrls = clean(data.addons);
        await Promise.allSettled(roomAddonUrls.map(loadManifest));
        if (data.user) toast(`🧩 ${data.user} updated the room's addons`);
        renderAddonList();
        if (modal.classList.contains('show')) refreshCatalogs();
        document.dispatchEvent(new CustomEvent('reddate:addons-changed')); // the TV refreshes Home (only if its rows changed)
    });

    // You're in a room that has no addon list yet: it starts with yours.
    socket.on('joined', async () => {
        if (roomHasAddonList) return;
        const mine = loadMine();
        roomAddonUrls = [...new Set([...mine, ...roomAddonUrls])].slice(0, 60);
        if (!roomAddonUrls.length) return;
        await Promise.allSettled(roomAddonUrls.map(loadManifest));
        publishAddons();
        renderAddonList();
        if (modal.classList.contains('show')) refreshCatalogs();
    });

    function friendly(e) {
        const m = String((e && e.message) || e);
        if (e && e.name === 'AbortError') return 'it took too long to answer. Is it online?';
        if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return 'the link can\u2019t be reached, or the site doesn\u2019t let this app read it. Check the link ends in manifest.json and that the addon is online.';
        if (/HTTP 404/.test(m)) return 'nothing is there. Check the link ends in manifest.json.';
        if (/HTTP 4\d\d|HTTP 5\d\d/.test(m)) return `the addon answered with an error (${m}).`;
        if (/JSON|Unexpected token/i.test(m)) return 'that link doesn\u2019t return an addon manifest.';
        return m;
    }

    // Add an addon by its manifest link. Resolves { ok, message }.
    async function addAddonUrl(raw) {
        let url;
        try { url = normalizeManifestUrl(raw); } catch (e) { return { ok: false, message: e.message, suggest: e.nestedUrl || '' }; }
        if ([...BUILT_INS, ...roomAddonUrls].includes(url)) return { ok: false, message: 'That addon is already added.' };
        try {
            const m = await loadManifest(url);
            if (roomAddonUrls.length >= 60) return { ok: false, message: 'That\u2019s 60 addons, the most one profile can keep. Remove one you don\u2019t use, then add this.' };
            roomAddonUrls.push(url);
            if (/\/yt\/[^/]+\/manifest\.json$/.test(url)) togglePref('builtinsRemoved', YT_URL, true); // your own Reddate YT replaces the set-up entry
            // Yours too: only what you add, never what other people put in a room.
            if (acct()) {
                const saved = await acct().addAddon(url);
                if (saved === false) { // the account didn't take it: don't pretend it's there
                    roomAddonUrls = roomAddonUrls.filter(u => u !== url);
                    return { ok: false, message: 'Couldn\u2019t save that addon to your account. Check your connection and try again.' };
                }
            } else saveMine([...loadMine(), url]);
            publishAddons();
            renderAddonList();
            refreshCatalogs();
            if (window.reddateHome) window.reddateHome.rebuild(); // a catalog addon adds rows to Home
            // Say what it adds, and warn (not fail) when its first catalog doesn't answer.
            const res = resourceNames(m);
            const cats = (m.catalogs || []).filter(c => c && c.type);
            const parts = [];
            if (cats.length) parts.push(`${cats.length} ${cats.length === 1 ? 'row' : 'rows'} for Home`);
            if (res.includes('stream')) parts.push('streams');
            if (res.includes('subtitles')) parts.push('subtitles');
            let warn = '';
            const first = cats.find(c => !(c.extra || []).some(e => e && e.isRequired) && !(c.extraRequired || []).length);
            if (first) {
                try { await getJson(`${baseOf(url)}/catalog/${first.type}/${encodeURIComponent(first.id)}.json`, CATALOG_TIMEOUT); }
                catch (err) { warn = ` Its "${first.name || first.id}" list didn't answer just now; it may be down.`; }
            }
            return { ok: true, message: `Added ${m.name}${parts.length ? ': ' + parts.join(', ') : ''}.${warn}` };
        } catch (e) {
            return { ok: false, message: `Couldn't add that addon: ${friendly(e)}` };
        }
    }
    async function addAddon() {
        const btn = $('addAddonBtn');
        btn.disabled = true;
        setStatus('addonStatus', 'Checking addon…');
        const r = await addAddonUrl($('addonUrlInput').value);
        if (r.ok) $('addonUrlInput').value = '';
        setStatus('addonStatus', r.message);
        btn.disabled = false;
    }
    function setAddonEnabled(url, on) {
        togglePref('addonsOff', url, !on);
        afterAddonChange();
    }

    async function removeAddon(url) {
        roomAddonUrls = roomAddonUrls.filter(u => u !== url);
        if (acct()) acct().removeAddon(url); else saveMine(loadMine().filter(u => u !== url));
        publishAddons();
        renderAddonList();
        refreshCatalogs();
        if (window.reddateHome) window.reddateHome.rebuild();
    }

    function resourceNames(m) {
        return (m.resources || []).map(r => (typeof r === 'string' ? r : r.name));
    }

    function renderAddonList() {
        const list = $('addonList');
        list.innerHTML = '';
        $('addonsTabBtn').textContent = `Addons (${roomAddonUrls.length})`;
        allAddonUrls().forEach(url => {
            const m = manifests.get(url);
            const row = el('div', 'addon-row');
            const info = el('div', 'addon-info');
            const builtIn = BUILT_INS.includes(url);
            // Show name + host only: the full URL may contain an auth token.
            info.appendChild(el('div', 'addon-name', (m ? m.name : 'Unavailable addon') + (builtIn ? ' (built-in)' : '')));
            const host = (() => { try { return new URL(url).host; } catch { return ''; } })();
            const tags = m ? [...new Set(resourceNames(m))].join(' · ') : 'failed to load';
            info.appendChild(el('div', 'addon-meta', `${host} — ${tags}`));
            row.appendChild(info);
            if (!builtIn) {
                const rm = el('button', 'addon-remove', 'Remove');
                rm.onclick = () => removeAddon(url);
                row.appendChild(rm);
            }
            list.appendChild(row);
        });
    }

    // ---------- catalogs & search ----------
    function catalogsForType(type) {
        const out = [];
        loadedAddons().forEach(({ url, m }) => {
            (m.catalogs || []).forEach(c => {
                if (c.type !== type) return;
                const ex = catalogExtras(c);
                const blocked = [...ex.required].some(n => n !== 'search');
                if (blocked) return;
                out.push({ key: `${url}|${c.id}`, url, m, c, search: ex.search, searchOnly: ex.required.has('search') });
            });
        });
        return out;
    }

    function refreshCatalogs() {
        const sel = $('catalogSelect');
        const cats = catalogsForType(browseType).filter(x => !x.searchOnly);
        sel.innerHTML = '';
        cats.forEach(x => {
            const opt = el('option', null, `${x.c.name || x.c.id} — ${x.m.name}`);
            opt.value = x.key;
            sel.appendChild(opt);
        });
        if (!cats.some(x => x.key === selectedCatalog)) selectedCatalog = cats.length ? cats[0].key : '';
        sel.value = selectedCatalog;
        if ($('browseSearch').value.trim()) runSearch($('browseSearch').value.trim());
        else loadCatalog();
    }

    async function loadCatalog() {
        const token = ++gridToken;
        const x = catalogsForType(browseType).find(c => c.key === selectedCatalog);
        if (!x) { renderGrid([], 'No catalogs for this type yet — add a catalog addon in the Addons tab.'); return; }
        setStatus('browseStatus', 'Loading…');
        try {
            const data = await getJson(`${baseOf(x.url)}/catalog/${browseType}/${encodeURIComponent(x.c.id)}.json`, CATALOG_TIMEOUT);
            if (token === gridToken) renderGrid((data.metas || []).slice(0, 100));
        } catch (e) {
            if (token === gridToken) renderGrid([], `Couldn't load that catalog (${e.message}).`);
        }
    }

    async function runSearch(q) {
        const token = ++gridToken;
        const cats = catalogsForType(browseType).filter(x => x.search);
        if (!cats.length) { renderGrid([], 'None of the room\'s catalogs support search.'); return; }
        setStatus('browseStatus', `Searching “${q}”…`);
        $('posterGrid').innerHTML = ''; // don't leave old posters looking like results
        const results = await Promise.allSettled(cats.map(x =>
            getJson(`${baseOf(x.url)}/catalog/${browseType}/${encodeURIComponent(x.c.id)}/search=${encodeURIComponent(q)}.json`, CATALOG_TIMEOUT)
        ));
        if (token !== gridToken) return; // a newer catalog load or search took over
        const seen = new Set();
        const metas = [];
        results.forEach(r => {
            if (r.status !== 'fulfilled') return;
            (r.value.metas || []).forEach(meta => {
                if (!meta || !meta.id || seen.has(meta.id)) return;
                seen.add(meta.id);
                metas.push(meta);
            });
        });
        renderGrid(metas.slice(0, 100), metas.length ? '' : `No results for “${q}”.`);
    }

    // Shown when a title has no poster (or it fails to load): the film icon from the page's icon set.
    function posterFallback() {
        const box = el('div', 'poster-fallback');
        box.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#i-film"/></svg>';
        return box;
    }

    function renderGrid(metas, emptyMsg) {
        const grid = $('posterGrid');
        grid.innerHTML = '';
        setStatus('browseStatus', metas.length ? '' : (emptyMsg || 'Nothing here.'));
        metas.forEach(meta => {
            const card = el('button', 'poster-card');
            card.type = 'button';
            const img = safeImg(meta.poster);
            if (img) {
                const i = document.createElement('img');
                i.src = img;
                i.loading = 'lazy';
                i.alt = '';
                i.onerror = () => i.replaceWith(posterFallback());
                card.appendChild(i);
            } else {
                card.appendChild(posterFallback());
            }
            const year = meta.releaseInfo || meta.year || '';
            card.appendChild(el('div', 'poster-title', meta.name + (year ? ` (${year})` : '')));
            card.onclick = () => {
                if (window.reddateHome) { modal.classList.remove('show'); window.reddateHome.openTitle(meta); }
                else openDetail(meta);
            };
            grid.appendChild(card);
        });
    }

    // ---------- detail: episodes + streams ----------
    function showView(name) {
        $('browseView').style.display = name === 'browse' ? 'block' : 'none';
        $('detailView').style.display = name === 'detail' ? 'block' : 'none';
        $('addonsView').style.display = name === 'addons' ? 'block' : 'none';
        $('youtubeView').style.display = name === 'youtube' ? 'block' : 'none';
        $('linkView').style.display = name === 'link' ? 'block' : 'none';
        $('browseTabBtn').classList.toggle('active', name === 'browse' || name === 'detail');
        $('youtubeTabBtn').classList.toggle('active', name === 'youtube');
        $('linkTabBtn').classList.toggle('active', name === 'link');
        $('addonsTabBtn').classList.toggle('active', name === 'addons');
    }

    let currentMeta = null; // the title on screen (its artwork goes to the room with the stream)
    async function openDetail(meta) {
        const token = ++detailToken;
        currentMeta = meta;
        sourceFilter = 'all'; // each title starts on the "All" tab
        $('sourceChips').style.display = 'none';
        showView('detail');
        const type = meta.type || browseType;
        $('detailTitle').textContent = meta.name || 'Untitled';
        $('detailInfo').textContent = [meta.releaseInfo || meta.year, meta.imdbRating ? `⭐ ${meta.imdbRating}` : '']
            .filter(Boolean).join(' • ');
        const poster = safeImg(meta.poster);
        $('detailPoster').src = poster;
        $('detailPoster').style.display = poster ? 'block' : 'none';
        $('episodePicker').style.display = 'none';
        $('streamList').innerHTML = '';

        if (type !== 'series') {
            let streamId = meta.imdb_id || meta.id;
            if (!/^tt\d+/.test(streamId)) {
                // Our catalog's ids are TMDB ids; stream addons look titles up by IMDb id.
                setLoading('streamStatus', 'Finding streams…');
                const full = await fullMeta('movie', meta.id).catch(() => null);
                if (token !== detailToken) return;
                streamId = full && full.imdb_id;
                if (!streamId) { setStatus('streamStatus', 'Streams aren\'t available for this title yet.'); return; }
            }
            loadStreams(type, streamId, meta.name, token);
            return;
        }

        // Series: fetch full meta for the episode list.
        setStatus('streamStatus', 'Loading episodes…');
        const metaAddon = loadedAddons().find(({ m }) => supports(m, 'meta', 'series', meta.id));
        if (!metaAddon) { setStatus('streamStatus', 'No addon in this room can list episodes for this show.'); return; }
        let videos = [];
        try {
            const data = await getJson(`${baseOf(metaAddon.url)}/meta/series/${encodeURIComponent(meta.id)}.json`, CATALOG_TIMEOUT);
            videos = ((data.meta && data.meta.videos) || []).filter(v => v && v.id);
        } catch (e) {
            if (token === detailToken) setStatus('streamStatus', `Couldn't load episodes (${e.message}).`);
            return;
        }
        if (token !== detailToken) return;
        if (!videos.length) { setStatus('streamStatus', 'No episodes listed for this show.'); return; }
        setStatus('streamStatus', '');

        const seasons = [...new Set(videos.map(v => Number(v.season) || 0))].sort((a, b) => a - b);
        const seasonSel = $('seasonSelect');
        seasonSel.innerHTML = '';
        seasons.forEach(s => {
            const opt = el('option', null, s === 0 ? 'Specials' : `Season ${s}`);
            opt.value = String(s);
            seasonSel.appendChild(opt);
        });
        seasonSel.value = String(seasons.find(s => s > 0) ?? seasons[0]);

        const renderEpisodes = () => {
            const season = Number(seasonSel.value);
            const list = $('episodeList');
            list.innerHTML = '';
            videos.filter(v => (Number(v.season) || 0) === season)
                .sort((a, b) => (Number(a.episode) || 0) - (Number(b.episode) || 0))
                .forEach(v => {
                    // A card: still image, "E3 · Title", rating and air date, a line of the plot.
                    const btn = el('button', 'episode-btn');
                    btn.type = 'button';
                    const thumb = el('span', 'episode-thumb');
                    const src = safeImg(v.thumbnail);
                    if (src) { const im = document.createElement('img'); im.alt = ''; im.loading = 'lazy'; im.decoding = 'async'; im.src = src; im.onerror = () => im.remove(); thumb.appendChild(im); }
                    thumb.appendChild(el('span', 'episode-num', `E${v.episode ?? '?'}`));
                    btn.appendChild(thumb);
                    btn.appendChild(el('span', 'episode-title', v.name || v.title || 'Episode'));
                    const aired = v.released ? new Date(v.released) : null;
                    const facts = [
                        v.rating ? `★ ${v.rating}` : '',
                        v.runtime || '',
                        aired && !isNaN(aired) ? aired.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : ''
                    ].filter(Boolean).join(' · ');
                    if (facts) btn.appendChild(el('span', 'episode-facts', facts));
                    if (v.overview || v.description) btn.appendChild(el('span', 'episode-plot', v.overview || v.description));
                    btn.setAttribute('aria-label', `Episode ${v.episode ?? ''}: ${v.name || v.title || ''}`);
                    btn.onclick = () => {
                        list.querySelectorAll('.episode-btn').forEach(b => b.classList.remove('active'));
                        btn.classList.add('active');
                        loadStreams('series', v.id, `${meta.name} S${season}E${v.episode ?? '?'}`, ++detailToken);
                    };
                    list.appendChild(btn);
                });
        };
        seasonSel.onchange = renderEpisodes;
        renderEpisodes();
        $('episodePicker').style.display = 'block';
        setStatus('streamStatus', 'Pick an episode to see streams.');
    }

    // ---------- which streams actually play ----------
    // Playability depends on the viewer's browser and device: Safari and
    // Chrome-on-Mac decode HEVC, Chrome opens MKVs but iPhone Safari can't, and
    // Chrome/Firefox can't decode Dolby (AC-3 / E-AC-3 "DDP") audio, so such files
    // play silently. Stream titles can't tell us all that, so:
    //   1. a file whose container/codecs (from its MKV header, else its name) this
    //      browser says it can't decode is skipped without downloading anything;
    //   2. the rest are test-played in a tiny, invisible muted <video>, and only
    //      streams whose video AND audio really decode are listed;
    //   3. a time budget guarantees the picker never spins forever.
    const IS_MOBILE = /Android|iPhone|iPad|iPod|Mobi/i.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPadOS reports as a Mac
    const PROBE_LOAD_TIMEOUT = 25000;          // addon redirects can be slow to resolve
    const PROBE_PLAY_TIMEOUT = 10000;
    const PROBE_MIN_PLAYED = 1;                // seconds of playback before judging
    const PROBE_CONCURRENCY = IS_MOBILE ? 2 : 4;
    const SEARCH_BUDGET = 45000;               // then stop checking and show what we have
    const WANTED_PLAYABLE = 5;                 // stop probing once this many work
    const MAX_STREAM_BYTES = 30 * 1073741824;  // 30 GB+ remuxes are too heavy to stream
    const probeCache = new Map();              // url -> Promise<true | false | 'blocked' | null>
    const activeProbes = new Set();            // abort fns for in-flight probes
    const probeAborts = new Map();             // url -> abort fn, to cancel one probe

    function streamText(s) {
        const hints = s.behaviorHints || {};
        return [s.name, s.title, s.description, hints.filename].filter(Boolean).join(' ').toLowerCase();
    }

    function isHls(url) { return /\.m3u8($|\?)/i.test(url); }

    function qualityOf(s) {
        const text = streamText(s);
        if (/2160p|\b4k\b|uhd/.test(text)) return '4K';
        if (/1080p/.test(text)) return '1080p';
        if (/720p/.test(text)) return '720p';
        if (/480p|\bsd\b/.test(text)) return '480p';
        return '';
    }

    // Order candidates so likely winners get probed first. Only ordering —
    // the checks below decide what's shown.
    // Formats count against a stream only where this browser can't play them, so
    // an iPhone leans on MP4 while a desktop browser gets MKVs (often better
    // quality and multi-audio) too. Only WANTED_PLAYABLE are shown, so this order
    // decides which formats people see.
    function likelihood(s) {
        const t = streamText(s);
        const h264 = /\b(h\.?264|x264|avc)\b/.test(t);
        let score = 0;
        if (!canPlay('video/x-matroska')) {
            if (/\bmp4\b/.test(t)) score += 4;
            if (/\bmkv\b/.test(t)) score -= 4;
        }
        if (/\b(ddp|dd\+|e-?ac-?3|ac-?3|atmos|dd5)/.test(t) && !canPlay(AUDIO_CODECS.A_EAC3)) score -= 3;
        if (/\b(truehd|dts)/.test(t)) score -= 3; // no browser decodes these
        if (/\b(x265|h[ .]?265|hevc)\b/.test(t) && !canPlay(VIDEO_CODECS['V_MPEGH/ISO/HEVC'])) score -= 3;
        if (/10[ .-]?bit|hi10p/.test(t) && h264) score -= 3; // 10-bit H.264 rarely decodes in browsers
        if (/\bdv\b|dovi|dolby.?vision/.test(t)) score -= 1;  // Dolby Vision-only files can show odd colours
        if (/\baac\b/.test(t)) score += 1;
        if (h264) score += 1;
        // 4K files are big for a browser stream, especially on a phone.
        score += { '1080p': 2, '720p': 1, '4K': IS_MOBILE ? -3 : -1 }[qualityOf(s)] || 0;
        // Debrid addons: cached results (⚡, or Torrentio's "[RD+]") play now;
        // uncached ones first have to be downloaded by the service.
        const tag = `${s.name || ''} ${s.title || ''}`;
        if (/⚡|\[(?:rd|ad|tb|pm|dl|ed|oc|pk|pp)\+\]/i.test(tag)) score += 6;
        else if (/\[(?:rd|ad|tb|pm|dl|ed|oc|pk|pp)\b[^\]]*\]/i.test(tag)) score -= 6;
        return score + languageScore(s);
    }

    // Prefer audio in the viewer's own languages (browser settings) over other
    // dubs; streams that don't name a language are neutral.
    function languageScore(s) {
        const main = textAudioLangs(s)[0];
        if (!main) return 0;
        const mine = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || 'en'])
            .map(normLang);
        return mine.includes(main) ? 3 : -4;
    }

    // What this browser says it can decode, for MKV track codec IDs.
    const VIDEO_CODECS = {
        'V_MPEG4/ISO/AVC': 'video/mp4; codecs="avc1.640028"',
        'V_MPEGH/ISO/HEVC': 'video/mp4; codecs="hvc1.1.6.L120.90"',
        'V_AV1': 'video/mp4; codecs="av01.0.08M.08"',
        'V_VP9': 'video/webm; codecs="vp9"',
        'V_VP8': 'video/webm; codecs="vp8"',
        'V_MPEG4/ISO/ASP': 'video/mp4; codecs="mp4v.20.9"'
    };
    const AUDIO_CODECS = {
        'A_AAC': 'audio/mp4; codecs="mp4a.40.2"',
        'A_EAC3': 'audio/mp4; codecs="ec-3"',
        'A_AC3': 'audio/mp4; codecs="ac-3"',
        'A_DTS': 'audio/mp4; codecs="dtsc"',
        'A_TRUEHD': 'audio/mp4; codecs="mlpa"',
        'A_OPUS': 'audio/webm; codecs="opus"',
        'A_VORBIS': 'audio/webm; codecs="vorbis"',
        'A_FLAC': 'audio/flac',
        'A_MPEG/L3': 'audio/mpeg'
    };
    const canPlayCache = new Map();
    function canPlay(type) {
        if (!canPlayCache.has(type)) canPlayCache.set(type, document.createElement('video').canPlayType(type) !== '');
        return canPlayCache.get(type);
    }
    function codecType(map, id) {
        const key = Object.keys(map).find(k => String(id || '').startsWith(k));
        return key ? map[key] : null;
    }

    // False when this browser certainly can't play the stream, so it isn't worth
    // downloading to test. True means "maybe" — the probe decides.
    function mightPlay(s, tracks) {
        const path = (s.url || '').toLowerCase().split('?')[0];
        const text = streamText(s);
        const isMkv = !!tracks || path.endsWith('.mkv') || /\bmkv\b/.test(text);
        if (isMkv && !canPlay('video/x-matroska')) return false; // e.g. iPhone Safari
        if (tracks) {
            const video = tracks.video[0];
            const vType = video && codecType(VIDEO_CODECS, video.codec);
            if (vType && !canPlay(vType)) return false;
            const audio = tracks.audio.find(t => t.isDefault) || tracks.audio[0];
            const aType = audio && codecType(AUDIO_CODECS, audio.codec);
            if (aType && !canPlay(aType)) return false; // the track that plays would be silent
        } else if (/\b(x265|h[ .]?265|hevc)\b/.test(text) && !canPlay(VIDEO_CODECS['V_MPEGH/ISO/HEVC'])) {
            return false;
        }
        return true;
    }

    function decodesAudioAndVideo(v) {
        if (v.currentTime < PROBE_MIN_PLAYED || !v.videoWidth) return false;
        if ('webkitVideoDecodedByteCount' in v && !v.webkitVideoDecodedByteCount) return false;
        // Unsupported audio plays silently with 0 decoded bytes (Chrome/Safari).
        if ('webkitAudioDecodedByteCount' in v) return v.webkitAudioDecodedByteCount > 0;
        if ('mozHasAudio' in v) return v.mozHasAudio;
        return true; // no way to inspect audio here; trust the video
    }

    // Browsers won't play media in a hidden tab, so a probe there would fail every
    // stream. Probes only run while the page is visible; one cut short by the tab
    // being hidden is inconclusive (null), not remembered, and retried later.
    function whenVisible() {
        if (document.visibilityState === 'visible') return Promise.resolve();
        return new Promise(resolve => {
            const onChange = () => {
                if (document.visibilityState !== 'visible') return;
                document.removeEventListener('visibilitychange', onChange);
                resolve();
            };
            document.addEventListener('visibilitychange', onChange);
        });
    }
    document.addEventListener('visibilitychange', () => { if (document.hidden) cancelProbes(); });

    // Mobile browsers won't load or play a <video> that isn't in the page, and
    // Android Chrome pauses muted videos it considers off-screen, so probes run in
    // a 2px, practically transparent box inside the viewport.
    let probeBox = null;
    function probeContainer() {
        if (!probeBox) {
            probeBox = el('div');
            probeBox.setAttribute('aria-hidden', 'true');
            probeBox.style.cssText = 'position:fixed;right:0;bottom:0;width:2px;height:2px;' +
                'overflow:hidden;opacity:0.01;pointer-events:none;';
            document.body.appendChild(probeBox);
        }
        return probeBox;
    }

    function probeStream(url) {
        if (probeCache.has(url)) return probeCache.get(url);
        // hls.js plays HLS in browsers without native support, so skip the probe.
        if (isHls(url)) return Promise.resolve(true);
        const p = new Promise(resolve => {
            const v = document.createElement('video');
            // iOS needs these as attributes (not just properties) for muted inline playback.
            v.muted = true;
            v.defaultMuted = true;
            v.setAttribute('muted', '');
            v.setAttribute('playsinline', '');
            v.setAttribute('webkit-playsinline', '');
            v.preload = 'auto';
            let done = false;
            let timer = null;
            const finish = (result, aborted) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                clearInterval(decodePoll);
                activeProbes.delete(abort);
                probeAborts.delete(url);
                // Don't remember unfinished probes, or a device refusing autoplay.
                if (aborted || result === 'blocked') probeCache.delete(url);
                v.pause();
                v.removeAttribute('src');
                v.load();
                v.remove();
                resolve(aborted ? null : result);
            };
            const abort = () => finish(false, true);
            activeProbes.add(abort);
            probeAborts.set(url, abort);
            timer = setTimeout(() => finish(false), PROBE_LOAD_TIMEOUT);
            v.onerror = () => finish(false);
            v.onloadedmetadata = () => {
                if (!v.videoWidth) return finish(false); // no decodable video track
                clearTimeout(timer);
                timer = setTimeout(() => finish(decodesAudioAndVideo(v)), PROBE_PLAY_TIMEOUT);
            };
            v.ontimeupdate = () => { if (v.currentTime >= PROBE_MIN_PLAYED) finish(decodesAudioAndVideo(v)); };
            // Fast path (Chrome/Safari): as soon as some video AND some audio have been
            // decoded, the file plays with sound — no need to wait for playback time.
            // Files with audio this browser can't decode never get past 0 audio bytes.
            const decodePoll = setInterval(() => {
                if (v.videoWidth && v.webkitVideoDecodedByteCount > 0 && v.webkitAudioDecodedByteCount > 0) finish(true);
            }, 200);
            v.src = url;
            probeContainer().appendChild(v);
            // Play right away: iPhone Safari doesn't load any data until play() is called.
            const played = v.play();
            if (played && played.catch) {
                // NotAllowedError: the device refuses even muted autoplay (e.g. iPhone Low Power Mode).
                played.catch(e => finish(e && e.name === 'NotAllowedError' ? 'blocked' : false));
            }
        });
        probeCache.set(url, p);
        return p;
    }

    function cancelProbes() { [...activeProbes].forEach(abort => abort()); }
    function abortProbe(url) { const abort = probeAborts.get(url); if (abort) abort(); }

    // ---------- audio language ----------
    // Each stream row says what you'll hear ("Hindi (+ English)", with a speaker icon). Chrome/Firefox
    // always play a file's *default* audio track, so that's the one named first.
    // The real track list is read from the MKV header when possible; otherwise
    // it's inferred from the release name (first-listed language = default track).
    const TEXT_LANGS = [
        ['eng', /\b(english|eng)\b/], ['hin', /\b(hindi|hin)\b/], ['tam', /\b(tamil|tam)\b/],
        ['tel', /\b(telugu|tel)\b/], ['mal', /\bmalayalam\b/], ['kan', /\bkannada\b/],
        ['ben', /\b(bengali|bangla)\b/], ['mar', /\bmarathi\b/], ['pan', /\bpunjabi\b/],
        ['guj', /\bgujarati\b/], ['urd', /\burdu\b/], ['spa', /\b(spanish|castellano|latino)\b/],
        ['fre', /\b(french|truefrench|vff)\b/], ['ger', /\b(german|deutsch)\b/],
        ['ita', /\b(italian|italiano)\b/], ['por', /\b(portuguese|dublado)\b/],
        ['rus', /\b(russian|rus)\b/], ['jpn', /\b(japanese|jpn)\b/], ['kor', /\b(korean|kor)\b/],
        ['chi', /\b(chinese|mandarin|cantonese)\b/], ['ara', /\barabic\b/], ['tur', /\bturkish\b/],
        ['pol', /\bpolish\b/], ['ukr', /\bukrainian\b/], ['tha', /\bthai\b/], ['ind', /\bindonesian\b/],
        ['vie', /\bvietnamese\b/], ['per', /\b(persian|farsi)\b/]
    ];
    const TO_639_2 = {
        en: 'eng', hi: 'hin', ta: 'tam', te: 'tel', ml: 'mal', kn: 'kan', bn: 'ben', mr: 'mar', pa: 'pan',
        gu: 'guj', ur: 'urd', es: 'spa', fr: 'fre', de: 'ger', it: 'ita', pt: 'por', ru: 'rus', ja: 'jpn',
        ko: 'kor', zh: 'chi', ar: 'ara', tr: 'tur', pl: 'pol', uk: 'ukr', th: 'tha', id: 'ind', vi: 'vie', fa: 'per',
        hu: 'hun', cs: 'cze', nl: 'dut', sv: 'swe', no: 'nor', da: 'dan', fi: 'fin', el: 'gre', he: 'heb',
        fra: 'fre', deu: 'ger', zho: 'chi', fas: 'per'
    };
    // Flags some addons (e.g. StremThru) use to list audio languages: "🎙️ 🇬🇧 🇫🇷 …".
    const FLAG_LANGS = {
        GB: 'eng', US: 'eng', AU: 'eng', CA: 'eng', IN: 'hin', FR: 'fre', DE: 'ger', ES: 'spa', MX: 'spa',
        IT: 'ita', PT: 'por', BR: 'por', RU: 'rus', UA: 'ukr', JP: 'jpn', KR: 'kor', CN: 'chi', TW: 'chi',
        HK: 'chi', TR: 'tur', TH: 'tha', PL: 'pol', CZ: 'cze', HU: 'hun', NL: 'dut', SA: 'ara', AE: 'ara',
        IR: 'per', VN: 'vie', ID: 'ind', SE: 'swe', NO: 'nor', DK: 'dan', FI: 'fin', GR: 'gre', IL: 'heb'
    };
    const TO_BCP47 = Object.fromEntries(Object.entries(TO_639_2).filter(([k]) => k.length === 2).map(([k, v]) => [v, k]));
    let langNames = null;
    try { langNames = new Intl.DisplayNames([navigator.language || 'en'], { type: 'language' }); } catch (e) {}

    function normLang(code) {
        code = String(code || '').toLowerCase().split('-')[0];
        return TO_639_2[code] || code || 'und';
    }
    function langLabel(code) {
        try { const n = langNames && langNames.of(TO_BCP47[code] || code); if (n && n !== code) return n; } catch (e) {}
        return String(code).toUpperCase();
    }

    // Languages named in the release text, in order of appearance (subtitle
    // mentions like "English Subs" / "ESub" don't count as audio).
    function textAudioLangs(s) {
        const flags = flagAudioLangs(s);
        if (flags.length) return flags;
        const t = streamText(s)
            .replace(/\b[a-z]+[ ._-]?(subs?|subtitles?|subbed)\b/g, ' ')
            .replace(/\b[em]subs?\b/g, ' ');
        return TEXT_LANGS.map(([code, re]) => { const m = re.exec(t); return m ? [code, m.index] : null; })
            .filter(Boolean).sort((a, b) => a[1] - b[1]).map(x => x[0]);
    }

    // Audio languages from the flags after "🎙️" (stops at "|" or the "💬" subtitle list).
    function flagAudioLangs(s) {
        const text = `${s.description || ''} ${s.title || ''}`;
        const at = text.indexOf('🎙');
        if (at < 0) return [];
        const segment = text.slice(at).split(/\||💬/)[0];
        const out = [];
        for (const [pair] of segment.matchAll(/[\u{1F1E6}-\u{1F1FF}]{2}/gu)) {
            const country = [...pair].map(c => String.fromCharCode(c.codePointAt(0) - 0x1F1E6 + 65)).join('');
            const lang = FLAG_LANGS[country];
            if (lang && !out.includes(lang)) out.push(lang);
        }
        return out;
    }

    // A file's tracks from its MKV header (public/mkv.js): codecs, plus audio
    // languages. The browser reads the first 64 KB itself when the file host allows
    // cross-origin reads; most hosts don't, so it then asks the Reddate server,
    // which reads the same 64 KB and returns only the track metadata (never video).
    const trackCache = new Map(); // url -> Promise<{ audio: [{ lang, isDefault, codec }], video: [{ codec }] } | null>

    async function readHeaderInBrowser(url) {
        const bytes = window.ReddateMkv.HEADER_BYTES;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 15000);
        try {
            const res = await fetch(url, { headers: { Range: `bytes=0-${bytes - 1}` }, signal: ctrl.signal });
            if (!res.ok || !res.body) return undefined;
            // Read at most `bytes` even if the host ignores the Range header.
            const reader = res.body.getReader();
            const buf = new Uint8Array(bytes);
            let n = 0;
            while (n < bytes) {
                const { done, value } = await reader.read();
                if (done) break;
                const take = Math.min(value.length, bytes - n);
                buf.set(value.subarray(0, take), n);
                n += take;
            }
            reader.cancel().catch(() => {});
            return window.ReddateMkv.parseMkvTracks(buf.subarray(0, n));
        } catch (e) {
            return undefined; // blocked by the host's CORS policy (or timed out)
        } finally {
            clearTimeout(timer);
        }
    }

    async function readHeaderViaServer(url) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 20000);
        try {
            const res = await fetch('/media-info', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url }),
                signal: ctrl.signal
            });
            if (!res.ok) return null;
            const data = await res.json();
            const audio = Array.isArray(data.tracks) ? data.tracks : [];
            const video = Array.isArray(data.video) ? data.video : [];
            return audio.length || video.length ? { audio, video } : null;
        } catch (e) {
            return null;
        } finally {
            clearTimeout(timer);
        }
    }

    function readTracks(url) {
        if (trackCache.has(url)) return trackCache.get(url);
        const p = (async () => {
            if (isHls(url) || !window.ReddateMkv) return null;
            let tracks = await readHeaderInBrowser(url);
            if (tracks === undefined) tracks = await readHeaderViaServer(url);
            if (!tracks) return null;
            return {
                audio: (tracks.audio || []).map(t => ({
                    lang: t.lang ? normLang(t.lang) : 'und', isDefault: !!t.isDefault, codec: String(t.codec || '')
                })),
                video: (tracks.video || []).map(t => ({ codec: String(t.codec || '') }))
            };
        })();
        trackCache.set(url, p);
        return p;
    }

    // { def: default-track language or null, langs: all known }. The header is the
    // truth when it names the default track's language; otherwise the release name.
    function audioInfo(s, tracks) {
        const text = textAudioLangs(s);
        const header = tracks && tracks.audio.length ? tracks.audio : null;
        if (header) {
            const def = (header.find(a => a.isDefault) || header[0]).lang;
            const defLang = def !== 'und' ? def : text[0] || null;
            const langs = [...new Set([defLang, ...header.map(a => a.lang), ...(def === 'und' ? text : [])])]
                .filter(l => l && l !== 'und');
            return { def: defLang, langs };
        }
        return { def: text[0] || null, langs: text };
    }

    function audioLabel(info) {
        if (!info.def) return 'Language not listed'; // speaker icon comes from CSS (.stream-audio::before)
        const others = info.langs.filter(l => l !== info.def);
        return `${langLabel(info.def)}${others.length ? ` (+ ${others.map(langLabel).join(', ')})` : ''}`;
    }

    function renderStreamRow(container, s, label, content, info) {
        const row = el('button', 'stream-row');
        const top = el('div', 'stream-top');
        if (window.ReddateBadges) top.appendChild(window.ReddateBadges.render(streamText(s)));
        top.appendChild(el('span', 'stream-audio', audioLabel(info)));
        const size = s.behaviorHints && s.behaviorHints.videoSize;
        if (size) top.appendChild(el('span', 'stream-size', `${(size / 1073741824).toFixed(1)} GB`));
        // Which addon it came from: its picture and name.
        const from = el('span', 'stream-addon');
        if (s._logo) { const im = document.createElement('img'); im.className = 'stream-addon-logo'; im.alt = ''; im.referrerPolicy = 'no-referrer'; im.loading = 'lazy'; im.onerror = () => im.remove(); im.src = s._logo; from.appendChild(im); }
        from.appendChild(document.createTextNode(s._addon));
        top.appendChild(from);
        row.appendChild(top);
        const desc = [s.name, s.title || s.description].filter(Boolean).join(' — ').replace(/\s+/g, ' ');
        row.appendChild(el('div', 'stream-desc', desc));
        row.onclick = () => playForRoom(s, label, content);
        container.appendChild(row);
    }

    // Each addon's stream list, remembered briefly so reopening a title is instant.
    const STREAM_LIST_TTL = 10 * 60 * 1000;
    const streamListCache = new Map(); // `${addonUrl}|${type}|${id}` -> { at, streams }
    // Each tab's checked results per title, so switching tabs shows them instantly.
    const viewCache = new Map();       // `${type}|${id}|${tab}` -> { at, rows: [{ s, info }], done, status }
    const TAP_TO_PLAY = 'Tap a stream to play it for everyone.';

    // Lines an addon shows instead of a video ("support the project", "join our Discord"): the TV shows them.
    // Some addons hide theirs once you donate, so we never hide them ourselves.
    const lookupInfo = new Map(); // "type|id" -> what the last stream lookup found, to explain an empty result
    const DONATE = /(^|\.)(ko-fi\.com|patreon\.com|buymeacoffee\.com|paypal\.(com|me)|discord\.(gg|com)|github\.com\/sponsors|liberapay\.com|opencollective\.com)/i;
    const linkHost = u => { try { const x = new URL(u); return x.host + x.pathname; } catch (e) { return ''; } };
    function notesFrom(list) {
        const notes = [];
        list.forEach(s => {
            if (!s) return;
            const playable = typeof s.url === 'string' && /^https?:\/\//i.test(s.url) && !DONATE.test(linkHost(s.url));
            if (playable || s.ytId || s.infoHash || s.nzbUrl || s.rarUrls || s.zipUrls || s.archiveUrls) return; // a real video
            if (typeof s.url === 'string' && s.url && !/^https?:\/\//i.test(s.url)) return; // magnet: and other video links
            const link = [s.externalUrl, s.url].find(u => typeof u === 'string' && /^https?:\/\//i.test(u)) || '';
            const title = String(s.name || s.title || '').replace(/\s+/g, ' ').trim().slice(0, 80);
            const text = String(s.description || s.title || '').replace(/\s+/g, ' ').trim().slice(0, 160);
            if (!title && !text) return;
            if (notes.some(n => (link && n.link === link) || (n.addon === (s._addon || '') && n.title === title && n.text === text))) return;
            notes.push({ addon: s._addon || '', logo: s._logo || '', title, text: text === title ? '' : text, link });
        });
        return notes.slice(0, 8);
    }
    // A few requests at a time: fifty addons asked at once starve each other (and the player) of connections.
    function slots(n) {
        let active = 0;
        const queue = [];
        const next = () => {
            while (active < n && queue.length) {
                const { fn, res, rej } = queue.shift();
                active++;
                fn().then(res, rej).finally(() => { active--; next(); });
            }
        };
        return fn => new Promise((res, rej) => { queue.push({ fn, res, rej }); next(); });
    }
    const streamSlots = slots(12);
    // How each addon has behaved (answer time, failures): the quick ones are asked first, the ones that keep failing
    // get a short leash, so a few dead addons can never hold up the other forty-odd.
    const STATS_KEY = 'reddate-addon-stats';
    const addonStats = (() => { try { return JSON.parse(localStorage.getItem(STATS_KEY) || '{}') || {}; } catch (e) { return {}; } })();
    let statsTimer = 0;
    const saveStats = () => {
        if (statsTimer) return;
        statsTimer = setTimeout(() => { statsTimer = 0; try { localStorage.setItem(STATS_KEY, JSON.stringify(addonStats)); } catch (e) { /* private mode */ } }, 3000);
    };
    const noteAddon = (url, ok, ms) => {
        const k = baseOf(url);
        const st = addonStats[k] || (addonStats[k] = { ms: 3000, fails: 0 });
        if (ok) { st.ms = Math.round(st.ms * 0.5 + ms * 0.5); st.fails = 0; } else st.fails = Math.min(5, st.fails + 1);
        saveStats();
    };
    const addonOrder = url => { const st = addonStats[baseOf(url)]; return st ? (st.fails >= 2 ? 100000 + st.fails : st.ms) : 3000; };
    const addonTimeout = url => { const st = addonStats[baseOf(url)]; return st && st.fails >= 2 ? 7000 : 22000; };
    const lookupSessions = new Map(); // "type|id" -> { total, done } addons asked / answered (or failed)
    // Everything the stream addons have answered for this title (from the cache, no network), best first:
    // closest to what you chose before, then quality. Capped so thousands of links stay a usable list.
    function buildStreamList(type, id, memoryKey) {
        const sources = loadedAddons().filter(({ m }) => supports(m, 'stream', type, id));
        const got = [];
        sources.forEach(({ url }) => { const h = streamListCache.get(`${url}|${type}|${id}`); if (h && Date.now() - h.at < STREAM_LIST_TTL) got.push(...h.streams); });
        const sess = lookupSessions.get(`${type}|${id}`) || { total: sources.length, done: sources.length };
        lookupInfo.set(`${type}|${id}`, {
            asked: sources.length,
            answered: got.length,
            torrents: got.filter(x => x && !x.url && x.infoHash).length,
            messages: got.filter(x => x && !x.url && !x.infoHash && (x.externalUrl || x.name || x.title)).length,
            pending: Math.max(0, sess.total - sess.done),
            errors: (sess.errs || []).slice(0, 4),
            enabledStreamAddons: allAddonUrls().filter(u => { const mm = manifests.get(u); return !mm || (mm.resources || []).some(r => (typeof r === 'string' ? r : r.name) === 'stream'); }).length
        });
        const rank = { '4K': 4, '1080p': 3, '720p': 2, '480p': 1, '': 0 };
        const seen = new Set();
        const out = [];
        got.forEach(x => { if (x && typeof x.url === 'string' && /^https?:\/\//i.test(x.url) && !seen.has(x.url)) { seen.add(x.url); out.push(x); } });
        // A donation or community link sent as if it were a video is a message (see notesFrom), not a stream.
        for (let i = out.length - 1; i >= 0; i--) if (DONATE.test(linkHost(out[i].url))) out.splice(i, 1);
        const mem = window.reddatePrefs.get('streamPref', {}) || {};
        const exact = memoryKey && mem[memoryKey];
        const sig = exact || mem['*'] || null;
        const perAddon = {}, perQuality = {};
        const nth = {}; // which of its addon's streams (in this quality) this is: interleaves addons instead of one after another
        return out.map(x => {
            const m = sig ? matchStream(sig, x) : { score: 0, why: '' };
            const nk = `${x._addon || ''}|${qualityOf(x)}`;
            nth[nk] = (nth[nk] || 0) + 1;
            return {
                _i: nth[nk],
                url: x.url, addon: x._addon || '', logo: x._logo || '', name: String(x.name || '').slice(0, 80), title: String(x.title || x.description || '').slice(0, 300),
                quality: qualityOf(x),
                filename: (x.behaviorHints && x.behaviorHints.filename) || '',
                bitrate: bitrateOf(x),
                match: m.score, matchWhy: m.why, matchExact: !!exact
            };
        }).sort((a, b) => (b.match - a.match) || (rank[b.quality] - rank[a.quality]) || (a._i - b._i))
          // No one addon or quality may crowd out the rest: up to 80 from each addon and 60 of each quality.
          .filter(x => {
              const q = x.quality || '?';
              // Only streams that make the list count against an addon or a quality.
              if ((perQuality[q] || 0) >= 60 || (perAddon[x.addon] || 0) >= 80) return false;
              perQuality[q] = (perQuality[q] || 0) + 1;
              perAddon[x.addon] = (perAddon[x.addon] || 0) + 1;
              return true;
          })
          .slice(0, 500)
          .map(({ _i, ...rest }) => rest);
    }

    function fetchStreamList(url, m, type, id, timeout) {
        const key = `${url}|${type}|${id}`;
        const hit = streamListCache.get(key);
        if (hit && Date.now() - hit.at < STREAM_LIST_TTL) return Promise.resolve(hit.streams);
        return streamSlots(() => getJson(`${baseOf(url)}/stream/${type}/${encodeURIComponent(id)}.json`, timeout || STREAM_TIMEOUT))
            .then(d => {
                // One addon with thousands of links must not drown the rest: keep its first 300.
                const streams = (d.streams || []).slice(0, 300)
                    // A YouTube video (Stremio's ytId) plays in the YouTube player: give it a link the player understands.
                    .map(s => (s && typeof s.ytId === 'string' && /^[\w-]{11}$/.test(s.ytId) && !s.url ? { ...s, url: `https://www.youtube.com/watch?v=${s.ytId}` } : s))
                    .filter(s => !(s && s.externalUrl && !s.url && /youtube\.com|youtu\.be/.test(String(s.externalUrl))))
                    .map(s => ({ ...s, _addon: m.name, _logo: logoOf(url, m) }));
                streamListCache.set(key, { at: Date.now(), streams });
                while (streamListCache.size > 600) streamListCache.delete(streamListCache.keys().next().value); // oldest first
                return streams;
            });
    }

    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

    // Source tabs above the stream list (like Nuvio): ↻ refresh, "All", then one per addon.
    let sourceFilter = 'all'; // 'all' or a stream addon's manifest URL

    function renderSourceChips(sources, type, id, label) {
        const bar = $('sourceChips');
        bar.innerHTML = '';
        const chip = (text, cls, onclick, title) => {
            const b = el('button', `chip ${cls || ''}`, text);
            if (title) { b.title = title; b.setAttribute('aria-label', title); }
            b.onclick = onclick;
            bar.appendChild(b);
            return b;
        };
        chip('↻', 'chip-refresh', () => {
            // Ask the addons again (e.g. a debrid addon finished caching), and retest.
            sources.forEach(({ url }) => streamListCache.delete(`${url}|${type}|${id}`));
            [...viewCache.keys()].filter(k => k.startsWith(`${type}|${id}|`)).forEach(k => viewCache.delete(k));
            probeCache.clear();
            loadStreams(type, id, label, ++detailToken);
        }, 'Refresh streams');
        const pick = value => () => { sourceFilter = value; loadStreams(type, id, label, ++detailToken); };
        chip('All', sourceFilter === 'all' ? 'active' : '', pick('all'));
        sources.forEach(({ url, m }) => chip(m.name, sourceFilter === url ? 'active' : '', pick(url)));
        bar.style.display = '';
    }

    async function loadStreams(type, id, label, token) {
        cancelProbes();
        const list = $('streamList');
        list.innerHTML = '';
        const allSources = loadedAddons().filter(({ m }) => supports(m, 'stream', type, id));
        if (!allSources.some(({ url }) => url === sourceFilter)) sourceFilter = 'all';
        const sources = sourceFilter === 'all' ? allSources : allSources.filter(({ url }) => url === sourceFilter);
        const fromName = sourceFilter === 'all' ? '' : ` from ${sources[0].m.name}`;
        if (allSources.length) renderSourceChips(allSources, type, id, label);
        else $('sourceChips').style.display = 'none';
        if (!sources.length) {
            // Reddate ships no stream sources: playing needs an addon the room adds itself.
            setStatus('streamStatus', 'To play this, add a stream addon to the room — paste its manifest URL.');
            const btn = el('button', 'btn btn-primary', 'Paste a stream addon');
            btn.onclick = () => window.reddatePages.openAddons();
            list.appendChild(btn);
            return;
        }
        const ctx = { type, id };
        const seen = new Set();
        const all = [];             // every usable candidate so far, best first
        const queue = [];           // candidates still to check, best first
        const failed = new Set();   // tested and didn't play, or can't be decoded here

        // This tab's results so far (kept across tab switches): show them right away,
        // and only keep searching if the tab wasn't finished.
        const viewKey = `${type}|${id}|${sourceFilter}`;
        let view = viewCache.get(viewKey);
        if (!view || Date.now() - view.at > STREAM_LIST_TTL) {
            view = { at: Date.now(), rows: [], done: false, status: '' };
            viewCache.set(viewKey, view);
        }
        view.rows.forEach(({ s, info }) => {
            renderStreamRow(list, s, label, ctx, info);
            seen.add(s.url);
        });
        if (view.done) { setStatus('streamStatus', view.status); return; }
        // One generic loader for fetching and checking; viewers don't need the mechanics.
        if (view.rows.length) setStatus('streamStatus', TAP_TO_PLAY);
        else setLoading('streamStatus', 'Finding streams…');
        const finishView = status => {
            view.done = true;
            view.status = status;
            setStatus('streamStatus', status);
        };
        let found = view.rows.length;
        let blocked = false;        // the device refuses even muted test playback
        let timedOut = false;
        let pending = sources.length;
        let budget = null;
        let endBudget;
        const budgetOver = new Promise(resolve => { endBudget = resolve; });
        const stop = () => token !== detailToken || timedOut || blocked || found >= WANTED_PLAYABLE;

        // Idle checkers wait here until another addon's results arrive.
        const waiters = [];
        const wake = () => waiters.splice(0).forEach(resolve => resolve());

        const addStreams = streams => {
            streams.forEach(s => {
                // Torrent/magnet-only results and duplicates can't be used.
                if (!s || typeof s.url !== 'string' || !/^https?:\/\//i.test(s.url) || seen.has(s.url)) return;
                seen.add(s.url);
                const hints = s.behaviorHints || {};
                // The same file often comes from several torrents/hosts: keep one.
                if (hints.filename) {
                    const fileKey = `${hints.filename}|${hints.videoSize || ''}`;
                    if (seen.has(fileKey)) return;
                    seen.add(fileKey);
                }
                // Needs request headers a <video> can't send, or too big to stream.
                if (hints.proxyHeaders || hints.videoSize > MAX_STREAM_BYTES) return;
                s._score = likelihood(s);
                all.push(s);
                queue.push(s);
            });
            all.sort((a, b) => b._score - a._score);
            queue.sort((a, b) => b._score - a._score);
            // The time budget starts once there's something to check, so a slow
            // addon's own search time doesn't eat into it.
            if (!budget && queue.length) {
                budget = setTimeout(() => { timedOut = true; cancelProbes(); endBudget(); wake(); }, SEARCH_BUDGET);
            }
        };

        // Check each addon's results as soon as that addon answers — don't wait for the slowest.
        sources.forEach(({ url, m }) => {
            fetchStreamList(url, m, type, id)
                .then(streams => { if (token === detailToken) addStreams(streams); })
                .catch(() => {})
                .finally(() => { pending--; wake(); });
        });

        const worker = async () => {
            while (!stop()) {
                if (!queue.length) {
                    if (!pending) return;
                    await Promise.race([new Promise(resolve => waiters.push(resolve)), budgetOver]);
                    continue;
                }
                const s = queue.shift();
                if (!mightPlay(s, null)) { failed.add(s.url); continue; } // ruled out by name alone (e.g. MKV on iPhone)
                // Read the track info and test-play at the same time; if the track info
                // shows this browser can't decode the file, the test is cancelled.
                let ruledOut = false;
                const tracksP = readTracks(s.url);
                tracksP.then(tracks => {
                    if (!mightPlay(s, tracks)) { ruledOut = true; abortProbe(s.url); }
                });
                // Playback tests need a visible tab — but don't wait past the time budget.
                await Promise.race([whenVisible(), budgetOver]);
                if (stop()) return;
                if (ruledOut) { failed.add(s.url); continue; }
                const ok = await probeStream(s.url);
                if (token !== detailToken) return;
                if (ok === 'blocked') { blocked = true; cancelProbes(); return; }
                if (ok === null) {                                   // cancelled
                    if (ruledOut) failed.add(s.url);
                    else if (!stop()) queue.unshift(s);              // cut short: retry later
                    continue;
                }
                if (!ok) { failed.add(s.url); continue; }
                if (found < WANTED_PLAYABLE) {
                    found++;
                    // Use the track info for the language note if it's ready within a moment.
                    const tracks = await Promise.race([tracksP, delay(1500).then(() => null)]);
                    if (token !== detailToken) return;
                    const info = audioInfo(s, tracks);
                    renderStreamRow(list, s, label, ctx, info);
                    view.rows.push({ s, info });
                    // Set on every row shown: checkers finish out of order, so "the first
                    // one found" isn't necessarily the first one displayed.
                    setStatus('streamStatus', TAP_TO_PLAY);
                    if (found >= WANTED_PLAYABLE) cancelProbes(); // enough; stop the rest now
                }
            }
        };
        await Promise.all(Array.from({ length: PROBE_CONCURRENCY }, worker));
        clearTimeout(budget);
        if (token !== detailToken) return; // switched away mid-search: keep results, not "done"
        if (found) { finishView(TAP_TO_PLAY); return; }

        // Nothing confirmed (time ran out, or this device won't allow test playback):
        // offer the best streams that weren't ruled out instead of a dead end.
        const fallback = [];
        for (const s of all) {
            if (fallback.length >= WANTED_PLAYABLE) break;
            if (failed.has(s.url)) continue;
            // Use track info only if it has already arrived (race against an
            // already-resolved null); don't wait on slow lookups here.
            const tracks = trackCache.has(s.url) ? await Promise.race([trackCache.get(s.url), Promise.resolve(null)]) : null;
            if (mightPlay(s, tracks)) fallback.push({ s, tracks });
        }
        if (token !== detailToken) return;
        if (fallback.length) {
            fallback.forEach(({ s, tracks }) => {
                const info = audioInfo(s, tracks);
                renderStreamRow(list, s, label, ctx, info);
                view.rows.push({ s, info });
            });
            finishView('These might work on this device — pick one to try.');
        } else {
            finishView(fromName
                ? `No streams${fromName} can play on this device for this title — try All or another addon.`
                : 'No streams for this title can play on this device. Try another title, or add another stream addon.');
        }
    }

    function playForRoom(stream, label, content) {
        cancelProbes(); // free the bandwidth for real playback
        // `content` says what's playing so each viewer can fetch subtitles for it.
        const filename = (stream.behaviorHints && stream.behaviorHints.filename) || stream.title || stream.description || '';
        if (rememberChoiceFn) rememberChoiceFn(content.show || content.id, stream.url);
        const send = () => socket.emit('load-video', {
            kind: 'direct', src: stream.url, title: label,
            content: {
                type: content.type, id: content.id, filename: String(filename).slice(0, 200),
                art: (currentMeta && (currentMeta.background || currentMeta.poster)) || undefined
            }
        });
        const room = window.reddateRoom;
        const home = window.reddateHome;
        if (room && !room.isInRoom() && home) {
            // Not watching yet: ask "alone or together?", then the room is created and the video starts.
            home.askHowToWatch(label, ({ name, together }) => {
                modal.classList.remove('show');
                home.closeTitle(true);
                room.enterRoom(name, null, () => { send(); if (together) home.showInvite(); }, { lazy: !together });
            });
            return;
        }
        send();
        modal.classList.remove('show');
        if (home) home.closeTitle(true);
        if (room) room.showRoom();
        toast(`▶️ Loading “${label}” for everyone`);
    }

    // Full details for a title from whichever addon can describe it (our catalog for tmdb ids).
    const metaCache = new Map();
    async function fullMeta(type, id) {
        const key = `${type}:${id}`;
        if (metaCache.has(key)) return metaCache.get(key);
        await manifestsReady(8000);
        const addon = loadedAddons().find(({ m }) => supports(m, 'meta', type, id));
        // A catalog addon with no meta of its own: IMDb ids still get full details from Cinemeta (the official Stremio addon).
        const useCinemeta = !addon && /^tt\d+/.test(id) && (type === 'movie' || type === 'series');
        if (!addon && !useCinemeta) return null;
        const metaBase = addon ? baseOf(addon.url) : 'https://v3-cinemeta.strem.io';
        const p = getJson(`${metaBase}/meta/${type}/${encodeURIComponent(id)}.json`, CATALOG_TIMEOUT).then(d => (d && d.meta) || null);
        metaCache.set(key, p);
        p.catch(() => metaCache.delete(key));
        return p;
    }

    // ---------- subtitles (used by tracks.js) ----------
    // Every subtitle-capable addon (built-in OpenSubtitles + any the room added).
    async function fetchSubtitles(type, id) {
        await manifestsReady(8000);
        const sources = loadedAddons().filter(({ m }) => supports(m, 'subtitles', type, id));
        const results = await Promise.allSettled(sources.map(({ url, m }) =>
            getJson(`${baseOf(url)}/subtitles/${type}/${encodeURIComponent(id)}.json`, CATALOG_TIMEOUT)
                .then(d => (d.subtitles || []).map(s => ({ ...s, _addon: m.name })))
        ));
        const seen = new Set();
        const out = [];
        results.forEach(r => {
            if (r.status !== 'fulfilled') return;
            r.value.forEach(s => {
                if (!s || typeof s.url !== 'string' || !/^https?:\/\//i.test(s.url) || seen.has(s.url)) return;
                seen.add(s.url);
                out.push({
                    url: s.url,
                    lang: typeof s.lang === 'string' ? s.lang : 'und',
                    name: String(s.subtitleFileName || s.movieReleaseName || '').slice(0, 120),
                    addon: s._addon
                });
            });
        });
        return out;
    }
    // What the Home screen (home.js) needs from here.
    window.reddateAddons = {
        fetchSubtitles,
        ready,
        openDetail,
        fullMeta,
        isOwnCatalog,
        catalogUrl: () => catalogUrl,
        loadedAddons: () => loadedAddons(),
        catalogsForType,
        getJson: url => getJson(url, CATALOG_TIMEOUT),
        baseOf,
        // For the TV app's native screens: every stream the enabled stream addons offer, best first.
        // ---- remembering the kind of stream you like ----
        // A stream's "fingerprint": addon, quality, source, codec, container, languages, release group.
        sigOf: s => streamSig(s),
        // Remember the stream played for `key` (a show's id, or a movie's) and as the general preference.
        rememberChoice(key, url) {
            let s = null;
            for (const { streams } of streamListCache.values()) { s = streams.find(x => x.url === url); if (s) break; }
            if (!s) return null;
            const sig = streamSig(s);
            const P = window.reddatePrefs;
            const map = Object.assign({}, P.get('streamPref', {}) || {});
            if (key) { delete map[key]; map[key] = sig; }
            map['*'] = sig;
            const keys = Object.keys(map).filter(k => k !== '*');
            while (keys.length > 12) delete map[keys.shift()];
            P.set('streamPref', map);
            return sig;
        },
        rememberedFor: key => { const m = window.reddatePrefs.get('streamPref', {}) || {}; return (key && m[key]) || null; },
        // The TV's stream list. With many addons, one slow or dead one must not hold everything up:
        // everyone gets up to 12 s, but as soon as something has arrived the list is returned after 5 s.
        // Anything that comes in later is kept, so "refresh" shows it.
        // From every answer so far, including addons that answered after the list was shown.
        lookupInfo: (type, id) => lookupInfo.get(`${type}|${id}`) || null,
        // A file's real codecs (MKV header read here or by the server), for the browser app's "plays here?" check.
        readTracks: url => readTracks(String(url || '')),
        notesFor: (type, id) => notesFrom(loadedAddons().filter(({ m }) => supports(m, 'stream', type, id))
            .flatMap(({ url }) => { const hit = streamListCache.get(`${url}|${type}|${id}`); return hit ? hit.streams : []; })),
        async streamsFor(type, id, memoryKey) {
            await manifestsReady(10000);
            const sources = loadedAddons().filter(({ m }) => supports(m, 'stream', type, id))
                .sort((a, b) => addonOrder(a.url) - addonOrder(b.url));
            const sess = { total: sources.length, done: 0 };
            lookupSessions.set(`${type}|${id}`, sess);
            await new Promise(resolve => {
                let finished = false;
                const finish = () => { if (!finished) { finished = true; clearTimeout(soft); clearTimeout(hard); resolve(); } };
                const have = () => sources.some(({ url }) => { const h = streamListCache.get(`${url}|${type}|${id}`); return h && h.streams.length; });
                // Return after 4 s when something has arrived, after 13 s regardless. Slower addons keep going and
                // show up through streamsMore (the TV keeps asking for a while).
                const soft = setTimeout(() => { if (have()) finish(); }, 4000);
                const hard = setTimeout(finish, 13000);
                if (!sources.length) return finish();
                sources.forEach(({ url, m }) => {
                    const t0 = Date.now();
                    fetchStreamList(url, m, type, id, addonTimeout(url))
                        .then(() => noteAddon(url, true, Date.now() - t0), e => { noteAddon(url, false, 0); (sess.errs = sess.errs || []).push(String((e && e.message) || e).slice(0, 80)); })
                        .finally(() => { sess.done++; if (sess.done === sess.total) finish(); });
                });
            });
            return buildStreamList(type, id, memoryKey);
        },
        // What has arrived since: everything answered so far, and how many addons are still working on it.
        streamsMore(type, id, memoryKey) {
            const sess = lookupSessions.get(`${type}|${id}`) || { total: 0, done: 0 };
            return { streams: buildStreamList(type, id, memoryKey), pending: Math.max(0, sess.total - sess.done) };
        },
        manage: {
            // Every addon you have, with what it does: catalog (rows on Home), stream (things to play), subtitles.
            list: () => [...activeBuiltIns(), ...roomAddonUrls].map(url => {
                const m = manifests.get(url);
                const host = (() => { try { return new URL(url).host; } catch { return ''; } })();
                const res = m ? [...new Set(resourceNames(m))] : [];
                return {
                    url, builtIn: BUILT_INS.includes(url), enabled: !isOff(url), loaded: !!m, host, logo: logoOf(url, m),
                    name: m ? m.name : 'Unavailable addon',
                    description: m && typeof m.description === 'string' ? m.description.slice(0, 140) : '',
                    catalog: !!(m && (m.catalogs || []).length), stream: res.includes('stream'), subtitles: res.includes('subtitles'),
                    rows: m ? (m.catalogs || []).filter(c => c.type === 'movie' || c.type === 'series').length : 0
                };
            }),
            add: addAddonUrl,
            // Names for the Addons screen: a switched-off addon is never loaded for playing, so without this it would
            // show as "Unavailable". Reading its manifest doesn't switch it on. Waits up to maxMs.
            async describeAll(maxMs) {
                await ready;
                const urls = [...activeBuiltIns(), ...roomAddonUrls].filter(u => !manifests.get(u));
                if (!urls.length) return;
                const all = urls.map(u => loadManifest(u).catch(() => null));
                await Promise.race([Promise.allSettled(all), new Promise(r => setTimeout(r, maxMs || 6000))]);
            },
            async remove(url) {
                if (BUILT_INS.includes(url)) { togglePref('builtinsRemoved', url, true); afterAddonChange(); return; }
                await removeAddon(url);
            },
            setEnabled: setAddonEnabled,
            whenLoaded: ms => manifestsReady(ms || 8000),
            // "Sync": take whatever the account has now (added on the phone), load it, and refresh Home and the lists.
            async resync() {
                const R = window.reddateRoom;
                const before = roomAddonUrls.length;
                if (acct() && acct().refresh) { try { await acct().refresh(); } catch (e) { /* offline: use what we have */ } }
                if (!(R && R.isInRoom() && R.isGuest && R.isGuest())) { // a guest keeps the host's list
                    const mine = loadMine();
                    // In a room the room's list is kept and yours added to it; otherwise yours is the list.
                    roomAddonUrls = R && R.isInRoom() ? [...new Set([...roomAddonUrls, ...mine])].slice(0, 60) : mine;
                    knownMine = JSON.stringify(mine);
                }
                await Promise.allSettled(roomAddonUrls.map(u => loadManifest(u).catch(() => null)));
                publishAddons(); renderAddonList(); refreshCatalogs();
                if (window.reddateHome) window.reddateHome.rebuild();
                document.dispatchEvent(new CustomEvent('reddate:addons-changed'));
                return { count: roomAddonUrls.length, added: Math.max(0, roomAddonUrls.length - before) };
            },
            async removeMany(urls) {
                const drop = new Set(urls);
                roomAddonUrls = roomAddonUrls.filter(u => !drop.has(u));
                if (acct()) acct().removeAddons([...drop]); else saveMine(loadMine().filter(u => !drop.has(u)));
                publishAddons(); renderAddonList(); refreshCatalogs();
                if (window.reddateHome) window.reddateHome.rebuild();
            },
            // Addons you can add with one tap: the built-ins you removed, plus Stremio's public catalog.
            async suggested() {
                const out = BUILT_INS.filter(u => inPref('builtinsRemoved', u));
                if (!BUILT_INS.includes(CINEMETA_URL) && !roomAddonUrls.includes(CINEMETA_URL)) out.push(CINEMETA_URL);
                await Promise.allSettled(out.map(u => loadManifest(u).catch(() => null)));
                return out.map(url => {
                    const m = manifests.get(url);
                    return { url, name: m ? m.name : url, description: m && m.description ? String(m.description).slice(0, 140) : '' };
                });
            },
            async restore(url) {
                if (BUILT_INS.includes(url)) { togglePref('builtinsRemoved', url, false); afterAddonChange(); return { ok: true }; }
                return addAddonUrl(url);
            }
        },
        openSources: tab => {
            if (window.reddatePages && tab !== 'browse') { tab === 'addons' ? window.reddatePages.openAddons() : window.reddatePages.openYouTube(); return; }
            modal.classList.add('show');
            if (tab === 'addons') { renderAddonList(); showView('addons'); }
            else if (tab === 'youtube') showView('youtube');
            else if (tab === 'link') showView('link');
            else showView('browse');
        },
        stopChecks: () => { detailToken++; cancelProbes(); }
    };
    rememberChoiceFn = (k, u) => window.reddateAddons.rememberChoice(k, u);

    // ---------- wiring ----------
    $('browseBtn').addEventListener('click', async () => {
        // The app's catalog lives on the Home screen now; the room stays alive while you browse.
        if (window.reddateHome) { window.reddateRoom.showHome(); return; }
        modal.classList.add('show');
        showView('browse');
        if (!manifests.get(catalogUrl)) {
            setStatus('browseStatus', 'Loading catalogs…');
            await Promise.allSettled(allAddonUrls().map(loadManifest));
            renderAddonList();
        }
        refreshCatalogs();
    });
    $('browseTabBtn').addEventListener('click', () => showView('browse'));
    $('addonsTabBtn').addEventListener('click', () => { renderAddonList(); showView('addons'); });
    $('youtubeTabBtn').addEventListener('click', () => { showView('youtube'); $('youtubeUrl').focus(); });
    $('linkTabBtn').addEventListener('click', () => { showView('link'); $('videoUrl').focus(); });
    $('detailBackBtn').addEventListener('click', () => {
        detailToken++; cancelProbes();
        if (window.reddateHome) window.reddateHome.closeTitle(); else showView('browse');
    });
    // However the modal gets closed (backdrop, ✕, or picking a stream), stop stream checks.
    new MutationObserver(() => {
        if (!modal.classList.contains('show')) { detailToken++; cancelProbes(); }
    }).observe(modal, { attributes: true, attributeFilter: ['class'] });
    $('addAddonBtn').addEventListener('click', addAddon);
    $('addonUrlInput').addEventListener('keydown', e => { if (e.key === 'Enter') addAddon(); });
    $('catalogSelect').addEventListener('change', e => {
        selectedCatalog = e.target.value;
        $('browseSearch').value = '';
        loadCatalog();
    });
    document.querySelectorAll('.type-toggle button').forEach(btn => {
        btn.addEventListener('click', () => {
            browseType = btn.dataset.type;
            document.querySelectorAll('.type-toggle button').forEach(b => b.classList.toggle('active', b === btn));
            refreshCatalogs();
        });
    });
    $('browseSearch').addEventListener('input', e => {
        clearTimeout(searchTimer);
        const q = e.target.value.trim();
        searchTimer = setTimeout(() => (q ? runSearch(q) : loadCatalog()), 400);
    });

    // Load manifests in the background so the modal opens fast.
    // (Manifests start loading as soon as the catalog choice is known — see `ready` above.)
};
