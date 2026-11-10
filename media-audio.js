// Optional audio extraction for browsers that cannot select embedded MKV/MP4
// tracks. Sources and decoded chunks live only in memory; never log their URLs.
const http = require('http');
const https = require('https');
const dns = require('dns').promises;
const net = require('net');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const SEGMENT_SECONDS = 20;
const SESSION_TTL = 20 * 60 * 1000;
const MAX_READ_BYTES = 64 * 1024 * 1024;
const FORMATS = 'matroska,webm,mov,mp4,m4a,3gp,3g2,mj2,ogg,mpegts,avi';

function publicAddress(ip) {
    if (net.isIPv4(ip)) {
        const [a, b, c] = ip.split('.').map(Number);
        return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
            (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || b === 2)) ||
            (a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)) ||
            (a === 203 && b === 0 && c === 113));
    }
    // Global unicast only, excluding transition/documentation ranges.
    return net.isIPv6(ip) && /^[23]/i.test(ip) && !/^2002:|^2001:(?:0:|db8:)/i.test(ip);
}

function sourceUrl(raw) {
    if (typeof raw !== 'string' || raw.length > 4096) throw new Error('Invalid video URL.');
    const url = new URL(raw);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid video URL.');
    return url;
}

async function openPublic(raw, range, signal, redirects = 0) {
    const url = sourceUrl(raw);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await dns.lookup(host, { all: true });
    if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw new Error('Private sources are not supported.');
    const address = addresses.find(a => a.family === 4) || addresses[0];
    const response = await new Promise((resolve, reject) => {
        const request = (url.protocol === 'https:' ? https : http).get(url, {
            agent: false, signal,
            headers: { ...(range ? { Range: range } : {}), 'User-Agent': 'Reddate/2.0', 'Accept-Encoding': 'identity' },
            // Pin the validated address. DNS must not be resolved again at connect.
            lookup: (_host, options, cb) => options.all ? cb(null, [address]) : cb(null, address.address, address.family)
        }, resolve);
        request.setTimeout(15000, () => request.destroy(new Error('Source timed out.')));
        request.on('error', reject);
    });
    if (response.statusCode >= 300 && response.statusCode < 400) {
        response.destroy();
        if (redirects >= 4 || !response.headers.location) throw new Error('Too many source redirects.');
        return openPublic(new URL(response.headers.location, url).href, range, signal, redirects + 1);
    }
    if (![200, 206].includes(response.statusCode)) { response.destroy(); throw new Error('Source is unavailable.'); }
    response.resolvedUrl = url.href;
    return response;
}

function registerMediaAudio(app, options = {}) {
    const ffmpeg = options.ffmpeg || process.env.FFMPEG_PATH || 'ffmpeg';
    const ffprobe = options.ffprobe || process.env.FFPROBE_PATH || 'ffprobe';
    const enabled = process.env.AUDIO_EXTRACTION !== 'off' && [ffmpeg, ffprobe].every(command =>
        spawnSync(command, ['-version'], { windowsHide: true, stdio: 'ignore', timeout: 5000 }).status === 0);
    const sessions = new Map(), jobs = new Map(), active = new Map(), rates = new Map(), resolvedSources = new Map(), queue = [];
    let gateway = null, gatewayReady = null, totalActive = 0;
    const openSource = options.openSource || openPublic;

    // FFmpeg can read only this loopback gateway, not a user-controlled URL.
    // Each command gets a private capability and a bounded source byte budget.
    function ensureGateway() {
        if (gatewayReady) return gatewayReady;
        gateway = http.createServer(async (req, res) => {
            const job = jobs.get(req.url.slice(1));
            if (!job || !['GET', 'HEAD'].includes(req.method)) { res.writeHead(404).end(); return; }
            const range = req.headers.range;
            if (range && !/^bytes=\d+-\d*$/.test(range)) { res.writeHead(400).end(); return; }
            const controller = new AbortController();
            const abort = () => controller.abort();
            job.signal.addEventListener('abort', abort, { once: true });
            res.on('close', abort);
            let upstream;
            try {
                if (job.signal.aborted) throw new Error('Cancelled');
                const cached = resolvedSources.get(job.url);
                const target = cached && cached.expires > Date.now() ? cached.url : job.url;
                try { upstream = await openSource(target, range, controller.signal); }
                catch (error) {
                    if (target === job.url || controller.signal.aborted) throw error;
                    resolvedSources.delete(job.url);
                    upstream = await openSource(job.url, range, controller.signal);
                }
                // Reuse expiring download redirects across range reads and chunks.
                // The final host is still validated and DNS-pinned on every request.
                if (upstream.resolvedUrl) {
                    if (!resolvedSources.has(job.url) && resolvedSources.size >= 128) resolvedSources.delete(resolvedSources.keys().next().value);
                    resolvedSources.set(job.url, { url: upstream.resolvedUrl, expires: Date.now() + 5 * 60000 });
                }
                const headers = {};
                for (const name of ['content-length', 'content-range', 'content-type', 'accept-ranges']) {
                    if (upstream.headers[name]) headers[name] = upstream.headers[name];
                }
                res.writeHead(upstream.statusCode, headers);
                if (req.method === 'HEAD') { upstream.destroy(); res.end(); return; }
                upstream.on('data', chunk => {
                    job.bytes += chunk.length;
                    if (job.bytes > MAX_READ_BYTES) { upstream.destroy(); res.destroy(); controller.abort(); }
                });
                upstream.on('error', () => res.destroy());
                upstream.pipe(res);
                await new Promise(resolve => { res.once('close', resolve); res.once('finish', resolve); });
            } catch (_) {
                if (!res.headersSent) res.writeHead(502);
                res.end();
            } finally {
                if (upstream) upstream.destroy();
                job.signal.removeEventListener('abort', abort);
            }
        });
        gatewayReady = new Promise((resolve, reject) => {
            gateway.once('error', reject);
            gateway.listen(0, '127.0.0.1', () => { gateway.unref(); resolve(gateway.address().port); });
        });
        return gatewayReady;
    }

    function drainQueue() {
        for (let i = 0; i < queue.length && totalActive < 4;) {
            const task = queue[i];
            if ((active.get(task.owner) || 0) >= 2) { i++; continue; }
            queue.splice(i, 1);
            task.signal.removeEventListener('abort', task.abort);
            clearTimeout(task.timeout);
            totalActive++;
            active.set(task.owner, (active.get(task.owner) || 0) + 1);
            task.resolve();
        }
    }
    function acquire(owner, signal) {
        return new Promise((resolve, reject) => {
            if (signal.aborted) { reject(new Error('Cancelled')); return; }
            if (queue.length >= 16 || queue.filter(t => t.owner === owner).length >= 4) {
                reject(new Error('Audio is busy. Try again shortly.')); return;
            }
            const task = { owner, signal, resolve };
            const cancel = message => {
                const index = queue.indexOf(task);
                if (index >= 0) queue.splice(index, 1);
                clearTimeout(task.timeout);
                signal.removeEventListener('abort', task.abort);
                reject(new Error(message));
            };
            task.abort = () => cancel('Cancelled');
            task.timeout = setTimeout(() => cancel('Audio is busy. Try again shortly.'), 45000);
            signal.addEventListener('abort', task.abort, { once: true });
            queue.push(task);
            drainQueue();
        });
    }
    async function run(command, args, url, owner, signal, maxOutput) {
        await acquire(owner, signal);
        const id = crypto.randomBytes(24).toString('hex');
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal.addEventListener('abort', abort, { once: true });
        try {
            if (signal.aborted) throw new Error('Cancelled');
            const port = await ensureGateway();
            jobs.set(id, { url, signal: controller.signal, controller, bytes: 0 });
            return await new Promise((resolve, reject) => {
                const commandArgs = args(`http://127.0.0.1:${port}/${id}`);
                const child = spawn(command, commandArgs, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
                const chunks = [];
                let bytes = 0, failure = null;
                const stop = message => { failure = new Error(message); child.kill(); };
                const cancel = () => stop('Cancelled');
                controller.signal.addEventListener('abort', cancel, { once: true });
                const timeout = setTimeout(() => stop('Audio source timed out. Try another stream.'), 45000);
                child.stdout.on('data', chunk => {
                    bytes += chunk.length;
                    if (bytes > maxOutput) stop('Audio source exceeded the limit.');
                    else chunks.push(chunk);
                });
                child.on('error', () => { failure = new Error('Audio decoder is unavailable.'); });
                child.on('close', code => {
                    clearTimeout(timeout);
                    controller.signal.removeEventListener('abort', cancel);
                    if (failure || code !== 0) reject(failure || new Error('Could not read this audio track.'));
                    else resolve(Buffer.concat(chunks));
                });
                if (controller.signal.aborted) cancel();
            });
        } finally {
            controller.abort();
            signal.removeEventListener('abort', abort);
            jobs.delete(id);
            totalActive--;
            const count = (active.get(owner) || 1) - 1;
            if (count) active.set(owner, count); else active.delete(owner);
            drainQueue();
        }
    }

    function clientSignal(res) {
        const controller = new AbortController();
        res.on('close', () => { if (!res.writableFinished) controller.abort(); });
        return controller.signal;
    }
    function unavailable(res) {
        return res.status(503).json({ error: 'This server needs FFmpeg and ffprobe to switch embedded audio tracks.' });
    }
    const sweep = setInterval(() => {
        const now = Date.now();
        for (const [id, s] of sessions) if (s.expires < now) sessions.delete(id);
        for (const [id, r] of rates) if (r.until < now) rates.delete(id);
        for (const [id, source] of resolvedSources) if (source.expires < now) resolvedSources.delete(id);
    }, 60000);
    sweep.unref();

    app.post('/api/audio/tracks', require('express').json({ limit: '8kb' }), async (req, res) => {
        res.set('Cache-Control', 'no-store');
        if (!enabled) return unavailable(res);
        const owner = req.ip, now = Date.now();
        let rate = rates.get(owner);
        if (!rate && rates.size >= 10000) return res.status(429).json({ error: 'Too many audio lookups. Try again shortly.' });
        if (!rate || rate.until < now) { rate = { count: 0, until: now + 60000 }; rates.set(owner, rate); }
        if (++rate.count > 12 || rates.size > 10000) return res.status(429).json({ error: 'Too many audio lookups. Try again shortly.' });
        const signal = clientSignal(res);
        try {
            const url = sourceUrl(req.body && req.body.url).href;
            const own = [...sessions.values()].filter(s => s.owner === owner);
            if (sessions.size >= 64 || own.length >= 6) throw new Error('Too many active videos. Close another player first.');
            const data = await run(ffprobe, input => [
                '-v', 'error', '-protocol_whitelist', 'http,tcp', '-format_whitelist', FORMATS,
                '-probesize', '2097152', '-analyzeduration', '3000000',
                '-show_entries', 'stream=index,codec_type,codec_name:stream_tags=language,title:stream_disposition=default:format=duration',
                '-of', 'json', input
            ], url, owner, signal, 256 * 1024);
            const metadata = JSON.parse(data.toString('utf8'));
            const tracks = (metadata.streams || []).filter(s => s.codec_type === 'audio').slice(0, 32).map(s => ({
                index: s.index, language: String(s.tags?.language || '').slice(0, 16),
                name: String(s.tags?.title || '').slice(0, 100), codec: s.codec_name,
                isDefault: !!s.disposition?.default
            }));
            if (!tracks.length) throw new Error('This source has no readable audio tracks.');
            if (!tracks.some(t => t.isDefault)) tracks[0].isDefault = true;
            if (signal.aborted) return;
            const token = crypto.randomBytes(24).toString('hex');
            sessions.set(token, { url, tracks, owner, expires: Date.now() + SESSION_TTL });
            res.json({ token, tracks, segmentSeconds: SEGMENT_SECONDS, duration: Number(metadata.format?.duration) || null });
        } catch (e) {
            if (!signal.aborted) res.status(502).json({ error: e.message.startsWith('Invalid') ? 'Invalid video URL.' : e.message });
        }
    });

    app.get('/api/audio/:token/:track/:start', async (req, res) => {
        res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        const session = sessions.get(req.params.token);
        if (!session || session.owner !== req.ip || session.expires < Date.now()) return res.status(404).end();
        const track = Number(req.params.track), start = Number(req.params.start);
        if (!session.tracks.some(t => t.index === track) || !Number.isInteger(start) || start < 0 || start > 86400 || start % SEGMENT_SECONDS) return res.status(400).end();
        session.expires = Date.now() + SESSION_TTL;
        const signal = clientSignal(res);
        try {
            // PCM has no encoder priming delay, giving sample-accurate chunk
            // boundaries. Only 20 seconds of stereo audio is held in memory.
            const data = await run(ffmpeg, input => [
                '-v', 'error', '-nostdin', '-protocol_whitelist', 'http,tcp', '-format_whitelist', FORMATS,
                '-probesize', '2097152', '-analyzeduration', '1000000',
                '-ss', String(start), '-i', input, '-t', String(SEGMENT_SECONDS), '-map', `0:${track}`,
                '-vn', '-sn', '-dn', '-ac', '2', '-ar', '48000', '-af', `asetpts=PTS-STARTPTS,apad=whole_dur=${SEGMENT_SECONDS}`,
                '-c:a', 'pcm_s16le', '-f', 'wav', 'pipe:1'
            ], session.url, req.ip, signal, 4 * 1024 * 1024);
            if (!signal.aborted) res.type('audio/wav').send(data);
        } catch (e) { if (!signal.aborted) res.status(502).json({ error: e.message }); }
    });

    app.delete('/api/audio/:token', (req, res) => {
        if (sessions.get(req.params.token)?.owner === req.ip) sessions.delete(req.params.token);
        res.status(204).end();
    });
    return { enabled, close() {
        clearInterval(sweep);
        for (const task of [...queue]) task.abort();
        for (const job of jobs.values()) job.controller.abort();
        if (gateway) gateway.close();
        sessions.clear();
        resolvedSources.clear();
    } };
}

module.exports = { registerMediaAudio, publicAddress, sourceUrl, openPublic };
