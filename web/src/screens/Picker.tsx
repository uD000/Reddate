import React, { useEffect, useRef, useState } from 'react';
import { engine, Json } from '../engine';
import { PickCtx } from '../pick';
import { useBackClose } from '../back';
import { Meta, parseMeta } from '../util';
import { PosterCard } from './Poster';
import { RowView, Row } from './Home';
import { TitlePage } from './Title';
import { IBack, IX, ISearch } from '../icons';

/** "Change video": the catalog and search over the picture, which keeps playing. Picking a title replaces it for everyone.
 *  With `start` ("Other streams"), it opens on the title that's playing, at its streams (a show at its episode); the
 *  new stream starts at `startAt` seconds. Back from there goes to the catalog, to change the movie or show instead. */
export function Picker({ onClose, start, startAt = 0 }: {
    onClose: () => void; start?: { id: string; type: string; name: string; episodeId: string }; startAt?: number;
}) {
    const [rows, setRows] = useState<Row[] | null>(null);
    const [q, setQ] = useState('');
    const [res, setRes] = useState<Meta[] | null>(null);
    const [busy, setBusy] = useState(false);
    const [title, setTitle] = useState<Meta | null>(() => (start ? parseMeta({ id: start.id, type: start.type, name: start.name }, start.type) : null));
    const atStart = !!start && !!title && title.id === start.id; // still on the title that's playing
    useBackClose(!!title, () => setTitle(null)); // Back: from a title to the list, then out of the picker
    const seq = useRef(0);

    useEffect(() => { engine.call<Row[]>('rows', {}, 40000).then(setRows).catch(() => setRows([])); }, []);
    useEffect(() => {
        const on = (e: KeyboardEvent) => { if (e.key === 'Escape') { if (title) setTitle(null); else onClose(); } };
        window.addEventListener('keydown', on);
        return () => window.removeEventListener('keydown', on);
    }, [title, onClose]);
    useEffect(() => {
        const t = q.trim();
        if (t.length < 2) { setRes(null); return; }
        const my = ++seq.current;
        setBusy(true);
        const h = setTimeout(() => {
            engine.call<Json[]>('search', { q: t }, 30000).then(r => {
                if (my === seq.current) setRes(r.map(m => parseMeta(m)).filter(m => m.id && m.poster));
            }).catch(() => { if (my === seq.current) setRes([]); }).finally(() => { if (my === seq.current) setBusy(false); });
        }, 450);
        return () => clearTimeout(h);
    }, [q]);

    return (
        <PickCtx.Provider value={m => setTitle(m)}>
            <div className="picker" role="dialog" aria-modal="true" aria-label="Change video">
                <header>
                    {title ? <button className="ibtn" onClick={() => setTitle(null)} aria-label="Back to the catalog" title="Change video: another movie or show"><IBack width={18} height={18} /></button> : null}
                    <h2>{title ? (atStart ? `Other streams · ${title.name}` : title.name) : 'Change video'}</h2>
                    {!title && (
                        <label className="psearch"><ISearch width={18} height={18} />
                            <input autoFocus placeholder="Search movies and shows" value={q} onChange={e => setQ(e.target.value)} aria-label="Search" />
                        </label>
                    )}
                    <button className="ibtn" onClick={onClose} aria-label="Close"><IX width={18} height={18} /></button>
                </header>
                <div className="picker-body">
                    {title ? (
                        <TitlePage key={title.id} type={title.type} id={title.id} embedded onPlayed={onClose}
                            episodeId={atStart ? start!.episodeId : ''} startAt={atStart ? startAt : 0} />
                    ) : q.trim().length >= 2 ? (
                        <>
                            {busy && !res && <p className="note">Searching…</p>}
                            {res && res.length === 0 && !busy && <p className="note">Nothing found. Try other words.</p>}
                            <div className="grid">{(res || []).map(m => <PosterCard key={m.id} m={m} />)}</div>
                        </>
                    ) : (
                        <>
                            {rows === null && <div className="skeleton" style={{ height: 180 }} />}
                            {(rows || []).map(r => <RowView key={r.key} row={r} />)}
                        </>
                    )}
                </div>
            </div>
        </PickCtx.Provider>
    );
}
