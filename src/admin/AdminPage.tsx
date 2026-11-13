import { ReactNode } from 'react';
import { where } from 'firebase/firestore';
import { useLeague } from '../lib/league';
import { useCol, useHash } from '../lib/hooks';
import { PageHeader, SectionHeader, Empty } from '../components/ui';
import { SignInButton } from '../components/Shell';
import type { RequestDoc } from '../lib/types';
import { AddResult, AdminFixtures, AdminResults } from './MatchDay';
import { AdminTeams, AdminPlayers, AdminRosters } from './League';
import { AdminSeason, AdminPlayoffs, AdminAwards } from './SeasonAdmin';
import { AdminTransfers, AdminRequests } from './Moves';
import { AdminRules, AdminRatings } from './Content';
import { AdminSettings } from './System';
import { AdminCups } from './Cups';

interface Screen { key: string; label: string; emoji: string; el: (p: { params: URLSearchParams }) => ReactNode }
const GROUPS: { group: string; screens: Screen[] }[] = [
  { group: 'Match Day', screens: [
    { key: 'result', label: 'Add Result', emoji: '➕', el: ({ params }) => <AddResult params={params} /> },
    { key: 'fixtures', label: 'Fixtures', emoji: '🗓️', el: () => <AdminFixtures /> },
    { key: 'results', label: 'Results', emoji: '✅', el: () => <AdminResults /> },
  ] },
  { group: 'League', screens: [
    { key: 'teams', label: 'Teams', emoji: '🛡️', el: () => <AdminTeams /> },
    { key: 'players', label: 'Players', emoji: '👤', el: () => <AdminPlayers /> },
    { key: 'rosters', label: 'Rosters', emoji: '📋', el: () => <AdminRosters /> },
  ] },
  { group: 'Season', screens: [
    { key: 'season', label: 'Season', emoji: '📅', el: () => <AdminSeason /> },
    { key: 'playoffs', label: 'Playoffs', emoji: '🏆', el: () => <AdminPlayoffs /> },
    { key: 'cups', label: 'Cups', emoji: '🥇', el: () => <AdminCups /> },
    { key: 'awards', label: 'Awards', emoji: '🏅', el: () => <AdminAwards /> },
  ] },
  { group: 'Moves', screens: [
    { key: 'transfers', label: 'Transfers', emoji: '🔁', el: () => <AdminTransfers /> },
    { key: 'requests', label: 'Requests', emoji: '📨', el: () => <AdminRequests /> },
  ] },
  { group: 'Content', screens: [
    { key: 'rules', label: 'Rules', emoji: '📜', el: () => <AdminRules /> },
    { key: 'ratings', label: 'Ratings', emoji: '⭐', el: () => <AdminRatings /> },
  ] },
  { group: 'System', screens: [
    { key: 'settings', label: 'Settings', emoji: '⚙️', el: ({ params }) => <AdminSettings tab={params.get('tab') || 'general'} /> },
  ] },
];

function useInbox() {
  const L = useLeague();
  const { data: pending } = useCol<RequestDoc>(L.isAdmin ? 'requests' : null, where('status', '==', 'pending'));
  const check = L.matches.filter((m) => m.status === 'played' && m.verification === 'check');
  const lastRound = Math.max(0, ...L.matches.filter((m) => m.status === 'played' && m.stage === 'league').map((m) => m.round));
  const missing = L.matches.filter((m) => m.stage === 'league' && m.status !== 'played' && m.status !== 'void' && m.round < lastRound);
  return { pending, check, missing, count: pending.length + check.length + missing.length };
}

export default function AdminPage({ sub }: { sub: string }) {
  const L = useLeague();
  const [, , params] = useHash();
  const inbox = useInbox();
  const header = <PageHeader eyebrow={L.season?.name || 'League admin'} title="Admin" accent="panel" />;
  if (!L.authReady) return <>{header}<main className="page"><div className="empty">Loading…</div></main></>;
  if (!L.authUser) return <>{header}<main className="page"><div className="card center"><p>Admins sign in with Discord.</p><SignInButton big /></div></main></>;
  if (!L.isAdmin) return <>{header}<main className="page"><Empty>The Admin Panel is for league admins. If you were just made admin, sign out and back in.</Empty></main></>;
  const key = sub.split('?')[0] || 'inbox';
  const screen = GROUPS.flatMap((g) => g.screens).find((s) => s.key === key);
  const link = (k: string, label: ReactNode, badge?: number) => (
    <a key={k} href={`#admin/${k}`} className={key === k ? 'active' : ''}>{label}{badge ? <span className="count">{badge}</span> : null}</a>
  );
  return (
    <>
    {header}
    <div className="admin">
      <aside className="admin-side">
        {link('inbox', '🔔 Needs you', inbox.count)}
        {GROUPS.map((g) => (
          <div key={g.group} style={{ display: 'contents' }}>
            <div className="group">{g.group}</div>
            {g.screens.map((s) => link(s.key, `${s.emoji} ${s.label}`, s.key === 'requests' ? inbox.pending.length : undefined))}
          </div>
        ))}
        <div className="signed-in">Signed in as <b>{L.me?.displayName || L.authUser.uid}</b> · {L.claims.role}<br />Season: {L.season?.name || '—'}</div>
      </aside>
      <div style={{ minWidth: 0 }}>
        <nav className="admin-nav-mobile">
          <a className={`btn sm ${key === 'inbox' ? 'primary' : ''}`} href="#admin/inbox">🔔 {inbox.count || ''}</a>
          {GROUPS.flatMap((g) => g.screens).map((s) => <a key={s.key} className={`btn sm ${key === s.key ? 'primary' : ''}`} href={`#admin/${s.key}`}>{s.emoji} {s.label}</a>)}
        </nav>
        <main className="admin-main">
          {key === 'inbox' ? <Inbox inbox={inbox} /> : screen ? screen.el({ params }) : <Empty>Unknown screen.</Empty>}
        </main>
      </div>
    </div>
    </>
  );
}

function Inbox({ inbox }: { inbox: ReturnType<typeof useInbox> }) {
  const L = useLeague();
  const t = (id: string) => L.teams[id]?.name || '?';
  return (
    <>
      <SectionHeader eyebrow="Admin" title="Needs" accent="you" />
      {!inbox.count && <Empty>All clear. ✅</Empty>}
      {inbox.pending.length > 0 && (
        <div className="card"><h3>📨 Pending requests ({inbox.pending.length})</h3>
          {inbox.pending.map((r) => <div key={r.id} className="row small" style={{ padding: '4px 0' }}><span className="grow">{L.players[r.playerId]?.name} · {r.type.replace('_', ' ')} {r.toTeamId ? `→ ${t(r.toTeamId)}` : r.teamName ? `“${r.teamName}”` : ''}</span></div>)}
          <a className="btn sm" href="#admin/requests">Review requests →</a>
        </div>
      )}
      {inbox.check.length > 0 && (
        <div className="card"><h3>⚠️ Unverified results ({inbox.check.length})</h3>
          {inbox.check.map((m) => (
            <div key={m.id} className="row small" style={{ padding: '4px 0' }}>
              <span className="grow">R{m.round} {t(m.homeTeamId)} {m.seriesHome}–{m.seriesAway} {t(m.awayTeamId)} <span className="muted">· {(m.verificationIssues || []).join('; ')}</span></span>
              <a className="btn sm" href={`#admin/result?match=${m.id}`}>Fix</a>
            </div>
          ))}
        </div>
      )}
      {inbox.missing.length > 0 && (
        <div className="card"><h3>⏰ Missing games ({inbox.missing.length})</h3>
          {inbox.missing.map((m) => (
            <div key={m.id} className="row small" style={{ padding: '4px 0' }}>
              <span className="grow">R{m.round} {t(m.homeTeamId)} vs {t(m.awayTeamId)} <span className="muted">· {m.status}</span></span>
              <a className="btn sm" href={`#admin/result?match=${m.id}`}>Enter result</a>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
