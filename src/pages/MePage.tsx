import { useEffect, useState } from 'react';
import { useLeague } from '../lib/league';
import { call } from '../lib/firebase';
import { PageHeader, TeamChip, Avatar, Field, Flag, CountrySelect, useAction } from '../components/ui';
import { SignInButton } from '../components/Shell';
import { signOutUser } from '../lib/discordAuth';
import { POSITIONS, POSITION_LABELS } from '../lib/types';
import type { Position } from '../lib/types';

/** #me is only for signing in and first-time player setup. Players who already have one go to their profile. */
export default function MePage() {
  const L = useLeague();
  const signedIn = !!L.authUser && !!L.me;
  const [title, accent] = !signedIn ? ['Join the', 'league'] : ['Set up your', 'player'];
  useEffect(() => {
    if (L.myPlayer) location.replace(`#player/${encodeURIComponent(L.myPlayer.id)}`);
  }, [L.myPlayer]);
  const header = <PageHeader eyebrow={L.me ? `Signed in as ${L.me.displayName}` : 'Your account'} title={title} accent={accent} />;
  let body;
  if (!L.authReady || (L.authUser && (!L.meReady || !L.ready))) body = <div className="empty">Loading…</div>;
  else if (!L.authUser) body = (
    <div className="card center stack" style={{ alignItems: 'center' }}>
      <p className="muted">Every league player signs in with Discord to set up their player and register for a team.</p>
      <SignInButton big />
    </div>
  );
  else if (!L.me) body = L.meError
    ? <div className="card center stack" style={{ alignItems: 'center' }}>
        <p>Couldn't set up your account: {L.meError}</p>
        <div className="row"><button className="btn" onClick={() => location.reload()}>Try again</button><button className="btn ghost" onClick={() => signOutUser()}>Sign out</button></div>
      </div>
    : <div className="empty">Setting up your account…</div>;
  else body = L.myPlayer ? <div className="empty">Opening your profile…</div> : <Setup />;
  return <>{header}<main className="page">{body}</main></>;
}

// ---------- First sign-in: player setup ----------
function Setup() {
  const L = useLeague();
  const { run, busy } = useAction();
  const [name, setName] = useState(L.me?.displayName || '');
  const [position, setPosition] = useState<Position>('UNSURE');
  const [country, setCountry] = useState('');
  // An admin may already have linked a player record to this Discord account.
  const linked = L.playerList.find((p) => p.discordId && p.discordId === L.me?.discordId && (!p.ownerUid || p.ownerUid === L.authUser?.uid));
  const setup = (data: { name?: string; position?: Position; country?: string }) => run(async () => {
    const r = await call<typeof data, { playerId: string; created: boolean }>('setupPlayer')(data);
    location.hash = `#player/${encodeURIComponent(r.playerId)}`;
    return r;
  }, (r) => (r.created ? 'Player created. You are a free agent.' : 'Welcome back!'));
  if (linked) {
    return (
      <div className="card stack" style={{ maxWidth: 560 }}>
        <h3>We found your player</h3>
        <div className="row"><Avatar src={linked.avatarUrl} name={linked.name} /><b className="grow">{linked.name}</b><TeamChip team={linked.currentTeamId ? L.teams[linked.currentTeamId] : null} /></div>
        <p className="small muted">An admin already linked this player to your Discord account, so your stats carry over.</p>
        <button className="btn primary" disabled={busy} onClick={() => setup({})}>Continue as {linked.name}</button>
      </div>
    );
  }
  return (
    <div className="card stack" style={{ maxWidth: 560 }}>
      <p className="muted" style={{ margin: 0 }}>Your player is tied to your Discord account. You'll need it to register for a team.</p>
      <Field label="Player name"><input className="input" value={name} maxLength={32} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Position">
        <select className="select" value={position} onChange={(e) => setPosition(e.target.value as Position)}>
          {POSITIONS.map((p) => <option key={p} value={p}>{POSITION_LABELS[p]}</option>)}
        </select>
      </Field>
      <Field label={<>Country <Flag country={country} /></>}><CountrySelect value={country} onChange={setCountry} /></Field>
      <p className="small muted">New players start as free agents. Afterwards, open a team's page from <a href="#teams">Teams</a> to ask to join.
        Played before under another account? Ask an admin to link your old player to this Discord account.</p>
      <button className="btn primary" disabled={busy || name.trim().length < 2} onClick={() => setup({ name: name.trim(), position, country })}>Create my player</button>
    </div>
  );
}
