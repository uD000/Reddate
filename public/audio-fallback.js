/* Embedded-file audio for browsers without audioTracks. The video still plays
 * directly from its source. Short server-decoded audio chunks follow the video's
 * timeline, including pauses, buffering, seeking and playback speed changes. */
(function () {
    let sharedContext = null;
    window.createAudioFallback = function (video, url, onChange) {
        let session = null, loading = null, disposed = false;
        let selected = null, pendingIndex = null, active = false, waiting = false;
        let status = '', selectionId = 0, warmedIndex = null, gain = null, anchor = null;
        let originalMuted = video.muted, muted = video.muted;
        let buffering = false, recovering = false;
        const RESUME_SECONDS = 5;
        const cache = new Map(), nodes = new Map(), listeners = [];
        const metadataController = new AbortController();
        const clientId = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
        const clientHeaders = { 'X-Reddate-Audio-Client': clientId };

        const changed = () => { if (!disposed) onChange(); };
        const defaultTrack = () => session && (session.tracks.find(t => t.isDefault) || session.tracks[0]);
        // Whether the browser can decode a track itself. Chrome and Firefox can't decode Dolby (AC-3 / E-AC-3),
        // DTS or TrueHD: such a track plays picture only, so it goes through the server's decoder instead.
        const MIME = { aac: 'audio/mp4; codecs="mp4a.40.2"', mp3: 'audio/mpeg', opus: 'audio/webm; codecs="opus"',
            vorbis: 'audio/webm; codecs="vorbis"', flac: 'audio/flac', ac3: 'audio/mp4; codecs="ac-3"', eac3: 'audio/mp4; codecs="ec-3"' };
        const browserDecodes = track => !!track && !!MIME[track.codec] && video.canPlayType(MIME[track.codec]) !== '';
        // The browser's own audio is used for the default track only when it can decode it.
        const usesOriginal = track => track === defaultTrack() && browserDecodes(track);
        // Nothing the browser can decode: the file would be silent, so decode its default track from the start.
        const needsDecoder = () => !!session && !session.tracks.some(browserDecodes);
        const context = () => {
            if (!sharedContext) sharedContext = new (window.AudioContext || window.webkitAudioContext)();
            if (!gain) { gain = sharedContext.createGain(); gain.connect(sharedContext.destination); }
            return sharedContext;
        };
        function syncVolume() {
            if (gain) gain.gain.value = muted ? 0 : video.volume;
        }
        function stopNodes() {
            for (const node of nodes.values()) { node.onended = null; try { node.stop(); } catch (_) {} }
            nodes.clear();
            anchor = null;
        }
        function setBuffering(value) {
            if (value === buffering) return;
            buffering = value;
            video.dispatchEvent(new CustomEvent('audio-buffering', { detail: { buffering: value } }));
            changed();
        }
        function clearChunks() {
            stopNodes();
            for (const entry of cache.values()) entry.controller.abort();
            cache.clear();
        }
        function restoreOriginal() {
            stopNodes();
            if (active) video.muted = originalMuted;
            video.classList.remove('external-audio');
            active = false;
            recovering = false;
            selected = defaultTrack()?.index ?? null;
            setBuffering(false);
        }
        function trimCache() {
            if (!session) return;
            const start = Math.floor(video.currentTime / session.segmentSeconds) * session.segmentSeconds;
            const keep = new Set([selected, pendingIndex ?? warmedIndex]);
            // At most two tracks × two chunks (~31 MB decoded), all in memory.
            for (const [key, entry] of cache) {
                if (!keep.has(entry.track) || entry.start < start || entry.start > start + session.segmentSeconds) {
                    entry.controller.abort(); cache.delete(key);
                }
            }
        }
        async function load(expiredToken = null) {
            if (session && (!expiredToken || session.token !== expiredToken)) return session;
            if (loading) return loading;
            const previous = session;
            status = previous ? 'Reconnecting selected audio…' : 'Finding embedded audio languages…';
            changed();
            loading = (async () => {
                try {
                    const response = await fetch('/api/audio/tracks', {
                        method: 'POST', headers: { ...clientHeaders, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ url }), signal: metadataController.signal
                    });
                    const data = await response.json();
                    if (!response.ok) throw new Error(data.error || 'Could not read this video’s audio tracks.');
                    if (disposed) {
                        fetch(`/api/audio/${data.token}`, { method: 'DELETE', headers: clientHeaders, keepalive: true }).catch(() => {});
                        return null;
                    }
                    session = data;
                    if (!previous) selected = defaultTrack().index;
                    status = '';
                    changed();
                    autoDecode();
                    return session;
                } catch (e) {
                    if (!disposed) { status = e.name === 'AbortError' ? '' : e.message; changed(); }
                    return null;
                } finally { loading = null; }
            })();
            return loading;
        }
        async function chunk(track, start) {
            const key = `${track}:${start}`;
            if (cache.has(key)) return cache.get(key).promise;
            const controller = new AbortController();
            const entry = { track, start, controller, buffer: null, promise: null };
            cache.set(key, entry);
            entry.promise = (async () => {
                let response;
                for (let attempt = 0; attempt < 2; attempt++) {
                    const token = session.token;
                    response = await fetch(`/api/audio/${token}/${track}/${start}`, { headers: clientHeaders, signal: controller.signal });
                    if (response.status !== 404 || attempt) break;
                    // Render restarts and long pauses can discard the temporary session.
                    // Renew it once without dropping the chosen language or decoded audio.
                    if (!await load(token)) throw new Error(status || 'Could not reconnect the selected audio.');
                    if (disposed || controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
                    if (!session.tracks.some(t => t.index === track)) throw new Error('The selected audio track is no longer available.');
                }
                if (!response.ok) {
                    const error = await response.json().catch(() => ({}));
                    throw new Error(error.error || 'Could not load the selected audio.');
                }
                const buffer = await context().decodeAudioData(await response.arrayBuffer());
                if (disposed || controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
                entry.buffer = buffer;
                return buffer;
            })().catch(error => {
                if (cache.get(key) === entry) cache.delete(key);
                throw error;
            });
            return entry.promise;
        }
        function audioFailed(error, track) {
            if (disposed || !active || track !== selected || error.name === 'AbortError') return;
            restoreOriginal();
            status = `${error.message} Original audio restored.`;
            changed();
        }
        function requestChunk(track, start) {
            if (cache.has(`${track}:${start}`)) return;
            chunk(track, start).then(tick).catch(error => audioFailed(error, track));
        }
        function prepare(index) {
            if (disposed || !session || pendingIndex !== null || index === defaultTrack().index || index === selected || !session.tracks.some(t => t.index === index)) return Promise.resolve();
            warmedIndex = index;
            trimCache();
            const start = Math.floor(video.currentTime / session.segmentSeconds) * session.segmentSeconds;
            // Only the considered track, never every language in the file.
            return chunk(index, start).catch(() => {});
        }
        function tick() {
            if (!active || disposed || !session || !sharedContext) return;
            const position = video.currentTime, size = session.segmentSeconds;
            const start = Math.floor(position / size) * size;
            const end = Number.isFinite(video.duration) ? video.duration : session.duration || Infinity;
            trimCache();
            requestChunk(selected, start);
            const rate = video.playbackRate || 1;
            const required = Math.min(RESUME_SECONDS * rate, size, end - position);
            // A seek near a boundary needs both chunks before playback can
            // remain smooth. Fetch that necessary lookahead during the seek,
            // rather than resume briefly and immediately pause a second time.
            if ((recovering || buffering) && start + size < end && start + size - position < required) {
                requestChunk(selected, start + size);
            }
            const current = cache.get(`${selected}:${start}`)?.buffer;
            const next = cache.get(`${selected}:${start + size}`)?.buffer;
            const available = current ? Math.max(0, Math.min(size, current.duration) - (position - start)) +
                (current.duration >= size - 0.05 && next ? Math.min(size, next.duration) : 0) : 0;
            if (!video.ended && (!current || available <= 0 || (recovering || buffering) && available + 0.05 < required)) {
                stopNodes();
                setBuffering(true);
                return;
            }
            // Resume only when this position has audio. Do not compete with
            // an uncached seek by extracting the following chunk first.
            recovering = false;
            setBuffering(false);
            if (start + size < end) requestChunk(selected, start + size);
            if (video.paused || video.seeking || video.ended || waiting) { stopNodes(); return; }
            if (anchor && (anchor.rate !== rate || Math.abs(anchor.position + (sharedContext.currentTime - anchor.time) * rate - position) > 0.15)) stopNodes();
            // Keep completed nodes until their timeline position has passed.
            // The media clock can trail the audio clock by a few milliseconds;
            // deleting onended used to replay the tail on the next timer tick.
            for (const key of nodes.keys()) if (key < start) nodes.delete(key);
            if (!anchor) anchor = { position, time: sharedContext.currentTime, rate };
            for (const key of [start, start + size]) {
                const buffer = cache.get(`${selected}:${key}`)?.buffer;
                if (!buffer || nodes.has(key)) continue;
                const offset = Math.max(0, position - key);
                const duration = Math.min(buffer.duration - offset, size - offset);
                if (duration <= 0) continue;
                const node = sharedContext.createBufferSource();
                node.buffer = buffer;
                node.playbackRate.value = rate;
                node.connect(gain);
                const when = anchor.time + (Math.max(key, position) - anchor.position) / rate;
                node.start(Math.max(sharedContext.currentTime, when), offset, duration);
                nodes.set(key, node);
            }
        }
        async function select(index) {
            if (!session || disposed) return;
            const track = session.tracks.find(t => t.index === index);
            if (!track) return;
            const request = ++selectionId;
            if (usesOriginal(track)) {
                pendingIndex = null;
                if (active) warmedIndex = selected;
                restoreOriginal(); trimCache(); status = ''; changed(); return;
            }
            if (active && index === selected) { pendingIndex = null; status = ''; changed(); return; }
            pendingIndex = index;
            warmedIndex = index;
            status = 'Switching audio…';
            changed();
            // Resume within the user's click, before fetching anything.
            try {
                await context().resume();
                if (disposed || request !== selectionId) return;
                if (sharedContext.state !== 'running') throw new Error('Click the language again to enable audio.');
                trimCache();
                // The current chunk gets priority. Prefetching the following
                // chunk first used to compete with the audio needed right now.
                for (let attempt = 0; attempt < 4; attempt++) {
                    const start = Math.floor(video.currentTime / session.segmentSeconds) * session.segmentSeconds;
                    await chunk(index, start);
                    if (disposed || request !== selectionId) return;
                    if (Math.floor(video.currentTime / session.segmentSeconds) * session.segmentSeconds === start) break;
                    if (attempt === 3) throw new Error('This source is loading too slowly. Try again while paused.');
                }
                // Keep the previous audio playing until this track is ready.
                stopNodes();
                if (!active) { originalMuted = video.muted; muted = originalMuted; }
                selected = index;
                active = true;
                recovering = true;
                pendingIndex = null;
                video.muted = true;
                video.classList.add('external-audio');
                syncVolume();
                status = '';
                waiting = video.readyState < 3;
                tick(); changed();
            } catch (error) {
                if (disposed || request !== selectionId) return;
                pendingIndex = null;
                status = `${error.message} Current audio is unchanged.`;
                changed();
                if (error.name !== 'AbortError') throw error;
            }
        }
        function listen(event, fn) {
            video.addEventListener(event, fn);
            listeners.push(() => video.removeEventListener(event, fn));
        }
        // A file the browser can't hear at all (Dolby-only, DTS…) starts on the server-decoded default track.
        // Web Audio may start only after the viewer has used the page, so it is tried again on play and on a tap.
        let autoTries = 0;
        function autoDecode() {
            if (disposed || active || pendingIndex !== null || !needsDecoder() || autoTries >= 3) return;
            autoTries++;
            select(defaultTrack().index).catch(() => {});
        }
        listen('play', autoDecode);
        // Resuming inside the tap itself is what Chrome accepts; one asked for earlier stays pending until then.
        const onGesture = () => {
            if (sharedContext && sharedContext.state !== 'running') sharedContext.resume().catch(() => {});
            autoDecode();
        };
        document.addEventListener('pointerdown', onGesture, true);
        document.addEventListener('keydown', onGesture, true);
        listeners.push(() => { document.removeEventListener('pointerdown', onGesture, true); document.removeEventListener('keydown', onGesture, true); });
        ['pause', 'ended'].forEach(event => listen(event, stopNodes));
        listen('seeking', () => {
            recovering = true;
            stopNodes();
            trimCache();
            // Start loading during the seek, overlapping the video's own load.
            tick();
        });
        listen('waiting', () => { waiting = true; stopNodes(); });
        listen('playing', () => { waiting = false; tick(); });
        listen('seeked', () => {
            waiting = video.readyState < 3;
            trimCache();
            if (pendingIndex !== null) select(pendingIndex).catch(() => {});
            tick();
        });
        listen('ratechange', () => { stopNodes(); tick(); });
        listen('volumechange', () => {
            if (active && !video.muted) { muted = false; originalMuted = false; video.muted = true; }
            syncVolume();
        });
        const timer = setInterval(tick, 150);
        return {
            load, select, prepare,
            setMuted(value) {
                muted = originalMuted = !!value;
                video.muted = active ? true : muted;
                syncVolume();
            },
            get tracks() { return session?.tracks || []; },
            get selected() { return selected; },
            get active() { return active; },
            get pending() { return pendingIndex !== null; },
            get pendingIndex() { return pendingIndex; },
            get buffering() { return buffering; },
            get status() { return buffering ? 'Buffering selected audio…' : status; },
            get canAutoSelect() { return sharedContext?.state === 'running'; },
            destroy() {
                disposed = true;
                selectionId++;
                metadataController.abort();
                clearInterval(timer);
                listeners.forEach(remove => remove());
                restoreOriginal();
                clearChunks();
                if (gain) gain.disconnect();
                if (session) fetch(`/api/audio/${session.token}`, { method: 'DELETE', headers: clientHeaders, keepalive: true }).catch(() => {});
            }
        };
    };
})();
