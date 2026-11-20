import { useEffect, useState } from 'react';
import { doc, getDoc } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { useLeague } from '../lib/league';
import { useDoc } from '../lib/hooks';
import { Avatar, Crest, TeamChip, StatCard, Empty, PageHeader, Flag } from '../components/ui';
import { ProfileEditor, MyRequests, WrappedViewer } from '../components/player';
import { findCountry } from '../lib/countries';
import { useModal, playerHref, teamHref } from '../modals/ModalContext';
import { pct, ms } from '../lib/format';
import { POSITION_LABELS } from '../lib/types';
import type { PlayerStatRow, RecordsDoc } from '../lib/types';
import { Scale, ScrollText, Star } from 'lucide-react';

export default function PlayerPage({ id }: { id: string }) {
  const L = useLeague();
  const { open } = useModal();
  const p = L.players[id];
  const { data: records } = useDoc<RecordsDoc>('derived/records');
  const isMe = !!L.myPlayer && L.myPlayer.id === id && !!L.authUser;
  const { data: wrapped } = useDoc<{ slides: { kind: string; title: string; value: string | number; caption: string }[] }>(isMe && L.seasonId ? `seasons/${L.seasonId}/wrapped/${id}` : null);
  const wrappedOpen = !!wrapped?.slides?.length && (L.season?.status === 'complete' || ms(L.season?.wrappedOpenUntil) > Date.now());
  const [history, setHistory] = useState<{ seasonId: string; row: PlayerStatRow }[]>([]);
  useEffect(() => {
    Promise.all(L.seasons.map(async (s) => {
      const d = await getDoc(doc(db, `seasons/${s.id}/derived/playerStats`));
      const row = (d.data()?.rows as PlayerStatRow[] | undefined)?.find((r) => r.playerId === id);
      return row ? { seasonId: s.id, row } : null;
    })).then((x) => setHistory(x.filter(Boolean) as { seasonId: string; row: PlayerStatRow }[]));
  }, [id, L.seasons]);

  if (!p) {
    return (
      <>
        <PageHeader eyebrow="Player" title="Not" accent="found" />
        <main className="page">{L.ready ? <Empty>This player doesn't exist. <a href="#stats/players">Browse players →</a></Empty> : <Empty>Loading…</Empty>}</main>
      </>
    );
  }
  if (p.mergedInto) {
    return (
      <>
        <PageHeader eyebrow="Player" title={p.name} />
        <main className="page"><Empty>This player was merged into another record. <a href={playerHref(p.mergedInto)}>Open the kept record →</a></Empty></main>
      </>
    );
  }

  const s = L.playerStats?.rows.find((r) => r.playerId === id);
  const career = records?.career?.[id];
  const team = p.currentTeamId ? L.teams[p.currentTeamId] : null;
  const recent = L.matches.filter((m) => m.status === 'played' && m.games?.some((g) => g.playerStats?.[id]))
    .sort((a, b) => (b.matchDate?.toMillis() || 0) - (a.matchDate?.toMillis() || 0)).slice(0, 10);
  const held = records?.records.filter((r) => r.holderType === 'player' && r.holderId === id) || [];
  const [first, ...rest] = p.name.split(' ');

  return (
    <>
      <PageHeader
        eyebrow="Player"
        title={first} accent={rest.join(' ') || undefined}
        meta={<>
          <span className={`role-badge role-${p.position}`}>{POSITION_LABELS[p.position]}</span>
          {findCountry(p.country) && <span className="row" style={{ gap: 8 }}><Flag country={p.country} />{findCountry(p.country)!.name}</span>}
          <a className="player-team" href={team ? teamHref(team.id) : '#teams'}>
            {team ? <><span className="player-team-label">Plays for</span><Crest team={team} size="sm" /><span>{team.name}</span></> : <span className="muted">Free agent</span>}
          </a>
        </>}
        right={<span className="row">
          <button className="btn" onClick={() => open({ kind: 'compare', ids: [id] })}><Scale size={15} aria-hidden />Compare</button>
        </span>}>
        <Avatar src={p.avatarUrl} name={p.name} size="lg" />
      </PageHeader>
      <main className="page">
        {p.bio && <p style={{ margin: 0 }}>{p.bio}</p>}
        {isMe && <ProfileEditor />}
        {held.length > 0 && <div className="row wrap">{held.map((r) => <span key={r.key} className="badge warn"><ScrollText size={12} aria-hidden />{r.label}: {r.value}</span>)}</div>}

        <div className="grid-2">
          <section>
            <div className="eyebrow">{L.season?.name || 'This season'}</div>
            <div className="stats-row">
              <StatCard value={s?.gp ?? 0} label="games" /><StatCard value={s?.goals ?? 0} label="goals" /><StatCard value={s?.assists ?? 0} label="assists" />
              <StatCard value={s?.saves ?? 0} label="saves" /><StatCard value={s?.mvps ?? 0} label="MVPs" /><StatCard value={pct(s?.adv.winRate)} label="win rate" />
            </div>
          </section>
          <section>
            <div className="eyebrow">Career</div>
            {career ? (
              <div className="stats-row">
                <StatCard value={career.gp} label="games" /><StatCard value={career.goals} label="goals" /><StatCard value={career.assists} label="assists" />
                <StatCard value={career.saves} label="saves" /><StatCard value={career.mvps} label="MVPs" />
              </div>
            ) : <Empty>No career stats yet.</Empty>}
          </section>
        </div>

        <div className="grid-2">
          <section className="card flush">
            <div style={{ padding: 16, paddingBottom: 0 }}><h3>Season by season</h3></div>
            {!history.length ? <Empty>No seasons played yet.</Empty> : (
              <div className="table-wrap">
                <table className="data"><thead><tr><th>Season</th><th>Team</th><th className="n">GP</th><th className="n">G</th><th className="n">A</th><th className="n">SV</th><th className="n">MVP</th></tr></thead>
                  <tbody>{history.map(({ seasonId, row }) => (
                    <tr key={seasonId}><td>{L.seasons.find((x) => x.id === seasonId)?.name}</td><td><TeamChip team={row.teamId ? L.teams[row.teamId] : null} /></td>
                      <td className="n">{row.gp}</td><td className="n">{row.goals}</td><td className="n">{row.assists}</td><td className="n">{row.saves}</td><td className="n">{row.mvps}</td></tr>
                  ))}</tbody></table>
              </div>
            )}
          </section>
          <section className="card">
            <h3>Recent series</h3>
            {!recent.length ? <Empty>No series played this season.</Empty> : recent.map((m) => {
              const tot = m.games.reduce((acc, g) => { const x = g.playerStats?.[id]; return x ? { g: acc.g + (x.goals || 0), a: acc.a + (x.assists || 0) } : acc; }, { g: 0, a: 0 });
              return (
                <div key={m.id} className="leader" style={{ gridTemplateColumns: '1fr auto' }} onClick={() => open({ kind: 'match', id: m.id })}>
                  <span className="ellipsis">{L.teams[m.homeTeamId]?.shortName} {m.seriesHome}–{m.seriesAway} {L.teams[m.awayTeamId]?.shortName}</span>
                  <span className="small">{tot.g}G {tot.a}A{m.mvpPlayerId === id ? <Star size={12} aria-label="MVP" style={{ marginLeft: 4 }} /> : ''}</span>
                </div>
              );
            })}
          </section>
        </div>
        {isMe && wrappedOpen && <WrappedViewer slides={wrapped!.slides} />}
        {isMe && <MyRequests />}
      </main>
    </>
  );
}
