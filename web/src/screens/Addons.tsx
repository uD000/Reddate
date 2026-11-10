import React, { useEffect, useState } from 'react';
import { engine, Json } from '../engine';
import { useApp } from '../App';

interface AddonItem { url: string; name: string; host: string; logo: string; description: string; enabled: boolean; loaded: boolean; catalog: boolean; stream: boolean; subtitles: boolean; builtIn?: boolean }

// A logo that failed to load (or none) shows the addon's first letter instead of a broken image.
function Logo({ src, name }: { src: string; name: string }) {
    const [bad, setBad] = useState(!src);
    const box: React.CSSProperties = { width: 40, height: 40, borderRadius: 10, flex: 'none', overflow: 'hidden' };
    if (bad) return <div aria-hidden style={{ ...box, background: 'var(--paper3)', display: 'grid', placeItems: 'center', fontWeight: 700, color: 'var(--muted)' }}>{(name || '?').trim().charAt(0).toUpperCase()}</div>;
    return <img src={src} alt="" width={40} height={40} onError={() => setBad(true)} style={{ ...box, objectFit: 'contain', background: 'var(--paper3)', color: 'transparent' }} />;
}

export function Addons() {
    const { toast } = useApp();
    const [list, setList] = useState<AddonItem[] | null>(null);
    const [url, setUrl] = useState('');
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState('');
    const load = () => engine.call<AddonItem[]>('addons', {}, 30000).then(setList).catch(() => setList([]));
    useEffect(() => { load(); }, []);
    // "Add to Reddate" from an addon's setup page (e.g. Reddate YT) arrives as ?add=<manifest link>: fill it in, ready to add.
    useEffect(() => {
        const a = new URLSearchParams(location.search).get('add');
        if (a && /^https:\/\/|^http:\/\/localhost/.test(a)) { setUrl(a); history.replaceState(null, '', location.pathname); }
    }, []);

    async function add(e: React.FormEvent) {
        e.preventDefault();
        if (!url.trim() || busy) return;
        setBusy(true); setErr('');
        try {
            const r = await engine.call<Json>('addonAdd', { url: url.trim() }, 40000);
            if (r && r.ok === false) { setErr(r.message || r.error || 'That isn’t a working addon link.'); }
            else { setUrl(''); toast('Addon added'); await load(); }
        } catch (ex: any) { setErr(ex.message || 'Couldn’t add that.'); } finally { setBusy(false); }
    }
    // An addon whose manifest didn't load is named by its address, and says why it has no details.
    const kinds = (a: AddonItem) => [a.catalog && 'Catalogs', a.stream && 'Streams', a.subtitles && 'Subtitles'].filter(Boolean).join(' · ') ||
        (a.loaded ? 'Other' : a.enabled ? 'Couldn’t reach this addon right now' : 'Switched off');
    const nameOf = (a: AddonItem) => (a.loaded ? a.name : a.host || a.name);
    return (
        <main className="page" style={{ maxWidth: 820 }}>
            <h1>Addons</h1>
            <p className="note" style={{ margin: '4px 0 16px' }}>Addons give Home its rows and give titles their streams and subtitles. Paste an addon’s link to add it. Your account keeps them on every device.</p>
            <form onSubmit={add} className="card" style={{ marginBottom: 18 }}>
                <div className="field" style={{ marginBottom: 8 }}><label htmlFor="au">Addon link</label><input id="au" placeholder="https://…/manifest.json" value={url} onChange={e => setUrl(e.target.value)} /></div>
                <div className="err">{err}</div>
                <button className="btn primary" disabled={busy || !url.trim()}>{busy ? 'Adding…' : 'Add addon'}</button>
            </form>
            {list === null && <div className="skeleton" style={{ height: 120 }} />}
            <div className="list">
                {(list || []).map(a => (
                    <div className="item" key={a.url} style={{ opacity: a.enabled ? 1 : .6 }}>
                        <Logo src={a.logo} name={nameOf(a)} />
                        <div className="grow"><b>{nameOf(a)}</b><span className="note">{kinds(a)}{a.description ? ' · ' + a.description : ''}</span></div>
                        <button className={'switch' + (a.enabled ? ' on' : '')} aria-label={(a.enabled ? 'Turn off ' : 'Turn on ') + nameOf(a)} onClick={async () => { await engine.call('addonEnable', { url: a.url, on: !a.enabled }); load(); }} />
                        {a.builtIn && /\/yt\/manifest\.json$/.test(a.url) && <a className="btn small primary" href="/yt" target="_blank" rel="noopener">Set up</a>}
                        {!a.builtIn && <button className="btn small ghost" onClick={async () => { await engine.call('addonRemove', { url: a.url }); toast('Removed'); load(); }}>Remove</button>}
                    </div>
                ))}
            </div>
            <button className="btn ghost" style={{ marginTop: 16 }} onClick={async () => { await engine.call('syncAddons', {}, 30000).catch(() => {}); load(); toast('Synced with your account'); }}>Sync with account</button>
        </main>
    );
}
