import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useBackClose } from '../back';
import { engine, Json } from '../engine';
import { useApp } from '../App';
import { Meta, Stream, parseMeta, parseStream, tierOf, TIER_ORDER, isHdr, sizeGb, browserFit, qualityScore } from '../util';
import { PosterCard } from './Poster';
import { IPlay, IShare, IX } from '../icons';
import { checkMany, likelihood, verdict, useVerdicts } from '../probe';

function whyText(o: Json | null): string {
    if (!o) return '';
    const n = (x: number, one: string, many: string) => `${x} ${x === 1 ? one : many}`;
    if (o.torrents > 0 && o.answered === o.torrents + (o.messages || 0)) return `${n(o.torrents, 'torrent-only source', 'torrent-only sources')} found. Torrents need a debrid service (TorBox, Real-Debrid…) to play, and none of your stream addons turns them into a link.`;
    if (!o.asked) return `None of your stream addons answers for this kind of title (${n(o.enabledStreamAddons || 0, 'stream addon', 'stream addons')} on). Check Addons.`;
    return `${n(o.asked, 'stream addon', 'stream addons')} checked, none had a playable link for this.`;
}

/** The streams for one movie or episode, grouped by quality. Picking one starts it. */
function StreamList({ meta, streamKey, isSeries, label, together, onPlayed, forRoom, startAt = 0 }: {
    meta: Meta; streamKey: string; isSeries: boolean; label: string; together: boolean; onPlayed: () => void; forRoom?: boolean; startAt?: number;
}) {
    useVerdicts();
    const { go, toast, refresh } = useApp();
    const [streams, setStreams] = useState<Stream[] | null>(null);
    const [pending, setPending] = useState(0);
    const [why, setWhy] = useState('');
    const [tier, setTier] = useState('');
    const onlyBrowser = !forRoom;
    const [starting, setStarting] = useState(false);

    useEffect(() => {
        setStreams(null); setPending(0); setWhy(''); setTier('');
        if (!streamKey) return;
        let dead = false;
        (async () => {
            try {
                const list = (await engine.call<Json[]>('streams', { type: meta.type, id: streamKey, key: isSeries ? meta.id : streamKey }, 60000)).map(parseStream);
                if (dead) return;
                setStreams(list);
                if (!list.length) { try { const w = await engine.call<Json>('streamInfo', { type: meta.type, id: streamKey }); if (!dead) setWhy(whyText(w)); } catch { /* fine */ } }
                for (let i = 0; i < 20 && !dead; i++) {
                    await new Promise(r => setTimeout(r, 2500));
                    const more = await engine.call<Json>('streamsMore', { type: meta.type, id: streamKey, key: isSeries ? meta.id : streamKey }, 20000).catch(() => null);
                    if (dead || !more) break;
                    setPending(more.pending || 0);
                    if (Array.isArray(more.streams) && more.streams.length) setStreams(more.streams.map(parseStream));
                    if (!more.pending) break;
                }
            } catch { if (!dead) setStreams([]); }
        })();
        return () => { dead = true; };
    }, [meta.id, streamKey]);

    // Check what plays on this device: likeliest first, two at a time, until enough are known to play.
    const [settled, setSettled] = useState(false);
    useEffect(() => {
        if (!streams) return;
        let dead = false;
        setSettled(false);
        const ordered = [...streams].filter(s => sizeGb(s) <= 30) // 30 GB+ remuxes are too heavy to stream in a browser
            .sort((a, b) => likelihood(b) - likelihood(a) || qualityScore(b) - qualityScore(a)).slice(0, 60);
        checkMany(ordered, 5, () => dead).finally(() => { if (!dead) setSettled(true); });
        return () => { dead = true; };
    }, [streams]);
    const rank = (s: Stream) => { const v = verdict(s.url); return v ? ({ ok: 3, checking: 1, unknown: 1, no: 0 } as Record<string, number>)[v.v] : 1; };
    // Only what was shown to play is listed. If nothing could be confirmed (autoplay blocked, slow links), the best
    // few that weren't ruled out are offered instead of a dead end, said plainly (same as reddate.xyz).
    const { visible, guess } = useMemo(() => {
        if (!streams) return { visible: [] as Stream[], guess: false };
        if (!onlyBrowser) return { visible: streams, guess: false };
        const ok = streams.filter(s => verdict(s.url)?.v === 'ok');
        if (ok.length) return { visible: ok, guess: false };
        if (!settled) return { visible: [] as Stream[], guess: false };
        const maybe = streams.filter(s => sizeGb(s) <= 30 && verdict(s.url)?.v !== 'no' && browserFit(s).ok !== false)
            .sort((a, b) => likelihood(b) - likelihood(a) || qualityScore(b) - qualityScore(a)).slice(0, 5);
        return { visible: maybe, guess: maybe.length > 0 };
    }, [streams, onlyBrowser, settled, streams && streams.map(s => verdict(s.url)?.v).join()]);
    const tiers = useMemo(() => TIER_ORDER.filter(t => visible.some(s => tierOf(s) === t)), [visible]);
    const activeTier = tier && tiers.includes(tier) ? tier : tiers[0] || '';
    const list = useMemo(() => visible.filter(s => tierOf(s) === activeTier).sort((a, b) => rank(b) - rank(a) || qualityScore(b) - qualityScore(a)).slice(0, 60), [visible, activeTier, visible.map(s => verdict(s.url)?.v).join()]);

    async function play(s: Stream) {
        if (starting) return;
        setStarting(true);
        try {
            if (together) { try { sessionStorage.setItem('rd-invite', '1'); sessionStorage.setItem('rd-invite-at', String(Date.now())); sessionStorage.setItem('rd-starting', String(Date.now())); } catch { /* fine */ } }
            else { try { sessionStorage.setItem('rd-starting', String(Date.now())); } catch { /* fine */ } }
            await engine.call('play', {
                payload: {
                    kind: 'direct', src: s.url, title: label, ...(startAt > 30 ? { startAt } : {}),
                    content: { type: meta.type, id: streamKey, filename: (s.filename || s.title).slice(0, 200), art: meta.background || meta.poster || undefined, show: isSeries ? meta.id : undefined }
                }
            }, 30000);
            refresh();
            onPlayed();
        } catch (e: any) { toast(e.message || 'Couldn’t start that.'); setStarting(false); }
    }

    if (!streamKey) return null;
    if (streams === null) return <div className="streams">{[0, 1, 2].map(i => <div key={i} className="skeleton" style={{ height: 62 }} />)}<p className="note working" role="status"><span className="spin sm" /> Asking your stream addons…</p></div>;
    if (streams.length === 0) return <div className="card"><b>No streams found.</b><p className="note" style={{ marginTop: 6 }}>{why || 'None of your stream addons answers for this title.'}</p><button className="btn small" style={{ marginTop: 10 }} onClick={() => go('/addons')}>Check addons</button></div>;
    return (
        <>
            <div className="tierbar">
                {tiers.map(t => <button key={t} className={'chip' + (t === activeTier ? ' on' : '')} onClick={() => setTier(t)}>{t} <span className="count">{visible.filter(s => tierOf(s) === t).length}</span></button>)}
                
            </div>
            {onlyBrowser && guess && <p className="note" style={{ marginTop: 12 }} role="status">These might work on this device. Pick one to try.</p>}
            {onlyBrowser && !list.length && (
                <p className="note" style={{ marginTop: 12 }} role="status">
                    {!settled || pending > 0
                        ? 'Checking which streams play on this device…'
                        : 'No streams for this title play on this device. The TV app plays more formats (MKV, HEVC, surround audio).'}
                </p>
            )}
            <div className="streams">
                {list.map((s, i) => {
                    const fit = browserFit(s);
                    const vd = verdict(s.url);
                    const g = sizeGb(s);
                    return (
                        <button key={s.url + i} className="stream" disabled={starting} onClick={() => play(s)}>
                            <div className="st-top">
                                {s.logo ? <img className="l" alt="" src={s.logo} /> : null}
                                <span className="n">{s.name || s.addon}{s.matchExact && i === 0 ? ' · Your usual' : ''}</span>
                                {isHdr(s) && <span className="tag">HDR</span>}
                                {g > 0 && <span className="tag">{g.toFixed(1)} GB</span>}
                                {vd?.v === 'ok' && <span className="tag good">Plays here</span>}
                                {vd?.v === 'checking' && <span className="tag">Checking…</span>}
                                {vd?.v === 'no' && <span className="tag warn" title="This browser can't play it. It plays on the TV app.">{vd.why || 'Won’t play here'}</span>}
                                {(!vd || vd.v === 'unknown') && !fit.ok && <span className="tag warn" title="Browsers often can't play this. It plays on the TV app.">{fit.why}</span>}
                                <IPlay className="go" width={18} height={18} />
                            </div>
                            <div className="st-desc">{(s.filename || s.title || '').trim()}</div>
                        </button>
                    );
                })}
            </div>
            {onlyBrowser && !settled && (
                <p className="note working" role="status">
                    <span className="spin sm" /> Checking what plays on this device… {streams.filter(s => verdict(s.url)?.v === 'ok').length} ready
                </p>
            )}
            {pending > 0 && <p className="note" style={{ marginTop: 10 }}>Still checking {pending} more addon{pending === 1 ? '' : 's'}…</p>}
            {starting && <p className="note" style={{ marginTop: 10 }}><span className="spin sm" /> Starting…</p>}
        </>
    );
}

/** `episodeId` opens a show straight at that episode's streams; `startAt` (seconds) starts the picked stream there. */
export function TitlePage({ type, id, embedded, onPlayed, episodeId: openEpisode = '', startAt = 0 }: { type: string; id: string; embedded?: boolean; onPlayed?: () => void; episodeId?: string; startAt?: number }) {
    const [moreText, setMoreText] = useState(false);
    const { metaCache, go, toast } = useApp();
    const [meta, setMeta] = useState<Meta | null>(() => { const m = metaCache.get(`${type}:${id}`); return m ? (m as Meta) : null; });
    const [full, setFull] = useState(false);
    const [season, setSeason] = useState<number | null>(null);
    const [episode, setEpisode] = useState<string>('');
    const [sheet, setSheet] = useState(false);
    const [together, setTogether] = useState(false);
    const [starting, setStarting] = useState('');
    const resumeKey = embedded ? '' : new URLSearchParams(location.search).get('resume') || '';
    const started = useRef(false);

    useEffect(() => {
        let dead = false;
        engine.call<Json>('meta', { type, id }, 30000).then(o => {
            if (dead || !o) return;
            const m = parseMeta(o, type);
            setMeta(prev => (prev ? { ...m, poster: m.poster || prev.poster, background: m.background || prev.background, name: m.name !== 'Untitled' ? m.name : prev.name } : m));
            setFull(true);
        }).catch(() => { setFull(true); });
        return () => { dead = true; };
    }, [type, id]);

    useEffect(() => {
        if (!resumeKey || started.current) return;
        started.current = true;
        setStarting('Finding your stream…');
        engine.call<Json>('resolveResume', { k: resumeKey }, 50000).then(async r => {
            setStarting('Starting…');
            try { sessionStorage.setItem('rd-starting', String(Date.now())); } catch { /* fine */ }
            await engine.call('play', { payload: r.payload });
        }).catch((e: Error) => { setStarting(''); toast(e.message || 'Couldn’t resume that.'); });
    }, [resumeKey]);

    const isSeries = !!meta && (meta.type === 'series' || meta.type === 'anime' || meta.episodes.length > 0);
    const seasons = useMemo(() => (meta ? [...new Set(meta.episodes.map(e => e.season))].sort((a, b) => a - b) : []), [meta]);
    useEffect(() => {
        if (!meta || !isSeries || season !== null || seasons.length === 0) return;
        setSeason(seasons.find(s => s > 0) ?? seasons[0] ?? 0);
    }, [meta, isSeries, seasons, season]);
    // "Other streams" for a show: straight to the episode that's playing, with its streams open.
    const openedEpisode = useRef(false);
    useEffect(() => {
        if (!openEpisode || openedEpisode.current || !meta || !full) return;
        const e = meta.episodes.find(x => x.id === openEpisode);
        if (!e) return;
        openedEpisode.current = true;
        setSeason(e.season); setEpisode(e.id); setSheet(true);
    }, [openEpisode, meta, full]);

    const streamKey = !meta || !full ? '' : isSeries ? episode : (meta.imdbId || (meta.id.startsWith('tmdb:') ? '' : meta.id));
    const label = !meta ? '' : !isSeries ? meta.name : (() => { const ep = meta.episodes.find(e => e.id === episode); return ep ? `${meta.name} S${ep.season}E${ep.number}` : meta.name; })();
    const played = () => { if (onPlayed) onPlayed(); else go('/watch'); };

    useBackClose(sheet, () => setSheet(false));
    // Escape closes the stream sheet.
    useEffect(() => {
        if (!sheet) return;
        const on = (e: KeyboardEvent) => { if (e.key === 'Escape') setSheet(false); };
        window.addEventListener('keydown', on);
        return () => window.removeEventListener('keydown', on);
    }, [sheet]);

    if (!meta) return <main className="page"><div className="skeleton" style={{ height: 300 }} />{full && <p className="note" style={{ marginTop: 14 }}>Couldn’t load this title.</p>}</main>;
    const eps = meta.episodes.filter(e => e.season === season);
    const ep = meta.episodes.find(e => e.id === episode);
    // A YouTube channel: a round picture, and its uploads as "Videos" (newest first, no seasons).
    const channel = meta.id.startsWith('ytc:');
    return (
        <>
            {meta.background && !embedded && <div className="backdrop"><img alt="" src={meta.background} /></div>}
            <main className={embedded ? 'page embedded' : 'page'}>
                <div className={'title-head' + (moreText ? ' more' : '')}>
                    <div className={'pos' + (channel ? ' round' : '')}>{meta.poster && <img alt="" src={meta.poster} />}</div>
                    <div>
                        <div className="kicker">{meta.type}</div>
                        <h1 style={{ fontSize: 'clamp(26px,4vw,42px)' }}>{meta.name}</h1>
                        <div className="meta" style={{ margin: '6px 0 10px' }}>{[meta.releaseInfo, meta.runtime, meta.rating && `★ ${meta.rating}`, meta.genres.slice(0, 3).join(' · ')].filter(Boolean).join('  ·  ')}</div>
                        <p className="desc">{meta.description}</p>
                        {(meta.description || '').length > 140 && <button className="more-btn" onClick={() => setMoreText(m => !m)}>{moreText ? 'Less' : 'More'}</button>}
                        {meta.cast.length > 0 && <p className="note cast" style={{ marginTop: 10 }}>Starring {meta.cast.join(', ')}</p>}
                        <label className="chip" style={{ cursor: 'pointer', marginTop: 14 }}><input type="checkbox" checked={together} onChange={e => setTogether(e.target.checked)} /> <IShare width={16} height={16} /> Start a watch party</label>
                    </div>
                </div>

                {isSeries ? (
                    <section>
                        <div className="row-head"><h2>{channel ? 'Videos' : 'Episodes'}</h2></div>
                        {!channel && <div className="tierbar">
                            {seasons.map(s => <button key={s} className={'chip' + (s === season ? ' on' : '')} onClick={() => setSeason(s)}>{s === 0 ? 'Specials' : `Season ${s}`}</button>)}
                        </div>}
                        <div className="eps">
                            {eps.map(e => (
                                <button key={e.id} className={'ep' + (episode === e.id ? ' on' : '')} onClick={() => { setEpisode(e.id); setSheet(true); }}>
                                    {e.thumbnail ? <img loading="lazy" alt="" src={e.thumbnail} /> : <div className="ph" />}
                                    <div style={{ minWidth: 0 }}><b>{channel ? e.title : `${e.number}. ${e.title}`}</b>{e.overview && <div className="note clamp2">{e.overview}</div>}</div>
                                </button>
                            ))}
                        </div>
                    </section>
                ) : (
                    <section>
                        <div className="row-head"><h2>Streams</h2></div>
                        <StreamList meta={meta} streamKey={streamKey} isSeries={false} label={label} together={together} onPlayed={played} forRoom={embedded} startAt={startAt} />
                    </section>
                )}

                {meta.similar.length > 0 && (
                    <section>
                        <div className="row-head"><h2>More like this</h2></div>
                        <div className="rail">{meta.similar.map(m => <PosterCard key={m.id} m={m} />)}</div>
                    </section>
                )}
            </main>

            {isSeries && sheet && ep && (
                <div className="sheet-scrim" onClick={() => setSheet(false)}>
                    <section className="sheet" role="dialog" aria-modal="true" aria-label={`Streams for ${label}`} onClick={e => e.stopPropagation()}>
                        <header>
                            <div style={{ minWidth: 0 }}><div className="kicker">{channel ? meta.name : `S${ep.season} · E${ep.number}`}</div><h2>{ep.title}</h2></div>
                            <button className="btn small ghost" onClick={() => setSheet(false)} aria-label="Close"><IX width={16} height={16} /></button>
                        </header>
                        <div className="sheet-body">
                            <StreamList key={episode} meta={meta} streamKey={episode} isSeries label={label} together={together} forRoom={embedded} startAt={episode === openEpisode ? startAt : 0} onPlayed={() => { setSheet(false); played(); }} />
                        </div>
                    </section>
                </div>
            )}
            {starting && <div className="modal" role="status"><div className="card" style={{ textAlign: 'center' }}><div className="spin" /><b>{starting}</b></div></div>}
        </>
    );
}
