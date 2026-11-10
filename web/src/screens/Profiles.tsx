import React, { useState } from 'react';
import { engine } from '../engine';
import { useApp } from '../App';

export function Profiles({ first, onDone }: { first?: boolean; onDone?: () => void }) {
    const { st, refresh, go, back, toast } = useApp();
    const [edit, setEdit] = useState(false);
    const [dlg, setDlg] = useState<null | { id: string | null; name: string; main: boolean }>(null);
    const [busy, setBusy] = useState(false);
    const [armed, setArmed] = useState(false);
    const current = st.profiles.find(p => p.id === st.profileId);

    async function choose(id: string) {
        await engine.call('chooseProfile', { id });
        await refresh();
        if (onDone) onDone(); else back();
    }
    async function save() {
        if (!dlg || !dlg.name.trim() || busy) return;
        setBusy(true);
        try {
            const r = await engine.call<{ ok: boolean }>(dlg.id ? 'renameProfile' : 'addProfile', dlg.id ? { id: dlg.id, name: dlg.name.trim() } : { name: dlg.name.trim() }, 25000);
            if (!r.ok) toast('Couldn’t save that. Try again.');
            await refresh(); setDlg(null);
        } catch (e: any) { toast(e.message); } finally { setBusy(false); }
    }
    async function del() {
        if (!dlg || !dlg.id) return;
        if (!armed) { setArmed(true); setTimeout(() => setArmed(false), 3500); return; }
        setBusy(true);
        try { await engine.call('removeProfile', { id: dlg.id }, 25000); await refresh(); setDlg(null); }
        catch (e: any) { toast(e.message); } finally { setBusy(false); setArmed(false); }
    }
    return (
        <div className="auth" style={{ alignContent: 'center' }}>
            <div style={{ textAlign: 'center' }}>
                <h1>{edit ? 'Edit profiles' : 'Who’s watching?'}</h1>
                <p className="note">{edit ? 'Pick a profile to rename or delete it.' : 'Every profile keeps its own Continue watching and history.'}</p>
                <div className="profiles">
                    {st.profiles.map(p => (
                        <button key={p.id} onClick={() => (edit ? setDlg({ id: p.id, name: p.name, main: !!p.main }) : choose(p.id))}>
                            <span className="avatar lg">{p.name.slice(0, 1).toUpperCase()}</span>
                            <span>{p.name}{p.id === st.profileId && !edit ? ' (now)' : ''}</span>
                            {edit && <span className="note">{p.main ? 'Main' : 'Edit'}</span>}
                        </button>
                    ))}
                    {st.profiles.length < 6 && (
                        <button onClick={() => setDlg({ id: null, name: '', main: false })}>
                            <span className="avatar lg" style={{ background: 'var(--paper2)', color: 'var(--ink)', border: '2px solid var(--rule)' }}>+</span>
                            <span className="note">Add profile</span>
                        </button>
                    )}
                </div>
                <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
                    <button className="btn" onClick={() => setEdit(!edit)}>{edit ? 'Done' : 'Edit profiles'}</button>
                    {/* The chooser never traps you: carry on as the profile that's on now. */}
                    {first && !edit && onDone && current && <button className="btn primary" onClick={onDone}>Continue as {current.name}</button>}
                    {!first && <button className="btn ghost" onClick={() => back('/account')}>Back</button>}
                </div>
            </div>
            {dlg && (
                <div className="modal" role="dialog" aria-modal="true">
                    <form className="card" onSubmit={e => { e.preventDefault(); save(); }}>
                        <h2>{dlg.id ? 'Edit profile' : 'New profile'}</h2>
                        <p className="note" style={{ margin: '6px 0 14px' }}>{dlg.id ? 'Its Continue watching and history stay its own.' : 'It starts with your main profile’s addons, and keeps its own Continue watching and history.'}</p>
                        <div className="field"><label htmlFor="pn">Name</label><input id="pn" autoFocus maxLength={24} value={dlg.name} onChange={e => setDlg({ ...dlg, name: e.target.value })} /></div>
                        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                            <button className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
                            {dlg.id && !dlg.main && <button type="button" className="btn ghost" onClick={del}>{armed ? 'Press again to delete' : 'Delete profile'}</button>}
                            <button type="button" className="btn ghost" onClick={() => setDlg(null)}>Cancel</button>
                        </div>
                        {dlg.main && <p className="note" style={{ marginTop: 10 }}>The main profile can’t be deleted.</p>}
                    </form>
                </div>
            )}
        </div>
    );
}
