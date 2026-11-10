/* Stremio-compatible addons: browse catalogs, pick a stream, watch together.
 *
 * Addons are plain HTTP services (manifest.json + /catalog, /meta, /stream
 * JSON endpoints) that send `Access-Control-Allow-Origin: *`, so the browser
 * talks to them directly — the Reddate server never proxies them.
 *
 * Addon URLs often embed personal auth tokens, so a room's addon list is
 * shared E2E encrypted with the room key: the server stores and relays an
 * opaque blob it cannot read. Only the stream URL someone picks to play goes
 * through the server, exactly like pasting a direct video link.
 *
 * initAddons() is called from app.js once the socket exists.
 */
window.initAddons = function (socket, { roomId, encrypt, decrypt, toast }) {
    // Built-ins: a catalog (browsing works before anything is added) and a
    // subtitle source. Reddate ships no stream source — rooms add their own.
    const CINEMETA_URL = 'https://v3-cinemeta.strem.io/manifest.json';
    const OPENSUBS_URL = 'https://opensubtitles-v3.strem.io/manifest.json';
    const BUILT_INS = [CINEMETA_URL, OPENSUBS_URL];
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

    async function loadManifest(url) {
        if (manifests.has(url) && manifests.get(url)) return manifests.get(url);
        try {
            const m = await getJson(url, CATALOG_TIMEOUT);
            if (!m || !m.id || !Array.isArray(m.resources)) throw new Error('Not a Stremio addon manifest');
            manifests.set(url, m);
            return m;
        } catch (e) {
            manifests.set(url, null);
            throw e;
        }
    }

    // Every addon in play: built-ins first, then the room's.
    function allAddonUrls() { return [...BUILT_INS, ...roomAddonUrls]; }
    function loadedAddons() {
        return allAddonUrls().map(url => ({ url, m: manifests.get(url) })).filter(a => a.m);
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

    // ---------- room addon list (E2E encrypted) ----------
    // Rooms vanish when the last person leaves, so the list is also kept in this
    // browser (only on this device) and restored if you rejoin an empty room —
    // otherwise refreshing while alone in a room would lose its addons.
    const localKey = `reddate-addons:${roomId}`;
    function saveLocal() {
        try { localStorage.setItem(localKey, JSON.stringify(roomAddonUrls)); } catch (e) {}
    }
    function loadLocal() {
        try {
            const list = JSON.parse(localStorage.getItem(localKey) || '[]');
            return Array.isArray(list) ? list.filter(u => typeof u === 'string').slice(0, 20) : [];
        } catch (e) { return []; }
    }

    async function publishAddons() {
        saveLocal();
        const payload = await encrypt({ v: 1, addons: roomAddonUrls });
        socket.emit('set-addons', payload);
    }

    let roomHasAddonList = false; // server sends 'addons-updated' before 'joined' if the room has one
    socket.on('connect', () => { roomHasAddonList = false; }); // every (re)join starts fresh
    socket.on('addons-updated', async data => {
        roomHasAddonList = true;
        try {
            const obj = await decrypt(data);
            roomAddonUrls = Array.isArray(obj.addons) ? obj.addons.filter(u => typeof u === 'string').slice(0, 20) : [];
        } catch {
            toast('⚠️ Could not decrypt the room\'s addon list');
            return;
        }
        saveLocal();
        await Promise.allSettled(roomAddonUrls.map(loadManifest));
        if (data.user) toast(`🧩 ${data.user} updated the room's addons`);
        renderAddonList();
        if (modal.classList.contains('show')) refreshCatalogs();
    });

    socket.on('joined', async () => {
        if (roomHasAddonList) return;
        const saved = loadLocal();
        if (!saved.length) return;
        roomAddonUrls = saved;
        await Promise.allSettled(roomAddonUrls.map(loadManifest));
        await publishAddons();
        renderAddonList();
        if (modal.classList.contains('show')) refreshCatalogs();
    });

    async function addAddon() {
        const input = $('addonUrlInput');
        let url;
        try { url = normalizeManifestUrl(input.value); } catch (e) { toast(e.message); return; }
        if (allAddonUrls().includes(url)) { toast('That addon is already added'); return; }
        const btn = $('addAddonBtn');
        btn.disabled = true;
        setStatus('addonStatus', 'Checking addon…');
        try {
            const m = await loadManifest(url);
            roomAddonUrls.push(url);
            input.value = '';
            setStatus('addonStatus', `Added ${m.name} ✅`);
            await publishAddons();
            renderAddonList();
            refreshCatalogs();
        } catch (e) {
            setStatus('addonStatus', `Couldn't add that addon: ${e.message}`);
        } finally {
            btn.disabled = false;
        }
    }

    async function removeAddon(url) {
        roomAddonUrls = roomAddonUrls.filter(u => u !== url);
        await publishAddons();
        renderAddonList();
        refreshCatalogs();
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
            card.onclick = () => openDetail(meta);
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

    async function openDetail(meta) {
        const token = ++detailToken;
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
            loadStreams(type, meta.id, meta.name, token);
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
                    const label = `E${v.episode ?? '?'} — ${v.name || v.title || 'Episode'}`;
                    const btn = el('button', 'episode-btn', label);
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
        top.appendChild(el('span', 'stream-addon', s._addon));
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

    function fetchStreamList(url, m, type, id) {
        const key = `${url}|${type}|${id}`;
        const hit = streamListCache.get(key);
        if (hit && Date.now() - hit.at < STREAM_LIST_TTL) return Promise.resolve(hit.streams);
        return getJson(`${baseOf(url)}/stream/${type}/${encodeURIComponent(id)}.json`, STREAM_TIMEOUT)
            .then(d => {
                const streams = (d.streams || []).map(s => ({ ...s, _addon: m.name }));
                streamListCache.set(key, { at: Date.now(), streams });
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
            btn.onclick = () => { renderAddonList(); showView('addons'); $('addonUrlInput').focus(); };
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
        socket.emit('load-video', {
            kind: 'direct', src: stream.url, title: label,
            content: { type: content.type, id: content.id, filename: String(filename).slice(0, 200) }
        });
        modal.classList.remove('show');
        toast(`▶️ Loading “${label}” for everyone`);
    }

    // ---------- subtitles (used by tracks.js) ----------
    // Every subtitle-capable addon (built-in OpenSubtitles + any the room added).
    async function fetchSubtitles(type, id) {
        await Promise.allSettled(allAddonUrls().map(u => loadManifest(u).catch(() => null)));
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
    window.reddateAddons = { fetchSubtitles };

    // ---------- wiring ----------
    $('browseBtn').addEventListener('click', async () => {
        modal.classList.add('show');
        showView('browse');
        if (!manifests.get(CINEMETA_URL)) {
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
    $('detailBackBtn').addEventListener('click', () => { detailToken++; cancelProbes(); showView('browse'); });
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
    BUILT_INS.forEach(u => loadManifest(u).catch(() => {}));
};
