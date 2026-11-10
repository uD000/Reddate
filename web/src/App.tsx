import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useBackClose } from './back';
import { engine, Json } from './engine';
import { Auth } from './screens/Auth';
import { Home } from './screens/Home';
import { Search } from './screens/Search';
import { TitlePage } from './screens/Title';
import { Watch } from './screens/Watch';
import { Profiles } from './screens/Profiles';
import { Addons } from './screens/Addons';
import { Account } from './screens/Account';
import { LinkTv } from './screens/LinkTv';
import { Onboarding } from './screens/Onboarding';
import { IHome, ISearch, IUsers, IUser, IBack, Wordmark } from './icons';

// "Who's watching?" asks once per browser, not once per tab: a pick is remembered for 12 hours here, so a new tab,
// a shared link or a reload goes straight in. Signing out forgets it.
const PICK_TTL = 12 * 60 * 60 * 1000;
export function pickedRecently(): boolean {
    try {
        if (sessionStorage.getItem('rd-picked') === '1') return true;
        const at = Number(localStorage.getItem('rd-picked-at') || 0);
        return at > 0 && Date.now() - at < PICK_TTL;
    } catch { return false; }
}
export function markPicked() {
    try { sessionStorage.setItem('rd-picked', '1'); localStorage.setItem('rd-picked-at', String(Date.now())); } catch { /* fine */ }
}
export function forgetPicked() {
    try { sessionStorage.removeItem('rd-picked'); localStorage.removeItem('rd-picked-at'); } catch { /* fine */ }
}

export interface AppState { signedIn: boolean; accounts: boolean; profile: string; profileId: string; profiles: { id: string; name: string; main?: boolean }[]; inRoom: boolean; roomCode: string; invite: string; nowPlaying: string; isGuest: boolean; hostName: string }
interface Ctx {
    path: string; go: (to: string, replace?: boolean) => void; back: (fallback?: string) => void; toast: (m: string) => void;
    st: AppState; refresh: () => Promise<AppState | null>; metaCache: Map<string, Json>;
}
const C = createContext<Ctx>(null as any);
export const useApp = () => useContext(C);

// On the TV host the app lives under /app (the landing page owns "/"); on its own host it owns "/".
const HOME: string = (window as any).__RD_HOME || '/';
const stripBase = (p: string) => (HOME === '/app' && (p === '/app' || p.startsWith('/app/') || p.startsWith('/app?')) ? p.slice(4) || '/' : p);

const EMPTY: AppState = { signedIn: false, accounts: false, profile: '', profileId: '', profiles: [], inRoom: false, roomCode: '', invite: '', nowPlaying: '', isGuest: false, hostName: '' };

export function App() {
    const [path, setPath] = useState(location.pathname + location.search);
    const [st, setSt] = useState<AppState>(EMPTY);
    const [booted, setBooted] = useState(false);
    const [menu, setMenu] = useState(false);
    // The top bar lies over the picture at the top of Home and title pages, and turns solid once you scroll.
    const [scrolled, setScrolled] = useState(false);
    useEffect(() => {
        const on = () => setScrolled(window.scrollY > 24);
        on(); window.addEventListener('scroll', on, { passive: true });
        return () => window.removeEventListener('scroll', on);
    }, []);
    // A QR code from a TV (/?link=CODE) or from the TV's Addons / Account screens (/?open=addons).
    const [link, setLink] = useState<string>(() => {
        const q = new URLSearchParams(location.search);
        const c = (q.get('link') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (c) { try { sessionStorage.setItem('rd-link', c); } catch { /* fine */ } }
        try { return sessionStorage.getItem('rd-link') || ''; } catch { return c; }
    });
    useEffect(() => {
        const q = new URLSearchParams(location.search);
        const open = q.get('open');
        if (q.has('link') || open) {
            const dest = open === 'addons' ? '/addons' : open === 'account' || open === 'devices' ? '/account' : open === 'profiles' ? '/profiles' : HOME;
            history.replaceState(null, '', dest);
            setPath(dest);
        }
    }, []);
    const [toastMsg, setToastMsg] = useState('');
    const [picked, setPicked] = useState<boolean>(pickedRecently);
    const metaCache = useRef(new Map<string, Json>()).current;
    const [invite, setInvite] = useState<null | { roomId: string; from: string; device: string; title: string }>(null);
    const toastT = useRef<number>();

    const go = useCallback((to: string, replace = false) => {
        const href = to === '/' ? HOME : to.startsWith('/?') ? HOME + to.slice(1) : to;
        // `rd` counts the app's own steps, so "back" knows whether there's a page of ours to return to.
        const depth = (history.state && history.state.rd) || 0;
        if (replace) history.replaceState({ rd: depth }, '', href); else history.pushState({ rd: depth + 1 }, '', href);
        setPath(href);
        window.scrollTo(0, 0);
    }, []);
    const back = useCallback((fallback = '/') => {
        if (history.state && history.state.rd > 0) history.back(); else go(fallback, true);
    }, [go]);
    useEffect(() => {
        const on = () => setPath(location.pathname + location.search);
        window.addEventListener('popstate', on);
        return () => window.removeEventListener('popstate', on);
    }, []);

    const toast = useCallback((m: string) => {
        setToastMsg(m);
        window.clearTimeout(toastT.current);
        toastT.current = window.setTimeout(() => setToastMsg(''), 3500);
    }, []);

    const refresh = useCallback(async () => {
        try {
            const s = (await engine.call('state', {}, 10000)) as AppState;
            setSt(s);
            return s;
        } catch { return null; }
    }, []);

    // Boot: wait for the engine, then know whether someone is signed in.
    useEffect(() => {
        let dead = false;
        (async () => {
            await engine.start();
            let s: AppState | null = null;
            for (let i = 0; i < 40 && !dead; i++) {
                s = await refresh();
                if (s && s.accounts) break;
                await new Promise(r => setTimeout(r, 250));
            }
            if (dead) return;
            // A reload in the middle of a party: go straight back into that room (it waits for us).
            let back = '';
            try { back = sessionStorage.getItem('rd-room') || ''; sessionStorage.removeItem('rd-room'); } catch { /* fine */ }
            if (back && s && s.signedIn && !s.inRoom && !/^\/join\//.test(stripBase(location.pathname))) {
                try {
                    const result = await engine.call<{ ok: boolean }>('joinCode', { code: back }, 25000);
                    if (dead) return;
                    if (result?.ok) { await refresh(); go('/watch', true); }
                    else go('/join/' + back, true);
                } catch { if (!dead) go('/join/' + back, true); }
            }
            setBooted(true);
        })();
        return () => { dead = true; };
    }, [refresh]);

    // Keep the room / profile facts fresh, and react to what the engine tells us.
    useEffect(() => {
        const t = window.setInterval(refresh, 5000);
        const off = engine.on(ev => {
            if (ev.type === 'account' || ev.type === 'home-changed') refresh();
            if (ev.type === 'notice' && typeof ev.text === 'string') toast(ev.text);
            if (ev.type === 'invite' && typeof ev.roomId === 'string') setInvite({ roomId: ev.roomId, from: String(ev.from || 'Someone'), device: String(ev.device || ''), title: String(ev.title || '') });
        });
        engine.onOpen = () => { go('/watch'); };
        return () => { window.clearInterval(t); off(); };
    }, [refresh, go]);

    // Remember the room for this tab while we're in it; forget it once we've left.
    useEffect(() => {
        try {
            if (st.inRoom && st.roomCode) sessionStorage.setItem('rd-room', st.roomCode.replace(/[^A-Z0-9]/gi, ''));
            else if (booted && !st.inRoom) sessionStorage.removeItem('rd-room');
        } catch { /* fine */ }
    }, [st.inRoom, st.roomCode, booted]);

    useBackClose(menu, () => setMenu(false));
    const ctx = useMemo(() => ({ path, go, back, toast, st, refresh, metaCache }), [path, go, back, toast, st, refresh, metaCache]);

    if (!booted) return <div className="auth"><div style={{ textAlign: 'center' }}><div className="wordmark"><Wordmark size={40} /></div><div className="spin" style={{ marginTop: 18 }} /></div></div>;

    const pathname = stripBase(path.split('?')[0]) || '/';
    const joinMatch = /^\/join\/([A-Za-z0-9-]+)/.exec(pathname);
    // An invite from another of your screens can arrive on any screen (even "Who's watching?"): show it everywhere.
    const inviteModal = invite && (
        <div className="modal invite" role="alertdialog" aria-modal="true" aria-labelledby="inv-h">
            <div className="card big">
                <div className="kicker">Watch party</div>
                <h2 id="inv-h" style={{ margin: '6px 0 8px' }}>{invite.from} invites you</h2>
                <p className="note" style={{ fontSize: 17, marginBottom: 22 }}>
                    {invite.title ? <>to watch <b style={{ color: 'var(--ink)' }}>{invite.title}</b> together</> : 'to watch together'}
                    {invite.device ? <> · from {invite.device}</> : null}
                </p>
                <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
                    <button className="btn primary lg" autoFocus onClick={async () => { const i = invite; setInvite(null); try { markPicked(); localStorage.setItem('rd-onboarded', '1'); sessionStorage.removeItem('rd-new'); } catch { /* fine */ } setPicked(true); try { await engine.call('answerInvite', { roomId: i.roomId, accept: true }); } catch { /* fine */ } go('/watch'); }}>Join the party</button>
                    <button className="btn ghost lg" onClick={() => { const i = invite; setInvite(null); engine.call('answerInvite', { roomId: i.roomId, accept: false }).catch(() => {}); }}>Not now</button>
                </div>
            </div>
        </div>
    );

    if (!st.signedIn) return <C.Provider value={ctx}><Auth joinCode={joinMatch ? joinMatch[1] : ''} tvCode={link} />{toastMsg && <div className="toast">{toastMsg}</div>}</C.Provider>;
    // A brand-new account: a few short steps, each skippable, with a way straight into the app.
    const isNew = (() => { try { return sessionStorage.getItem('rd-new') === '1' && localStorage.getItem('rd-onboarded') !== '1'; } catch { return false; } })();
    if (isNew && !link && !joinMatch && !st.inRoom && pathname !== '/watch') {
        return <C.Provider value={ctx}>{inviteModal}<Onboarding onFinish={(to) => { try { sessionStorage.removeItem('rd-new'); localStorage.setItem('rd-onboarded', '1'); markPicked(); } catch { /* fine */ } setPicked(true); go(to || '/', true); }} />{toastMsg && <div className="toast">{toastMsg}</div>}</C.Provider>;
    }
    if (link) return <C.Provider value={ctx}>{inviteModal}<LinkTv code={link} onDone={() => { try { sessionStorage.removeItem('rd-link'); } catch { /* fine */ } setLink(''); go('/', true); }} />{toastMsg && <div className="toast">{toastMsg}</div>}</C.Provider>;
    if (!picked && st.profiles.length > 1 && !joinMatch) {
        return <C.Provider value={ctx}><Profiles first onDone={() => { try { markPicked(); } catch { /* fine */ } setPicked(true); }} />{inviteModal}</C.Provider>;
    }

    let page: React.ReactNode;
    let nav = '';
    if (pathname === '/watch' || pathname === '/join') { page = <Watch />; nav = 'party'; }
    else if (joinMatch) { page = <Watch joinCode={joinMatch[1]} />; nav = 'party'; }
    else if (pathname === '/search') { page = <Search />; nav = 'search'; }
    else if (pathname.startsWith('/title/')) { const [, , type, ...rest] = pathname.split('/'); page = <TitlePage key={path} type={decodeURIComponent(type)} id={decodeURIComponent(rest.join('/'))} />; nav = 'home'; }
    else if (pathname === '/link') { page = <Home />; nav = 'home'; } // YouTube & links was removed: old links land on Home
    else if (pathname === '/addons') { page = <Addons />; nav = 'addons'; }
    else if (pathname === '/profiles') { page = <Profiles />; nav = 'account'; }
    else if (pathname === '/account') { page = <Account />; nav = 'account'; }
    else { page = <Home />; nav = 'home'; }

    // The party lobby keeps the app's top bar (with Back) and tabs; only the player itself is full screen (see Watch).
    const full = false;
    return (
        <C.Provider value={ctx}>
            <div className={'shell' + (pathname === '/' || pathname === '/link' || pathname.startsWith('/title/') ? ' over' : '') + (scrolled ? ' scrolled' : '')}>
                {!full && (
                    <header className="topbar">
                        {pathname !== '/' && <button className="back" aria-label="Back" onClick={() => back()}><IBack width={18} height={18} /><span className="back-label">Back</span></button>}
                        <a className="brand" href="/" onClick={e => { e.preventDefault(); go('/'); }}><Wordmark size={28} /></a>
                        <nav className="nav" aria-label="Main">
                            <a href="/" className={nav === 'home' ? 'on' : ''} onClick={e => { e.preventDefault(); go('/'); }}><IHome />Home</a>
                            <a href="/search" className={nav === 'search' ? 'on' : ''} onClick={e => { e.preventDefault(); go('/search'); }}><ISearch />Search</a>
                            <a href="/addons" className={nav === 'addons' ? 'on' : ''} onClick={e => { e.preventDefault(); go('/addons'); }}>Addons</a>
                            <a href="/watch" className={nav === 'party' ? 'on' : ''} onClick={e => { e.preventDefault(); go('/watch'); }}><IUsers />{st.inRoom ? 'In a party' : 'Join a party'}</a>
                        </nav>
                        <div className="menu-wrap">
                            <button className="avatar" aria-label="Profiles and account" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(m => !m)}>{(st.profile || '?').slice(0, 1).toUpperCase()}</button>
                            {menu && (
                                <>
                                    <div className="menu-scrim" onClick={() => setMenu(false)} />
                                    <div className="menu" role="menu">
                                        <div className="menu-h">Profiles</div>
                                        {st.profiles.map(p => (
                                            <button key={p.id} role="menuitem" className={p.id === st.profileId ? 'on' : ''} onClick={async () => { setMenu(false); if (p.id !== st.profileId) { await engine.call('chooseProfile', { id: p.id }).catch(() => {}); await refresh(); go('/', true); } }}>
                                                <span className="avatar sm">{p.name.slice(0, 1).toUpperCase()}</span>{p.name}{p.id === st.profileId ? ' · now' : ''}
                                            </button>
                                        ))}
                                        <div className="menu-sep" />
                                        <button role="menuitem" onClick={() => { setMenu(false); go('/profiles'); }}>Edit profiles</button>
                                        <button role="menuitem" onClick={() => { setMenu(false); go('/account'); }}>Account</button>
                                    </div>
                                </>
                            )}
                        </div>
                    </header>
                )}
                {page}
                {!full && (
                    <nav className="tabs" aria-label="Main">
                        <a href="/" className={nav === 'home' ? 'on' : ''} onClick={e => { e.preventDefault(); go('/'); }}><IHome />Home</a>
                        <a href="/search" className={nav === 'search' ? 'on' : ''} onClick={e => { e.preventDefault(); go('/search'); }}><ISearch />Search</a>
                        <a href="/watch" className={nav === 'party' ? 'on' : ''} onClick={e => { e.preventDefault(); go('/watch'); }}><IUsers />Party</a>
                        <a href="/account" className={nav === 'account' || nav === 'addons' ? 'on' : ''} onClick={e => { e.preventDefault(); go('/account'); }}><IUser />You</a>
                    </nav>
                )}
                {toastMsg && <div className="toast" role="status">{toastMsg}</div>}
                {inviteModal}
            </div>
        </C.Provider>
    );
}
