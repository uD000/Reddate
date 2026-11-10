import React, { useEffect, useState } from 'react';
import { engine, Json } from '../engine';
import { useApp, forgetPicked } from '../App';
import { authApi } from '../api';

export function Account() {
    const { go, refresh, toast, st } = useApp();
    const [a, setA] = useState<Json | null>(null);
    const [msg, setMsg] = useState('');
    const [bug, setBug] = useState('');
    const [bugBusy, setBugBusy] = useState(false);
    const [devs, setDevs] = useState<Json[] | null>(null);
    const [tvCode, setTvCode] = useState('');
    const [tvErr, setTvErr] = useState('');
    const loadDevs = () => authApi('/api/devices').then(r => setDevs(r.ok ? r.data.devices || [] : []));
    useEffect(() => { loadDevs(); }, []);
    useEffect(() => { engine.call<Json>('accountInfo').then(setA).catch(() => {}); }, [st.profileId]);

    async function sendBug(e: React.FormEvent) {
        e.preventDefault();
        if (bug.trim().length < 5 || bugBusy) return;
        setBugBusy(true);
        try {
            const r = await fetch('/api/report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: bug.trim(), source: 'web', app: 'web 0.1', device: navigator.userAgent.slice(0, 100), account: a && a.email, screen: 'Account' }) });
            const d = await r.json().catch(() => ({}));
            if (r.ok && d.ok) { setBug(''); toast('Sent. Thank you, this really helps.'); } else toast(d.error || 'Couldn’t send it. Try again.');
        } catch { toast('No connection. Try again.'); } finally { setBugBusy(false); }
    }
    return (
        <main className="page" style={{ maxWidth: 760 }}>
            <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 18 }}>
                <span className="avatar lg">{(st.profile || '?').slice(0, 1).toUpperCase()}</span>
                <div><h1>{st.profile}</h1><div className="note">{a && a.email}</div></div>
            </div>
            {a && a.signedIn && a.verified === false && (
                <div className="card" style={{ marginBottom: 14, borderColor: '#6a3a22' }}>
                    <b>Confirm your email</b>
                    <p className="note" style={{ margin: '4px 0 10px' }}>{msg || 'So you can reset your password if you ever forget it. The link is in your inbox (or spam).'}</p>
                    <button className="btn small" onClick={async () => { const r = await engine.call<Json>('resendConfirm').catch(() => null); setMsg(r && r.verified ? 'Already confirmed. Thanks!' : r && r.ok ? 'Sent. Check your inbox (and spam).' : 'Couldn’t send it. Try again later.'); }}>Send the link again</button>
                </div>
            )}
            <div className="list">
                <button className="item" onClick={() => go('/profiles')}><div className="grow" style={{ textAlign: 'left' }}><b>Switch or edit profiles</b><span className="note">{st.profiles.length} on this account</span></div></button>
                <button className="item" onClick={() => go('/addons')}><div className="grow" style={{ textAlign: 'left' }}><b>Addons</b><span className="note">Turn them on or off, remove or add</span></div></button>
                <button className="item" onClick={async () => { await engine.call('signOut').catch(() => {}); forgetPicked(); await refresh(); go('/', true); location.reload(); }}><div className="grow" style={{ textAlign: 'left' }}><b>Sign out of this browser</b><span className="note">{a && a.device}</span></div></button>
            </div>
            <section className="card" style={{ marginTop: 22 }}>
                <h2>Devices &amp; TVs</h2>
                <p className="note" style={{ margin: '4px 0 12px' }}>Open Reddate on your TV: it shows a code and a QR code. Scan the QR with this phone, or type the code here.</p>
                <form style={{ display: 'flex', gap: 8 }} onSubmit={e => { e.preventDefault(); const c = tvCode.replace(/[^A-Z0-9]/gi, '').toUpperCase(); if (c.length < 8) { setTvErr('Enter the 8-character code shown on the TV.'); return; } try { sessionStorage.setItem('rd-link', c); } catch { /* fine */ } location.href = (window as any).__RD_HOME || '/'; }}>
                    <input className="input" placeholder="ABCD-EFGH" maxLength={9} value={tvCode} onChange={e => { setTvCode(e.target.value.toUpperCase()); setTvErr(''); }} aria-label="TV code" />
                    <button className="btn primary">Add TV</button>
                </form>
                <div className="err">{tvErr}</div>
                <div className="list" style={{ marginTop: 10 }}>
                    {(devs || []).map(d => (
                        <div className="item" key={d.id}>
                            <div className="grow"><b>{d.name}{d.current ? ' (this device)' : ''}</b><span className="note">{d.kind === 'tv' ? 'TV' : 'Browser'} · last used {new Date(d.lastSeen).toLocaleDateString()}</span></div>
                            {!d.current && <button className="btn small ghost" onClick={async () => { await authApi(`/api/devices/${d.id}`, { method: 'DELETE' }); loadDevs(); }}>Remove</button>}
                        </div>
                    ))}
                </div>
            </section>
            <form className="card" style={{ marginTop: 22 }} onSubmit={sendBug}>
                <h2>Report a bug</h2>
                <p className="note" style={{ margin: '4px 0 12px' }}>Tell us what went wrong. It goes straight to us.</p>
                <div className="field"><textarea className="input" rows={4} maxLength={4000} value={bug} onChange={e => setBug(e.target.value)} placeholder="What happened? Which title or screen?" /></div>
                <button className="btn primary" disabled={bugBusy || bug.trim().length < 5}>{bugBusy ? 'Sending…' : 'Send report'}</button>
            </form>
        </main>
    );
}
