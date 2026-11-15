import { useEffect, useMemo, useRef, useState } from 'react';
import { USE_EMULATORS } from '../lib/firebase';
import { useLeague } from '../lib/league';
import { go } from '../lib/hooks';
import { BRAND, NAV, SOCIALS } from '../lib/config';
import { startDiscordSignIn, signOutUser, devSignIn } from '../lib/discordAuth';
import { useModal, teamHref } from '../modals/ModalContext';
import { Avatar, Crest, Flag, useAction } from './ui';

export const DiscordIcon = () => <svg viewBox="0 0 24 24"><path d="M20.3 4.4A19.6 19.6 0 0 0 15.4 3l-.6 1.3a18 18 0 0 0-5.5 0L8.6 3a19.6 19.6 0 0 0-4.9 1.5C.6 9.1-.3 13.6.1 18.1a19.8 19.8 0 0 0 6 3l1.3-2.1a12.8 12.8 0 0 1-2-1l.5-.4a14.1 14.1 0 0 0 12.2 0l.5.4c-.6.4-1.3.7-2 1l1.3 2.1a19.7 19.7 0 0 0 6-3c.5-5.2-.8-9.7-3.6-13.7ZM8 15.4c-1.2 0-2.2-1.1-2.2-2.4S6.8 10.6 8 10.6s2.2 1.1 2.2 2.4-1 2.4-2.2 2.4Zm8 0c-1.2 0-2.2-1.1-2.2-2.4s1-2.4 2.2-2.4 2.2 1.1 2.2 2.4-1 2.4-2.2 2.4Z" /></svg>;
const YouTubeIcon = () => <svg viewBox="0 0 24 24"><path d="M23.5 6.2a3 3 0 0 0-2.1-2.1C19.5 3.6 12 3.6 12 3.6s-7.5 0-9.4.5A3 3 0 0 0 .5 6.2 31 31 0 0 0 0 12a31 31 0 0 0 .5 5.8 3 3 0 0 0 2.1 2.1c1.9.5 9.4.5 9.4.5s7.5 0 9.4-.5a3 3 0 0 0 2.1-2.1A31 31 0 0 0 24 12a31 31 0 0 0-.5-5.8ZM9.6 15.6V8.4l6.2 3.6-6.2 3.6Z" /></svg>;

export function TopBar({ route }: { route: string }) {
  const L = useLeague();
  const [searchOpen, setSearchOpen] = useState(false);
  const [menu, setMenu] = useState(false);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) { e.preventDefault(); setSearchOpen(true); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  return (
    <header className="topbar">
      <div className="topbar-inner">
        <a className="brand" href="#home"><img src={BRAND.logo} alt="" />{BRAND.short}</a>
        <nav className="nav" aria-label="Main">
          {NAV.map((n) => <a key={n.route} href={`#${n.route}`} className={route === n.route || (n.route === 'cups' && route === 'cup') ? 'active' : ''}>{n.emoji} {n.label}</a>)}
        </nav>
        <div className="grow" />
        <button className="search-btn" onClick={() => setSearchOpen(true)} aria-label="Search">🔍 <span className="hide-sm">Search</span> <kbd>/</kbd></button>
        {L.seasons.length > 0 && (
          <select className="season-select" value={L.seasonId || ''} onChange={(e) => L.setSeasonId(e.target.value)} aria-label="Season">
            {L.seasons.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        )}
        {SOCIALS.youtube && <a className="icon-btn" href={SOCIALS.youtube} target="_blank" rel="noreferrer" aria-label="YouTube"><YouTubeIcon /></a>}
        {L.authUser ? (
          <div style={{ position: 'relative' }}>
            <button className="icon-btn" style={{ width: 'auto' }} onClick={() => setMenu(!menu)} aria-label="Account"><Avatar src={L.me?.avatarUrl} name={L.me?.displayName} /></button>
            {menu && (
              <div className="overflow-menu" style={{ position: 'absolute', top: 40, right: 0, bottom: 'auto' }} onClick={() => setMenu(false)}>
                <div className="small muted" style={{ padding: '6px 12px' }}>{L.me?.displayName || L.authUser.uid}</div>
                {L.myPlayer && <a href={`#player/${encodeURIComponent(L.myPlayer.id)}`}>👤 My profile</a>}
                {L.myPlayer?.currentTeamId && L.teams[L.myPlayer.currentTeamId] && <a href={teamHref(L.myPlayer.currentTeamId)}>🛡️ My team</a>}
                {!L.myPlayer && <a href="#me">🙋 Set up my player</a>}
                {L.isAdmin && <a href="#admin">🛠️ Admin Panel</a>}
                <a href="#home" onClick={() => signOutUser()}>↪ Sign out</a>
              </div>
            )}
          </div>
        ) : (
          <SignInButton />
        )}
      </div>
      {searchOpen && <SearchPanel onClose={() => setSearchOpen(false)} />}
    </header>
  );
}

export function SignInButton({ big }: { big?: boolean }) {
  const [dev, setDev] = useState(false);
  const { run } = useAction();
  return (
    <span className="row" style={{ position: 'relative' }}>
      <button className={`btn discord ${big ? '' : 'sm'}`} onClick={startDiscordSignIn}>Sign in{big ? ' with Discord' : ''}</button>
      {USE_EMULATORS && <button className="btn sm ghost" onClick={() => setDev(!dev)} title="Emulator dev sign-in">🧪</button>}
      {dev && (
        <div className="overflow-menu" style={{ position: 'absolute', top: 40, right: 0, bottom: 'auto' }}>
          <a href="#admin" onClick={() => run(() => devSignIn('discord:100000000000000001', 'owner'))}>Dev owner</a>
          <a href="#me" onClick={() => run(() => devSignIn('discord:100000000000000002', 'user'))}>Dev user (no player)</a>
          <a href="#me" onClick={() => run(() => devSignIn('discord:100000000000000003', 'user'))}>Dev captain</a>
        </div>
      )}
    </span>
  );
}

export function MobileNav({ route }: { route: string }) {
  const [more, setMore] = useState(false);
  const { isAdmin, authUser, myPlayer, teams } = useLeague();
  const first = NAV.slice(0, 5), rest = NAV.slice(5);
  return (
    <>
      <nav className="bottomnav" aria-label="Mobile">
        {first.map((n) => <a key={n.route} href={`#${n.route}`} className={route === n.route ? 'active' : ''}><span>{n.emoji}</span><span>{n.label}</span></a>)}
        <button onClick={() => setMore(!more)}><span>☰</span><span>More</span></button>
      </nav>
      {more && (
        <div className="overflow-menu" onClick={() => setMore(false)}>
          {rest.map((n) => <a key={n.route} href={`#${n.route}`}>{n.emoji} {n.label}</a>)}
          <a href="#cup">🏆 Current cup</a>
          {myPlayer && <a href={`#player/${encodeURIComponent(myPlayer.id)}`}>👤 My profile</a>}
          {myPlayer?.currentTeamId && teams[myPlayer.currentTeamId] && <a href={teamHref(myPlayer.currentTeamId)}>🛡️ My team</a>}
          {authUser && !myPlayer && <a href="#me">🙋 Set up my player</a>}
          {isAdmin && <a href="#admin">🛠️ Admin Panel</a>}
        </div>
      )}
    </>
  );
}

function SearchPanel({ onClose }: { onClose: () => void }) {
  const { playerList, teamList, teams, players } = useLeague();
  const { open } = useModal();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const results = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    const ts = teamList.filter((t) => t.name.toLowerCase().includes(s) || t.shortName?.toLowerCase().includes(s)).slice(0, 5).map((t) => ({ kind: 'team' as const, id: t.id, label: t.name }));
    const ps = playerList.filter((p) => p.nameLower?.includes(s) || p.name.toLowerCase().includes(s)).slice(0, 10).map((p) => ({ kind: 'player' as const, id: p.id, label: p.name }));
    const pages = [['Table', 'table'], ['Teams', 'teams'], ['Players', 'players'], ['Statistics', 'stats'], ['Fixtures', 'fixtures'], ['Awards & Records', 'awards'], ['Cups', 'cups']]
      .filter(([l]) => l.toLowerCase().includes(s)).map(([l, r]) => ({ kind: 'page' as const, id: r, label: l }));
    return [...ts, ...ps, ...pages];
  }, [q, playerList, teamList]);
  const choose = (r: (typeof results)[number]) => {
    onClose();
    if (r.kind === 'page') go(r.id); else open({ kind: r.kind, id: r.id });
  };
  return (
    <>
      <div className="modal-backdrop" style={{ zIndex: 140 }} onClick={onClose} />
      <div className="search-panel" role="dialog">
        <input ref={ref} className="input" placeholder="Search players, teams, pages…" value={q}
          onChange={(e) => { setQ(e.target.value); setSel(0); }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            if (e.key === 'ArrowDown') setSel((s) => Math.min(results.length - 1, s + 1));
            if (e.key === 'ArrowUp') setSel((s) => Math.max(0, s - 1));
            if (e.key === 'Enter' && results[sel]) choose(results[sel]);
          }} />
        <div className="search-results">
          {q && !results.length && <div className="empty">No matches.</div>}
          {results.map((r, i) => (
            <div key={r.kind + r.id} className={`search-item ${i === sel ? 'sel' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => choose(r)}>
              {r.kind === 'team' ? <Crest team={teams[r.id]} size="sm" /> : <span>{r.kind === 'player' ? '👤' : '📄'}</span>}
              <span className="grow">{r.label}{r.kind === 'player' && <Flag country={players[r.id]?.country} />}</span><span className="small muted">{r.kind}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
