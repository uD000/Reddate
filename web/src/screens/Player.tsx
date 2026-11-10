import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useBackClose } from '../back';
import Hls from 'hls.js';
import QRCode from 'qrcode';
import { engine, Json, PlayerHost } from '../engine';
import { useApp } from '../App';
import { clock } from '../util';
import { Cue, parseSubs, cueAt } from '../subs';
import { IBack, IChat, ISub, IAudio, IShare, IUsers, IPlay, IPause, IFull, IX, IList, IVolume, IMute, ISwap } from '../icons';
import { Picker } from './Picker';
import { SubsPanel, loadLook, saveLook, lookVars, SubLook } from './SubsPanel';
import { InviteProfiles } from './InviteProfiles';
import { RoomCode } from './RoomCode';
import { YtVideo } from '../yt';
import { chat as chatStore, useChat, ChatMsg } from '../chat';
import { deviceName } from '../engine';
import { audioLanguage, audioLabel } from '../audio';

export interface OpenInfo { kind?: string; videoId?: string; url: string; sid: string; art: string; title: string; startMs: number; playWhenReady: boolean; subPref: string; chatOn: boolean }
// iPhone and iPad ignore a page's volume slider (the hardware buttons own it), so there's no slider there.
const IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
type Panel = '' | 'chat' | 'invite' | 'people' | 'subs' | 'audio' | 'eps' | 'speed';

const MAX_SUB_BYTES = 3_000_000;

const phone = () => window.matchMedia('(max-width: 760px)').matches;

export function Player({ open, onClose }: { open: OpenInfo; onClose: (immediate?: boolean) => void }) {
    const { toast } = useApp();
    const vref = useRef<any>(null);
    const ytWrap = useRef<HTMLDivElement>(null);
    const isYt = open.kind === 'yt' && !!open.videoId;
    const [ytTitle, setYtTitle] = useState('');
    const title = open.title || ytTitle || (isYt ? 'YouTube video' : 'Video');
    const leftRef = useRef(false);
    const pausedByHide = useRef(false);
    const autoInvite = useRef(false);
    const hls = useRef<Hls | null>(null);
    const [status, setStatus] = useState('Loading stream…');
    const [failed, setFailed] = useState('');
    const failedRef = useRef('');
    failedRef.current = failed;
    const [needTap, setNeedTap] = useState(false);
    const [playing, setPlaying] = useState(false);
    const [buffering, setBuffering] = useState(true);
    const [pos, setPos] = useState(0);
    const [dur, setDur] = useState(0);
    const [bufEnd, setBufEnd] = useState(0);
    const [ui, setUi] = useState(true);
    const [panel, setPanel] = useState<Panel>('');
    const [info, setInfo] = useState<Json>({});
    const chat = useChat();
    const [unread, setUnread] = useState(0);
    const [pops, setPops] = useState<{ id: number; who: string; text: string }[]>([]);
    const [typing, setTyping] = useState<string[]>([]);
    const [cues, setCues] = useState<Cue[]>([]);
    const [subLabel, setSubLabel] = useState('');
    const [subUrl, setSubUrl] = useState('');
    const [look, setLook] = useState<SubLook>(loadLook);
    const [subDelay, setSubDelay] = useState(0);
    const subSelection = useRef(0);
    const subtitlePersonal = useRef(false);
    const sharedSubRevision = useRef('');
    const selectedSub = useRef<Json>({ vtt: null, key: '', lang: 'off', label: '', offset: 0 });
    useEffect(() => () => { subSelection.current++; }, [open.sid]);
    const [cueText, setCueText] = useState('');
    const [audioTracks, setAudioTracks] = useState<{ id: number; label: string; lang: string; on: boolean }[]>([]);
    const audioFallback = useRef<any>(null);
    const audioGate = useRef<any>(null);
    const audioChosen = useRef(false);
    const audioPersonal = useRef(false);
    const roomAudioRef = useRef<Json | null>(null);
    roomAudioRef.current = info.roomAudio || null;
    const settingsOwnerRef = useRef(false);
    settingsOwnerRef.current = !!info.isSettingsOwner;
    const reportedAudio = useRef('');
    const audioSelection = useRef(0);
    const audioRefresh = useRef<() => void>(() => {});
    const [audioStatus, setAudioStatus] = useState('');
    const [audioPending, setAudioPending] = useState(false);
    const [rate, setRate] = useState(1);
    const [fs, setFs] = useState(false);
    const [ask, setAsk] = useState<null | { title: string; body: string; yes: string; no: string; onYes: () => void; onNo?: () => void }>(null);
    const [scrub, setScrub] = useState<number | null>(null);
    const [qr, setQr] = useState('');
    const [devices, setDevices] = useState<Json[] | null>(null);
    const [invited, setInvited] = useState<Record<string, boolean>>({});
    const [volume, setVolume] = useState<number>(() => { try { const v = parseFloat(localStorage.getItem('rd-vol') || ''); return isFinite(v) ? Math.min(1, Math.max(0, v)) : 1; } catch { return 1; } });
    const [muted, setMuted] = useState(false);
    const [noAudio, setNoAudio] = useState(false);
    // 'video' opens the catalog (another movie or show); 'streams' opens what's playing at its stream list.
    const [picker, setPicker] = useState<false | 'video' | 'streams'>(false);
    const [ignoreBehindUntil, setIgnoreBehindUntil] = useState(0);

    const expectPlay = useRef<boolean | null>(null);
    const expectSeek = useRef<number | null>(null);
    const readySent = useRef(false);
    async function selectAudio(id: number, lang: string, remember = true) {
        if (remember) audioPersonal.current = true;
        const selection = ++audioSelection.current;
        const video = vref.current;
        const fallback = audioFallback.current;
        audioChosen.current = true;
        setAudioStatus('Switching audio…'); setAudioPending(true);
        try {
            const h = hls.current;
            if (h && h.audioTracks.length > 1) h.audioTrack = id;
            else if (video?.audioTracks) {
                for (let i = 0; i < video.audioTracks.length; i++) video.audioTracks[i].enabled = i === id;
            } else if (fallback) await fallback.select(id);
            if (vref.current !== video || selection !== audioSelection.current) return;
            if (remember && lang) { try { localStorage.setItem('reddate-audio-lang', lang); } catch { /* no storage */ } }
            audioRefresh.current();
            setAudioStatus('');
        } catch {
            if (vref.current === video && selection === audioSelection.current) setAudioStatus('Could not switch audio. Try another language or stream.');
        } finally { if (vref.current === video && selection === audioSelection.current) setAudioPending(false); }
    }
    const stage = useRef<HTMLDivElement>(null);
    const hideT = useRef<number>();
    const popId = useRef(1);
    const panelRef = useRef<Panel>('');
    panelRef.current = panel;
    // Once the room is live (a party), its chat is the Lounge: the same page as /lounge/CODE, kept running beside the video.
    const loungeUrl = info.room && info.live ? `/lounge/${encodeURIComponent(String(info.room))}?frame=1&dev=${encodeURIComponent(deviceName())}` : '';
    const loungeRef = useRef(false);
    loungeRef.current = !!loungeUrl;
    const draft = useRef('');
    const typingSent = useRef(0);
    const delayRef = useRef(0); delayRef.current = subDelay;
    const cuesRef = useRef<Cue[]>([]); cuesRef.current = cues;

    const send = useCallback((ev: Json) => engine.send({ sid: open.sid, ...ev }), [open.sid]);
    const pings = useRef(0);

    // ---- bring the picture up ----
    useEffect(() => {
        const v = isYt ? (vref.current = new YtVideo(ytWrap.current!, open.videoId!)) : vref.current!;
        let dead = false;
        audioChosen.current = false;
        audioPersonal.current = false; subtitlePersonal.current = false; reportedAudio.current = '';
        audioSelection.current++;
        setAudioStatus(''); setAudioPending(false); setAudioTracks([]);
        v.playbackRate = 1;
        const src = open.url;
        const isHls = !isYt && /\.m3u8($|\?)/i.test(src);
        if (!isYt) { v.preload = 'auto'; v.setAttribute('playsinline', ''); }
        if (isYt) { /* the YouTube player loads itself */ }
        // Native HLS whenever the browser has it (Safari, Chrome 141+): it picks audio the device can decode
        // (AAC next to Dolby) and needs no CORS. Requiring v.audioTracks too sent Chrome to hls.js: silent Dolby.
        else if (isHls && Hls.isSupported() && !v.canPlayType('application/vnd.apple.mpegurl')) {
            const h = new Hls({ maxBufferLength: 40, enableWorker: true });
            hls.current = h;
            h.on(Hls.Events.ERROR, (_e, d) => { if (d.fatal) fail(d.details || 'HLS'); });
            h.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => refreshAudio());
            h.on(Hls.Events.AUDIO_TRACK_SWITCHED, () => refreshAudio());
            h.loadSource(src);
            h.attachMedia(v);
        } else {
            v.src = src;
        }
        function fail(code: string) {
            if (dead) return;
            setFailed(isYt ? 'YouTube won’t play this video here (the owner may have turned embedding off). Go back and try another.' : 'This browser can’t play that stream. Go back and pick another, or open it on the TV app (it plays MKV, HEVC and surround audio).');
            send({ type: 'error', code, message: code });
        }
        const ready = () => {
            if (readySent.current) return;
            readySent.current = true;
            setStatus('');
            send({ type: 'ready', durationMs: Math.round((v.duration || 0) * 1000) });
            if (open.playWhenReady) { expectPlay.current = true; v.play().catch(() => setNeedTap(true)); }
        };
        const onMeta = () => {
            setDur(v.duration || 0);
            if (open.startMs > 0 && v.currentTime < 1) { expectSeek.current = open.startMs; v.currentTime = open.startMs / 1000; }
            refreshAudio();
            if (audioFallback.current) audioFallback.current.load();
            // Phones only load the first bytes until someone presses play, and never say "can play":
            // the file's details arriving is enough to be ready (the play press then starts it).
            ready();
        };
        const onCanPlay = () => { setBuffering(!!audioGate.current?.buffering); ready(); };
        // A link that never answers counts as failed, so the next similar stream can be tried.
        const slowT = window.setTimeout(() => { if (!readySent.current) fail('TIMEOUT'); }, 25000);
        const onPlay = () => {
            setPlaying(true);
            const echo = expectPlay.current === true; if (echo) expectPlay.current = null;
            send({ type: 'state', playing: true, posMs: Math.round(v.currentTime * 1000), echo });
        };
        const onPause = () => {
            setPlaying(false);
            if (v.ended) return;
            // The browser pausing a tab you're not looking at (Chrome does, for video it plays without sound) is
            // not you pausing: the room carries on, and this screen catches up when you come back.
            if (document.hidden && expectPlay.current !== false) { pausedByHide.current = true; return; }
            const echo = expectPlay.current === false; if (echo) expectPlay.current = null;
            send({ type: 'state', playing: false, posMs: Math.round(v.currentTime * 1000), echo });
        };
        const onSeeked = () => {
            const want = expectSeek.current;
            const echo = want !== null && Math.abs(v.currentTime * 1000 - want) < 3000;
            if (echo) expectSeek.current = null;
            send({ type: 'seek', posMs: Math.round(v.currentTime * 1000), echo });
        };
        const onWaiting = () => setBuffering(true);
        const onPlaying = () => { setBuffering(!!audioGate.current?.buffering); setNeedTap(false); };
        const onEnded = () => { setPlaying(false); send({ type: 'ended', auto: false, posMs: Math.round(v.currentTime * 1000) }); };
        const onErr = () => { if (!hls.current) fail((isYt ? 'YT_ERR_' : 'MEDIA_ERR_') + (v.error ? v.error.code : '')); };
        const onVol = () => { /* nothing to tell the room */ };
        v.addEventListener('loadedmetadata', onMeta);
        v.addEventListener('canplay', onCanPlay);
        if (!isYt) {
            audioGate.current = (window as any).createPlaybackGate(v, {
                onPlayback: (on: boolean) => on ? onPlay() : onPause(),
                onBuffering: (on: boolean) => setBuffering(on),
                onPlayError: () => setNeedTap(true)
            });
            if (!(v as any).audioTracks && !isHls) audioFallback.current = (window as any).createAudioFallback(v, open.url, refreshAudio);
        } else { v.addEventListener('play', onPlay); v.addEventListener('pause', onPause); }
        v.addEventListener('seeked', onSeeked);
        v.addEventListener('waiting', onWaiting);
        v.addEventListener('playing', onPlaying);
        v.addEventListener('ended', onEnded);
        v.addEventListener('error', onErr);
        v.addEventListener('volumechange', onVol);
        const tickT = window.setInterval(() => {
            setPos(v.currentTime); setDur(v.duration || 0);
            try { setBufEnd(v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0); } catch { /* ignore */ }
            setCueText(cueAt(cuesRef.current, v.currentTime - delayRef.current));
            if (readySent.current && ++pings.current % 2 === 0) send({ type: 'tick', posMs: Math.round(v.currentTime * 1000), playing: !v.paused && !v.ended, buffering: !!audioGate.current?.buffering || v.seeking || v.readyState < 3 && !v.paused });
        }, 500);
        function refreshAudio() {
            if (dead) return;
            const h = hls.current;
            const fallback = audioFallback.current;
            let tracks: { id: number; label: string; lang: string; on: boolean }[] = [];
            if (h && h.audioTracks && h.audioTracks.length > 1) {
                tracks = h.audioTracks.map((t, i) => ({ id: i, label: audioLabel(t.lang || '', t.name, i), lang: audioLanguage(t.lang || ''), on: h.audioTrack === i }));
            } else {
                const at = (v as any).audioTracks;
                if (at?.length) tracks = Array.from({ length: at.length }, (_, i) => ({ id: i, label: audioLabel(at[i].language, at[i].label, i), lang: audioLanguage(at[i].language), on: !!at[i].enabled }));
                else if (fallback?.tracks.length) tracks = fallback.tracks.map((t: any, i: number) => ({ id: t.index, label: audioLabel(t.language, t.name, i), lang: audioLanguage(t.language), on: fallback.selected === t.index }));
            }
            setAudioTracks(tracks);
            setAudioStatus(fallback?.status || ''); setAudioPending(!!fallback?.pending);
            const shared = roomAudioRef.current?.state;
            if (shared && !audioPersonal.current && (!fallback || fallback.canAutoSelect)) {
                const lang = audioLanguage(shared.language || '');
                const match = tracks.find(t => t.lang === lang && t.label === shared.label) || (lang && tracks.find(t => t.lang === lang)) || (!lang && tracks[shared.index]);
                if (match) { audioChosen.current = true; if (!match.on && !fallback?.pending) selectAudio(match.id, match.lang, false); }
            }
            let pref = ''; try { pref = audioLanguage(localStorage.getItem('reddate-audio-lang') || ''); } catch { /* no storage */ }
            if (!shared && !audioChosen.current && pref && (!fallback || fallback.canAutoSelect)) {
                const match = tracks.find(t => t.lang === pref) || tracks.find(t => t.lang && t.lang.split('-')[0] === pref.split('-')[0]);
                if (match) { audioChosen.current = true; if (!match.on) selectAudio(match.id, match.lang, false); }
            }
            if (settingsOwnerRef.current && !fallback?.pending) {
                const index = tracks.findIndex(t => t.on);
                if (index >= 0) {
                    const state = { language: tracks[index].lang, label: tracks[index].label, index };
                    const signature = JSON.stringify(state);
                    if (signature !== reportedAudio.current) { reportedAudio.current = signature; send({ type: 'audio', state }); }
                }
            }
        }
        audioRefresh.current = refreshAudio;
        const nativeTracks = (v as any).audioTracks;
        if (nativeTracks?.addEventListener) ['addtrack', 'removetrack', 'change'].forEach(event => nativeTracks.addEventListener(event, refreshAudio));
        return () => {
            dead = true;
            audioGate.current?.destroy(); audioGate.current = null;
            audioFallback.current?.destroy(); audioFallback.current = null;
            if (nativeTracks?.removeEventListener) ['addtrack', 'removetrack', 'change'].forEach(event => nativeTracks.removeEventListener(event, refreshAudio));
            window.clearInterval(tickT);
            window.clearTimeout(slowT);
            v.removeEventListener('loadedmetadata', onMeta); v.removeEventListener('canplay', onCanPlay);
            v.removeEventListener('play', onPlay); v.removeEventListener('pause', onPause); v.removeEventListener('seeked', onSeeked);
            v.removeEventListener('waiting', onWaiting); v.removeEventListener('playing', onPlaying); v.removeEventListener('ended', onEnded);
            v.removeEventListener('error', onErr); v.removeEventListener('volumechange', onVol);
            if (hls.current) { hls.current.destroy(); hls.current = null; }
            if (isYt) { (v as YtVideo).destroy(); vref.current = null; return; }
            v.removeAttribute('src'); v.load();
        };
    }, [open.sid]);

    // Gone from the screen without choosing "leave" (the browser's back button, a swipe back…): the
    // Closing the player (a new video, navigating away) only releases the picture. Only the Leave button leaves
    // the room: a close used to leave it when the viewer didn't know yet who else was there, which ended parties.
    useEffect(() => () => {
        if (leftRef.current) return;
        leftRef.current = true;
        engine.send({ sid: open.sid, type: 'closed' });
    }, [open.sid]);

    // Back in view after the browser paused it: rejoin the room where it is now.
    useEffect(() => {
        const on = () => {
            if (document.hidden || !pausedByHide.current) return;
            pausedByHide.current = false;
            send({ type: 'sync-answer', yes: true });
        };
        document.addEventListener('visibilitychange', on);
        return () => document.removeEventListener('visibilitychange', on);
    }, [send]);

    // A room exists on the server only once it's shared: opening the invite is what makes it real.
    useEffect(() => { if (panel === 'invite') engine.call('goLive').catch(() => {}); }, [panel]);

    // The invite that opened by itself gets out of the way: once someone has joined, or after 25 s.
    const peopleCount = (info.people || []).length;
    useEffect(() => {
        if (!autoInvite.current || panel !== 'invite') { autoInvite.current = false; return; }
        if (peopleCount > 1) { autoInvite.current = false; setPanel(''); return; }
        const t = window.setTimeout(() => { if (autoInvite.current) { autoInvite.current = false; setPanel(p => (p === 'invite' ? '' : p)); } }, 25000);
        return () => window.clearTimeout(t);
    }, [panel, peopleCount]);

    // YouTube links arrive without a name: ask YouTube for it.
    useEffect(() => {
        if (!isYt || open.title) return;
        let dead = false;
        fetch('https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + open.videoId))
            .then(r => (r.ok ? r.json() : null)).then(j => { if (!dead && j && j.title) setYtTitle(String(j.title)); }).catch(() => {});
        return () => { dead = true; };
    }, [open.sid]);

    // ---- what the room tells us ----
    useEffect(() => {
        const host: PlayerHost = {
            open: () => {},
            command: (c: Json) => {
                const v = vref.current;
                if (!v) return;
                switch (c.cmd) {
                    case 'play': expectPlay.current = v.paused ? true : null; if (audioGate.current) { if (!audioGate.current.play()) expectPlay.current = null; } else v.play().catch(() => setNeedTap(true)); break;
                    case 'pause': expectPlay.current = v.paused ? null : false; if (audioGate.current) { if (!audioGate.current.pause()) expectPlay.current = null; } else v.pause(); break;
                    case 'seek': expectSeek.current = c.ms; window.setTimeout(() => { if (expectSeek.current === c.ms) expectSeek.current = null; }, 3000); v.currentTime = c.ms / 1000; break;
                    case 'rate': v.playbackRate = Math.min(1.25, Math.max(0.8, c.r || 1)); break;
                    case 'stop': onClose(); break;
                    case 'info': setInfo(c.info || {}); break;
                    case 'toast': toast(String(c.text || '')); break;
                    case 'presence': addPop('', String(c.text || '')); break;
                    case 'chat': break; // the chat store has it (see ../chat)
                    case 'typing':
                        setTyping(l => (c.on ? (l.includes(c.user) ? l : [...l, c.user]) : l.filter(x => x !== c.user)));
                        if (c.on) window.setTimeout(() => setTyping(l => l.filter(x => x !== c.user)), 6000);
                        break;
                    case 'episode-failed': toast(String(c.text || 'Couldn’t start that episode.')); break;
                    case 'ask-sync':
                        setAsk({ title: `Sync with ${c.host}?`, body: `${c.host} is at ${c.at}.`, yes: 'Sync', no: 'Keep watching', onYes: () => send({ type: 'sync-answer', yes: true }), onNo: () => send({ type: 'sync-answer', yes: false }) });
                        break;
                    case 'ask-join':
                        setAsk({ title: `${c.host} switched to ${c.title}`, body: 'Join them?', yes: 'Join', no: 'Stay here', onYes: () => send({ type: 'join-answer', yes: true }), onNo: () => send({ type: 'join-answer', yes: false }) });
                        break;
                }
            }
        };
        engine.attachPlayer(host);
        // A party started from the title page opens the invite straight away, and keeps it open.
        // Only for the one who just started it (a fresh flag), never for someone joining.
        let inv = false;
        try { const t = Number(sessionStorage.getItem('rd-invite-at') || 0); inv = sessionStorage.getItem('rd-invite') === '1' && Date.now() - t < 30000; sessionStorage.removeItem('rd-invite'); sessionStorage.removeItem('rd-invite-at'); } catch { /* fine */ }
        if (inv) { setPanel('invite'); autoInvite.current = true; }
        const off = engine.on(ev => { if (ev.type === 'play-failed') { /* the engine picks the next stream itself when it can */ } });
        return () => { engine.detachPlayer(host); off(); };
    }, [open.sid]);

    // New lines from others: a pop-up and the unread count, unless Chat is open.
    useEffect(() => chatStore.on(() => {
        const l = chatStore.list(); const m = l[l.length - 1];
        if (!m || m.me || Date.now() - m.at > 10000 || loungeRef.current) return; // the Lounge reports its own lines
        if (panelRef.current !== 'chat') { setUnread(n => n + 1); addPop(m.who, m.text); }
    }), []);
    useEffect(() => {
        const onMsg = (e: MessageEvent) => {
            const d = e.data;
            if (e.origin !== location.origin || !d || d.rd !== 'lounge' || d.ev !== 'message') return;
            if (panelRef.current !== 'chat') { setUnread(n => n + 1); addPop(String(d.who || 'Someone'), String(d.text || '')); }
        };
        window.addEventListener('message', onMsg);
        return () => window.removeEventListener('message', onMsg);
    }, []);

    function addPop(who: string, text: string) {
        const id = popId.current++;
        setPops(l => [...l.slice(-3), { id, who, text }]);
        window.setTimeout(() => setPops(l => l.filter(p => p.id !== id)), 5500);
    }

    useEffect(() => { const v = vref.current; if (v) { v.volume = volume; if (audioFallback.current) audioFallback.current.setMuted(muted); else v.muted = muted; } try { localStorage.setItem('rd-vol', String(volume)); } catch { /* fine */ } }, [volume, muted, open.sid]);
    // A stream whose sound the browser can't decode (Dolby Digital+, DTS…) plays picture only: say so.
    useEffect(() => {
        if (!playing) return;
        const t = window.setTimeout(() => {
            const v = vref.current as any;
            if (v && !v.paused && v.currentTime > 2 && typeof v.webkitAudioDecodedByteCount === 'number' && v.webkitAudioDecodedByteCount === 0 && !v.muted) setNoAudio(true);
        }, 5000);
        return () => window.clearTimeout(t);
    }, [playing, open.sid]);

    // ---- controls auto-hide ----
    const poke = useCallback(() => {
        setUi(true);
        window.clearTimeout(hideT.current);
        hideT.current = window.setTimeout(() => { if (!failedRef.current && (!panelRef.current || phone())) setUi(false); }, 3500);
    }, []);
    useEffect(() => { poke(); return () => window.clearTimeout(hideT.current); }, [poke]);
    // On a phone the panel sits under a small picture: the controls fade as usual so the picture shows.
    useEffect(() => { if (panel && !phone()) setUi(true); else poke(); }, [panel, poke]);

    useBackClose(!!panel, () => setPanel(''));
    useBackClose(!!picker, () => setPicker(false));
    // The addon title that's playing: a movie, or a show at its episode. A bare link or YouTube has none.
    const here = !isYt && info.current ? {
        id: String(info.show || info.current), type: String(info.ctype || (info.show ? 'series' : 'movie')),
        name: String(info.showName || title), episodeId: info.show ? String(info.current) : ''
    } : null;

    // ---- keyboard ----
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const t = e.target as HTMLElement;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
            const v = vref.current; if (!v) return;
            poke();
            if (e.key === ' ' || e.key === 'k') { e.preventDefault(); toggle(); }
            else if (e.key === 'ArrowRight') seekBy(10);
            else if (e.key === 'ArrowLeft') seekBy(-10);
            else if (e.key === 'f') toggleFs();
            else if (e.key === 'c') setPanel(p => (p === 'chat' ? '' : 'chat'));
            else if (e.key === 'm') setMuted(m => !m);
            else if (e.key === 'Escape') { if (panelRef.current) setPanel(''); }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    });
    useEffect(() => {
        const on = () => { const on = !!document.fullscreenElement || !!(document as any).webkitFullscreenElement; setFs(on); if (!on) { try { (screen.orientation as any)?.unlock?.(); } catch { /* fine */ } } };
        document.addEventListener('fullscreenchange', on);
        document.addEventListener('webkitfullscreenchange', on);
        return () => { document.removeEventListener('fullscreenchange', on); document.removeEventListener('webkitfullscreenchange', on); };
    }, []);

    const iAmHostNow = () => !!info.isHost || !info.hostOnly;
    const canCtl = () => iAmHostNow() || !!info.guestsCanPause;
    function locked() { toast('Only hosts can pause, play or skip in this party.'); }
    function toggle() { const v = vref.current!; if (!canCtl()) return locked(); if (v.paused) v.play().catch(() => setNeedTap(true)); else v.pause(); }
    function seekBy(d: number) { if (!canCtl()) return locked(); const v = vref.current!; expectSeek.current = null; v.currentTime = Math.max(0, Math.min((v.duration || 1e9) - 0.5, v.currentTime + d)); }
    function toggleFs() {
        const host = stage.current?.parentElement as any;
        const v = vref.current as any;
        const d = document as any;
        if (document.fullscreenElement || d.webkitFullscreenElement) {
            try { (screen.orientation as any)?.unlock?.(); } catch { /* fine */ }
            (document.exitFullscreen || d.webkitExitFullscreen)?.call(document);
            return;
        }
        const req = host && (host.requestFullscreen || host.webkitRequestFullscreen);
        if (req) {
            // The whole player (controls, subtitles, chat) goes full screen; phones are turned to landscape.
            Promise.resolve(req.call(host)).then(() => { try { (screen.orientation as any)?.lock?.('landscape').catch(() => {}); } catch { /* fine */ } }).catch(() => {});
        } else if (v && v.webkitEnterFullscreen) {
            v.webkitEnterFullscreen(); // iPhone: only the video itself can go full screen, in landscape
        }
    }

    // ---- seek bar ----
    const barRef = useRef<HTMLDivElement>(null);
    function frac(e: React.PointerEvent) { const r = barRef.current!.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); }
    function onDown(e: React.PointerEvent) { if (!canCtl()) return locked(); (e.target as HTMLElement).setPointerCapture(e.pointerId); setScrub(frac(e) * dur); }
    function onMove(e: React.PointerEvent) { if (scrub !== null) setScrub(frac(e) * dur); }
    function onUp(e: React.PointerEvent) {
        if (scrub === null) return;
        const t = frac(e) * dur; setScrub(null);
        const v = vref.current!; expectSeek.current = null; v.currentTime = t;
    }

    // ---- subtitles ----
    useEffect(() => { audioRefresh.current(); }, [info.roomAudio?.mediaId, info.roomAudio?.revision, info.isSettingsOwner]);
    async function useSub(s: Json | null) {
        subtitlePersonal.current = true;
        const selection = ++subSelection.current;
        if (!s) {
            selectedSub.current = { vtt: null, key: '', lang: 'off', label: '', offset: 0 };
            setCues([]); setSubLabel(''); setSubUrl(''); setSubDelay(0);
            send({ type: 'subpref', lang: 'off' }); send({ type: 'subtitle', state: selectedSub.current }); return;
        }
        try {
            const r = await fetch(s.url);
            if (!r.ok) throw new Error('bad');
            const buf = await r.arrayBuffer();
            if (buf.byteLength > MAX_SUB_BYTES) throw new Error('big');
            let text = new TextDecoder('utf-8').decode(buf);
            if (text.includes('�')) text = new TextDecoder('windows-1252').decode(buf);
            if (selection !== subSelection.current) return;
            const c = parseSubs(text);
            if (!c.length) throw new Error('empty');
            setCues(c); setSubLabel(`${s.label || s.lang}${s.name ? ' · ' + s.name : ''}`); setSubUrl(String(s.url || ''));
            setSubDelay(0);
            selectedSub.current = { vtt: text, key: String(s.url || ''), lang: String(s.lang || 'und'), label: `${s.label || s.lang}${s.name ? ' · ' + s.name : ''}`, offset: 0 };
            send({ type: 'subpref', lang: String(s.lang || '') });
            send({ type: 'subtitle', state: selectedSub.current });
        } catch { if (selection === subSelection.current) toast('That subtitle couldn’t be loaded here. Try another.'); }
    }
    function changeSubDelay(delay: number) {
        subtitlePersonal.current = true;
        setSubDelay(delay);
        selectedSub.current = { ...selectedSub.current, offset: delay };
        send({ type: 'subtitle', state: selectedSub.current });
    }
    useEffect(() => {
        const shared = info.roomSubtitle;
        if (!shared?.state) return;
        const revision = `${shared.mediaId}:${shared.revision}`;
        if (revision === sharedSubRevision.current) return;
        sharedSubRevision.current = revision;
        if (subtitlePersonal.current && !info.isSettingsOwner) return;
        if (!shared.own) subSelection.current++;
        const s = shared.state;
        selectedSub.current = s;
        const v = vref.current;
        const h = hls.current;
        const syncEmbedded = () => {
            const lang = s.embeddedLang ? audioLanguage(s.embeddedLang) : '';
            if (h) h.subtitleTrack = lang ? h.subtitleTracks.findIndex(t => audioLanguage(t.lang || '') === lang) : -1;
            for (const t of Array.from(v?.textTracks || []) as TextTrack[]) {
                if (t.kind !== 'subtitles' && t.kind !== 'captions') continue;
                t.mode = lang && audioLanguage(t.language) === lang ? 'showing' : 'disabled';
                if (t.mode === 'showing') for (const cue of Array.from(t.cues || []) as any[]) {
                    if (!cue._base) cue._base = [cue.startTime, cue.endTime];
                    cue.startTime = Math.max(0, cue._base[0] + (Number(s.offset) || 0));
                    cue.endTime = Math.max(0, cue._base[1] + (Number(s.offset) || 0));
                }
            }
        };
        syncEmbedded();
        v?.textTracks?.addEventListener('addtrack', syncEmbedded);
        h?.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, syncEmbedded);
        setCues(s.vtt ? parseSubs(s.vtt) : []); setSubUrl(s.vtt ? String(s.key || '') : s.embeddedLang ? `embedded:${s.embeddedLang}` : '');
        setSubLabel(s.vtt || s.embeddedLang ? String(s.label || s.lang || 'Room subtitle') : ''); setSubDelay(Number(s.offset) || 0);
        return () => {
            v?.textTracks?.removeEventListener('addtrack', syncEmbedded);
            h?.off(Hls.Events.SUBTITLE_TRACKS_UPDATED, syncEmbedded);
        }
    }, [info.roomSubtitle?.mediaId, info.roomSubtitle?.revision]);
    // Pick the remembered language when the list arrives.
    const subsPicked = useRef(false);
    useEffect(() => {
        if (subsPicked.current || info.live || info.roomSubtitle) return;
        const subs: Json[] = info.subs || [];
        const pref: string = info.subPref || open.subPref || '';
        if (!subs.length || !pref || pref === 'off') return;
        const m = subs.find(s => String(s.lang).toLowerCase().startsWith(pref.toLowerCase().slice(0, 2)));
        if (m) { subsPicked.current = true; useSub(m); }
    }, [info.subs, info.subPref, info.live, info.roomSubtitle]);

    // ---- chat ----
    function sendChat(text: string) {
        const t = text.trim(); if (!t) return;
        chatStore.send(t).catch((e: Error) => toast(e.message || 'Couldn’t send that.'));
        chatStore.typing(false);
    }
    function typingPing(on: boolean) {
        const now = Date.now();
        if (on && now - typingSent.current < 3000) return;
        typingSent.current = on ? now : 0;
        chatStore.typing(on);
    }

    // ---- invite ----
    useEffect(() => {
        if (panel !== 'invite' || !info.invite) return;
        QRCode.toDataURL(info.invite, { margin: 1, width: 360 }).then(setQr).catch(() => setQr(''));
    }, [panel, info.invite]);

    const iAmHost = !!info.isHost || !info.hostOnly;
    const others = Math.max(0, ((info.people || []).length || 1) - 1);
    const meta = useMemo(() => {
        const n = (info.people || []).length;
        return [info.detached ? 'Not synced' : '', n > 1 ? `${n} watching` : 'Just you', (panel === 'invite' || n > 1) && info.room ? `Room ${info.room}` : ''].filter(Boolean).join('  ·  ');
    }, [info, panel]);

    function leave() {
        const doLeave = () => { leftRef.current = true; send({ type: 'leave-room' }); onClose(true); };
        if (!info.hostOnly && others === 0) return doLeave();
        setAsk({
            title: info.hostOnly && !iAmHost ? 'Leave the party?' : 'Stop watching?',
            body: info.hostOnly && !iAmHost ? 'The party carries on without you.' : others > 0 ? `Leaving ends the party for everyone (${others} other ${others === 1 ? 'person' : 'people'}).` : 'Your place is saved in Continue watching.',
            yes: info.hostOnly && !iAmHost ? 'Leave the party' : others > 0 ? 'End party and leave' : 'Stop and leave', no: 'Keep watching', onYes: doLeave
        });
    }

    const shownPos = scrub !== null ? scrub : pos;
    const pct = dur > 0 ? Math.min(100, (shownPos / dur) * 100) : 0;
    const bpct = dur > 0 ? Math.min(100, (bufEnd / dur) * 100) : 0;

    return (
        <div className="watch" onMouseMove={poke} onTouchStart={poke}>
            <div className="stage" ref={stage}>
                {isYt
                    ? <div className="ytwrap" ref={ytWrap} onClick={() => { if (!ui) { poke(); return; } poke(); toggle(); }} onDoubleClick={toggleFs} />
                    : <video ref={vref} playsInline preload="auto" onClick={() => { if (!ui) { poke(); return; } poke(); toggle(); }} onDoubleClick={toggleFs} />}
                {cueText && <div className="subs" style={lookVars(look)}><span>{cueText}</span></div>}
                {status && !failed && (
                    <div className="cover">
                        {open.art && <img alt="" src={open.art} />}
                        <div className="c">
                            <div className="spin" />
                            <h2>{title}</h2>
                            <p className="note" style={{ marginTop: 6 }}>{status}</p>
                        </div>
                    </div>
                )}
                {failed && (
                    <div className="cover" style={{ pointerEvents: 'none', background: 'rgba(0,0,0,.55)' }}>
                        <div className="c">
                            <h2>{title}</h2>
                            <p className="note" style={{ marginTop: 6 }}>{failed}</p>
                            <p className="note">You’re still in the room: chat and the party carry on.</p>
                        </div>
                    </div>
                )}
                {needTap && !failed && <button className="cover" style={{ background: 'rgba(0,0,0,.55)', border: 0, color: '#fff', zIndex: 4 }} onClick={() => { setNeedTap(false); vref.current?.play().catch(() => {}); }}><div className="c"><IPlay width={64} height={64} /><p>Tap to play</p></div></button>}
                {buffering && !status && !failed && <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', pointerEvents: 'none', zIndex: 3 }}><div className="spin" /></div>}

                <div className="pop" aria-live="polite">
                    {pops.map(p => <div key={p.id}>{p.who && <b>{p.who}</b>}{p.text}</div>)}
                    {typing.length > 0 && <div style={{ color: 'var(--muted)' }}>{typing.length === 1 ? `${typing[0]} is typing…` : `${typing.slice(0, 2).join(' and ')} are typing…`}</div>}
                </div>

                {info.hostOnly && (info.detached || (info.behind || 0) >= 3) && Date.now() > ignoreBehindUntil && (
                    <div className="behind">
                        <span>{info.behind > 0 ? `${clock(info.behind)} behind` : 'Not synced'}</span>
                        <button className="btn small primary" onClick={() => send(iAmHostNow() ? { type: 'sync-answer', yes: true } : { type: 'action', action: 'sync' })}>Catch up</button>
                        <button className="btn small ghost" onClick={() => setIgnoreBehindUntil(Date.now() + 120000)}>Ignore</button>
                    </div>
                )}
                {noAudio && (
                    <div className="noaudio" role="status">
                        <b>No sound?</b> This stream’s audio (Dolby Digital+, DTS…) can’t play in a browser.
                        <span>
                            {iAmHostNow() && <button className="btn small" onClick={() => { setNoAudio(false); setPicker(here ? 'streams' : 'video'); }}>Pick another stream</button>}
                            <button className="btn small ghost" onClick={() => setNoAudio(false)}>Dismiss</button>
                        </span>
                    </div>
                )}

                <div className={'topline' + (ui ? '' : ' hide')}>
                    <button className="ibtn" onClick={leave} aria-label="Back"><IBack /></button>
                    <div className="tl-text"><h1>{title}</h1><span className="note">{meta}</span></div>
                </div>

                <div className={'ctrl' + (ui ? '' : ' hide')}>
                    <div className="seek">
                        <span className="time">{clock(shownPos)}</span>
                        <div className="bar" ref={barRef} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} role="slider" aria-label="Seek" aria-valuemin={0} aria-valuemax={Math.round(dur)} aria-valuenow={Math.round(shownPos)} tabIndex={0}>
                            <div className="track" /><div className="buf" style={{ width: bpct + '%' }} /><div className="fill" style={{ width: pct + '%' }} />
                            <div className="knob" style={{ left: pct + '%' }} />
                            {scrub !== null && <div className="tip" style={{ left: pct + '%' }}>{clock(scrub)}</div>}
                        </div>
                        <span className="time">{dur ? clock(dur) : '--:--'}</span>
                    </div>
                    <div className="btns">
                        <button className={'ibtn primary' + (canCtl() ? '' : ' locked')} onClick={toggle} aria-disabled={!canCtl()}>{playing ? <IPause width={18} height={18} /> : <IPlay width={18} height={18} />}{playing ? 'Pause' : 'Play'}</button>
                        <span className="vol">
                            <button className="ibtn" onClick={() => setMuted(m => !m)} aria-label={muted || volume === 0 ? 'Unmute' : 'Mute'}>{muted || volume === 0 ? <IMute width={18} height={18} /> : <IVolume width={18} height={18} />}</button>
                            {!IOS && <input type="range" min={0} max={1} step={0.02} value={muted ? 0 : volume} aria-label="Volume" onChange={e => { const x = parseFloat(e.target.value); setVolume(x); setMuted(x === 0); }} />}
                        </span>
                        {iAmHostNow() && here && <button className="ibtn" onClick={() => setPicker('streams')}><IList width={18} height={18} />Other streams</button>}
                        {iAmHostNow() && <button className="ibtn" onClick={() => setPicker('video')}><ISwap width={18} height={18} />Change video</button>}
                        {info.hostOnly && !iAmHost && <button className="ibtn" onClick={() => send({ type: 'action', action: 'sync' })}>Sync to {String(info.hostName || 'host').slice(0, 14)}</button>}
                        {!isYt && <button className="ibtn" onClick={() => setPanel(panel === 'subs' ? '' : 'subs')}><ISub width={18} height={18} />Subtitles</button>}
                        {!isYt && <button className="ibtn" onClick={() => { setPanel(panel === 'audio' ? '' : 'audio'); audioFallback.current?.load().then(() => audioRefresh.current()); }}><IAudio width={18} height={18} />Language</button>}
                        <button className="ibtn" onClick={() => setPanel(panel === 'invite' ? '' : 'invite')}><IShare width={18} height={18} />Invite</button>
                        <button className="ibtn" onClick={() => setPanel(panel === 'people' ? '' : 'people')}><IUsers width={18} height={18} />Who’s here</button>
                        <button className="ibtn" onClick={() => { if (!info.live && panel !== 'chat') engine.call('goLive').catch(() => {}); setPanel(panel === 'chat' ? '' : 'chat'); setUnread(0); }}><IChat width={18} height={18} />{loungeUrl ? 'Lounge' : 'Chat'}{unread > 0 && <span className="dot">{unread}</span>}</button>
                        {(info.episodes || []).length > 0 && <button className="ibtn" onClick={() => setPanel(panel === 'eps' ? '' : 'eps')}><IList width={18} height={18} />Episodes</button>}
                        {!isYt && <button className="ibtn" onClick={() => setPanel(panel === 'speed' ? '' : 'speed')}>{rate}×</button>}
                        <button className="ibtn" onClick={toggleFs} aria-label="Full screen"><IFull width={18} height={18} /></button>
                    </div>
                </div>
            </div>

            {loungeUrl && (
                <aside className="side lounge-side" aria-label="Lounge" style={panel === 'chat' ? undefined : { display: 'none' }}>
                    <header><h2 style={{ fontSize: 18 }}>Lounge</h2><button className="ibtn" onClick={() => setPanel('')} aria-label="Close"><IX width={16} height={16} /></button></header>
                    <iframe className="lounge-frame" title="Lounge" src={loungeUrl} allow="microphone; camera; autoplay; clipboard-write; fullscreen" />
                </aside>
            )}
            {panel && !(panel === 'chat' && loungeUrl) && (
                <aside className={'side' + (panel === 'subs' ? ' wide' : '')} aria-label={panel}>
                    <header><h2 style={{ fontSize: 18 }}>{({ chat: 'Chat', invite: 'Invite', people: 'Who’s here', subs: 'Subtitles', audio: 'Audio', eps: 'Episodes', speed: 'Speed' } as Record<string, string>)[panel]}</h2><button className="ibtn" onClick={() => setPanel('')} aria-label="Close"><IX width={16} height={16} /></button></header>
                    {panel === 'chat' && !loungeUrl && <ChatPanel chat={chat} onSend={sendChat} onTyping={typingPing} draft={draft} />}
                    {panel === 'invite' && (
                        <div className="body">
                            <InviteProfiles />
                            {info.room ? (
                                <>
                                    <div className="note">PARTY CODE · ANYONE WITH REDDATE CAN JOIN</div>
                                    <RoomCode code={info.room} />
                                    {qr && <div className="qr"><img alt="QR code to join" src={qr} width={180} height={180} /></div>}
                                    <div className="note">Scan to join from a phone or computer</div>
                                    <div className="note" style={{ margin: '10px 0 2px' }}>Or go to</div>
                                    <div style={{ fontWeight: 700, margin: '0 0 12px', overflowWrap: 'anywhere' }}>{String(info.invite || '').replace(/^https?:\/\//, '')}</div>
                                    <button className="btn" onClick={() => { navigator.clipboard?.writeText(info.invite).then(() => toast('Link copied'), () => toast('Couldn’t copy')); }}>Copy link</button>
                                </>
                            ) : <p className="note">The room link isn’t ready yet.</p>}
                        </div>
                    )}
                    {panel === 'people' && (
                        <div className="body">
                            {(info.people || []).map((p: Json) => (
                                <div className="item" key={p.id} style={{ marginBottom: 8 }}>
                                    <span className="avatar" style={{ width: 30, height: 30 }}>{String(p.name || '?').slice(0, 1).toUpperCase()}</span>
                                    <div className="grow"><b>{p.name}{p.you ? ' (you)' : ''}</b><span className="note">{p.main ? 'Main host' : p.host ? 'Host' : p.buffering ? 'Loading…' : 'Guest'}</span></div>
                                    {iAmHostNow() && info.hostOnly && !p.you && !p.main && (
                                        <span className="people-actions">
                                            <button className="btn small ghost" onClick={() => send({ type: 'set-host', id: p.id, on: !p.host })}>{p.host ? 'Remove host' : 'Make host'}</button>
                                            <button className="btn small ghost" onClick={() => send({ type: 'kick', id: p.id })}>Remove</button>
                                        </span>
                                    )}
                                </div>
                            ))}
                            {info.hostOnly && iAmHostNow() && (
                                <label className="opt" style={{ cursor: 'pointer', marginTop: 10 }}>
                                    <input type="checkbox" checked={!!info.guestsCanPause} onChange={e => send({ type: 'action', action: e.target.checked ? 'guests-pause-on' : 'guests-pause-off' })} />
                                    <span>Guests can pause and play for everyone</span>
                                </label>
                            )}
                            <button className="btn" style={{ marginTop: 12 }} onClick={() => setPanel('invite')}>Invite someone</button>
                        </div>
                    )}
                    {panel === 'subs' && (
                        <SubsPanel subs={info.subs || []} loading={!!info.subsLoading} current={subUrl} delay={subDelay}
                            onPick={useSub} onDelay={changeSubDelay} look={look} onLook={patch => setLook(l => { const n = { ...l, ...patch }; saveLook(n); return n; })} />
                    )}
                    {panel === 'audio' && (
                        <div className="body">
                            <p className="note">Your audio language applies to you and is remembered for the next video.</p>
                            {audioStatus && <p className="note" role="status">{audioStatus}</p>}
                            {audioTracks.length < 2 && <p className="note">Switching languages requires multiple audio tracks in the source video.</p>}
                            {audioTracks.map(t => (
                                <button key={t.id} className={'opt' + (t.on ? ' on' : '')} aria-pressed={t.on} aria-busy={audioPending} onClick={() => selectAudio(t.id, t.lang)}>{t.label}</button>
                            ))}
                        </div>
                    )}
                    {panel === 'eps' && (
                        <div className="body">
                            {(info.episodes || []).map((e: Json) => (
                                <button key={e.id} className={'opt' + (e.id === info.current ? ' on' : '')} onClick={() => { send({ type: 'episode', id: e.id }); setPanel(''); }}>
                                    <span>S{e.season}E{e.episode} · {e.title || 'Episode'}</span>
                                </button>
                            ))}
                        </div>
                    )}
                    {panel === 'speed' && (
                        <div className="body">
                            <p className="note" style={{ marginBottom: 10 }}>Only for you. The party stays in sync.</p>
                            {[0.75, 1, 1.25, 1.5, 2].map(r => <button key={r} className={'opt' + (rate === r ? ' on' : '')} onClick={() => { setRate(r); if (vref.current) vref.current.playbackRate = r; }}>{r}×</button>)}
                        </div>
                    )}
                </aside>
            )}

            {picker && <Picker onClose={() => setPicker(false)} start={picker === 'streams' && here ? here : undefined} startAt={picker === 'streams' ? Math.floor(vref.current?.currentTime || 0) : 0} />}

            {ask && (
                <div className="modal" role="dialog" aria-modal="true">
                    <div className="card big">
                        <h2>{ask.title}</h2>
                        <p className="note" style={{ margin: '8px 0 18px', fontSize: 16 }}>{ask.body}</p>
                        <div style={{ display: 'flex', gap: 10 }}>
                            <button className="btn primary" autoFocus onClick={() => { const a = ask; setAsk(null); a.onNo?.(); }}>{ask.no}</button>
                            <button className="btn" onClick={() => { const a = ask; setAsk(null); a.onYes(); }}>{ask.yes}</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

export function ChatPanel({ chat, onSend, onTyping, draft, autoFocus = true }: { chat: ChatMsg[]; onSend: (t: string) => void; onTyping: (on: boolean) => void; draft: React.MutableRefObject<string>; autoFocus?: boolean }) {
    const [text, setText] = useState(draft.current);
    const end = useRef<HTMLDivElement>(null);
    useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [chat.length]);
    useEffect(() => { draft.current = text; }, [text]);
    return (
        <>
            <div className="body">
                {chat.length === 0 && <p className="note">No messages yet. Say hi!</p>}
                {chat.map((m, i) => <div key={i} className={'msg' + (m.me ? ' me' : '')}><b>{m.who}</b>{m.text}</div>)}
                <div ref={end} />
            </div>
            <form className="chatform" onSubmit={e => { e.preventDefault(); if (text.trim()) { onSend(text); setText(''); } }}>
                <input className="input" autoFocus={autoFocus} placeholder="Type a message" value={text} maxLength={500} onChange={e => { setText(e.target.value); onTyping(e.target.value.length > 0); }} />
                <button className="btn primary" type="submit">Send</button>
            </form>
        </>
    );
}
