import { rosterLimit, useLeague } from '../lib/league';
import { Crest, Avatar, StatCard, Empty, FormPills, PageHeader, Flag } from '../components/ui';
import { JoinTeamButton, CaptainPanel } from '../components/player';
import { ResultCard, FixtureCard } from '../components/league';
import { useModal } from '../modals/ModalContext';
import { ordinal, POSITION_LABELS } from '../lib/types';
import { signed } from '../lib/format';

export default function TeamPage({ id }: { id: string }) {
  const L = useLeague();
  const { open } = useModal();
  const t = L.teams[id];
  if (!t) {
    return (
      <>
        <PageHeader eyebrow="Team" title="Not" accent="found" />
        <main className="page">{L.ready ? <Empty>This team doesn't exist. <a href="#table">Back to the table →</a></Empty> : <Empty>Loading…</Empty>}</main>
      </>
    );
  }
  const row = L.standings?.rows.find((r) => r.teamId === id);
  const ts = L.teamStats?.rows.find((r) => r.teamId === id);
  // Between seasons (or before a club joins one) show the players currently on the club.
  const seasonRoster = L.rosters[id];
  const roster = seasonRoster ? seasonRoster.map((pid) => L.players[pid]).filter(Boolean) : L.playerList.filter((p) => p.currentTeamId === id);
  const ms = L.matches.filter((m) => m.homeTeamId === id || m.awayTeamId === id);
  const results = ms.filter((m) => m.status === 'played').sort((a, b) => b.round - a.round).slice(0, 6);
  const upcoming = ms.filter((m) => m.status !== 'played' && m.status !== 'void').sort((a, b) => a.round - b.round).slice(0, 6);
  const isCaptain = L.isAdmin || (!!L.myPlayer && !!t.captainIds?.includes(L.myPlayer.id));
  const cap = rosterLimit(L.general);
  const stat = (pid: string) => L.playerStats?.rows.find((r) => r.playerId === pid);

  return (
    <>
      <PageHeader
        eyebrow={row ? <>{L.season?.name} · {ordinal(row.pos)} · {row.pts} pts</> : L.season?.name || 'Team'}
        title={t.name}
        subtitle={t.shortName || undefined}
        right={<span className="row wrap">{row && <FormPills form={row.form} />}<JoinTeamButton teamId={id} /></span>}>
        <Crest team={t} size="lg" />
      </PageHeader>
      <main className="page">
        {row && (
          <div className="stats-row">
            <StatCard value={`${row.w}-${row.d}-${row.l}`} label="W-D-L" /><StatCard value={signed(row.gd)} label="goal diff" />
            <StatCard value={ts?.gf ?? row.gf} label="goals for" /><StatCard value={ts?.ga ?? row.ga} label="goals against" />
            <StatCard value={ts?.cleanSheets ?? 0} label="clean sheets" />
          </div>
        )}
        <div className="home-grid">
          <div className="home-main">
            <section>
              <div className="eyebrow">Next up</div>
              <div className="card-list auto">{upcoming.length ? upcoming.map((m) => <FixtureCard key={m.id} m={m} />) : <Empty>Nothing scheduled.</Empty>}</div>
            </section>
            <section>
              <div className="eyebrow">Recent results</div>
              <div className="card-list auto">{results.length ? results.map((m) => <ResultCard key={m.id} m={m} />) : <Empty>No results yet.</Empty>}</div>
            </section>
          </div>
          <aside className="home-side card">
            <h3>Roster{seasonRoster && L.season ? ` · ${L.season.name}` : ''}{cap > 0 && <span className="small muted" style={{ fontWeight: 400 }}> · {roster.length} / {cap}</span>}</h3>
            {!roster.length ? <Empty>No roster registered.</Empty> : roster.map((p) => (
              <div key={p.id} className="leader" style={{ gridTemplateColumns: '28px 1fr auto' }} onClick={() => open({ kind: 'player', id: p.id })}>
                <Avatar src={p.avatarUrl} name={p.name} />
                <div><span className="name" style={{ fontWeight: 600 }}>{p.name}</span><Flag country={p.country} />{t.captainIds?.includes(p.id) && <span className="badge ok" style={{ marginLeft: 6 }}>C</span>}<div className="small muted">{POSITION_LABELS[p.position]}</div></div>
                <span className="small muted">{stat(p.id) ? `${stat(p.id)!.goals}G ${stat(p.id)!.assists}A` : ''}</span>
              </div>
            ))}
          </aside>
        </div>
        {isCaptain && <CaptainPanel teamId={id} />}
      </main>
    </>
  );
}
