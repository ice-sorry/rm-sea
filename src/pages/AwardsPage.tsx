import { useLeague } from '../lib/league';
import { loadAwards, useCached } from '../lib/cache';
import { useDoc, go } from '../lib/hooks';
import { PageHeader, Tabs, Empty, Crest, Avatar, Skeleton, Flag } from '../components/ui';
import { useModal } from '../modals/ModalContext';
import type { RecordsDoc } from '../lib/types';
import { Award as AwardBadge, ScrollText, Trophy } from 'lucide-react';
import { AwardIcon } from '../components/icons';

type Tab = 'trophies' | 'records' | 'milestones';

export default function AwardsPage({ sub }: { sub: string }) {
  const tab = (['trophies', 'records', 'milestones'].includes(sub) ? sub : 'trophies') as Tab;
  return (
    <>
    <PageHeader eyebrow="Hall of fame" title="Awards &" accent="records" />
    <main className="page">
      <section>
        <Tabs tabs={[{ key: 'trophies', label: 'Trophies', icon: Trophy }, { key: 'records', label: 'Records', icon: ScrollText }, { key: 'milestones', label: 'Milestones', icon: AwardBadge }]}
          active={tab} onChange={(k) => go(`awards/${k}`)} />
        {tab === 'trophies' && <Trophies />}
        {tab === 'records' && <Records />}
        {tab === 'milestones' && <Milestones />}
      </section>
    </main>
    </>
  );
}

function Trophies() {
  const L = useLeague();
  const { open } = useModal();
  const ids = L.seasons.map((s) => s.id);
  const bySeason = useCached(`awards|${ids.join(',')}`, () => loadAwards(ids, L.isAdmin ? 0 : undefined), L.isAdmin ? 0 : undefined);
  if (!bySeason) return <Skeleton />;
  const any = Object.values(bySeason).some((a) => a.length);
  if (!any) return <Empty>No trophies awarded yet.</Empty>;
  return (
    <div className="stack" style={{ gap: 24 }}>
      {L.seasons.filter((s) => bySeason[s.id]?.length).map((s) => (
        <div key={s.id}>
          <div className="eyebrow">{s.name}</div>
          <div className="grid-3">
            {bySeason[s.id].map((a) => {
              const isP = a.recipientType === 'player';
              const p = isP ? L.players[a.recipientId] : null, t = !isP ? L.teams[a.recipientId] : null;
              return (
                <div key={a.id} className="card row" style={{ cursor: 'pointer' }} onClick={() => open(isP ? { kind: 'player', id: a.recipientId } : { kind: 'team', id: a.recipientId })}>
                  <span style={{ fontSize: 32, display: 'inline-flex' }}><AwardIcon type={a.type} size={32} /></span>
                  <div className="grow">
                    <div className="eyebrow" style={{ margin: 0 }}>{a.label}</div>
                    <div className="row">{isP ? <Avatar src={p?.avatarUrl} name={p?.name} size="sm" /> : <Crest team={t} size="sm" />}<b>{p?.name || t?.name || 'Unknown'}</b>{p && <Flag country={p.country} />}</div>
                    {a.value != null && a.value !== '' && <div className="small muted">{a.value}</div>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function Records() {
  const L = useLeague();
  const { open } = useModal();
  const { data, loading } = useDoc<RecordsDoc>('derived/records');
  if (loading) return <Skeleton />;
  if (!data?.records?.length) return <Empty>Records are computed automatically from match data.</Empty>;
  return (
    <div className="card flush table-wrap">
      <table className="data">
        <thead><tr><th>Record</th><th className="n">Value</th><th>Holder</th><th>Season</th></tr></thead>
        <tbody>{data.records.map((r) => {
          const isP = r.holderType === 'player';
          return (
            <tr key={r.key} className="click" onClick={() => (r.matchId && r.seasonId ? open({ kind: 'match', id: r.matchId, seasonId: r.seasonId }) : open(isP ? { kind: 'player', id: r.holderId } : { kind: 'team', id: r.holderId }))}>
              <td>{r.label}</td><td className="n pts">{r.value}</td>
              <td><span className="row">{isP ? <Avatar src={L.players[r.holderId]?.avatarUrl} name={L.players[r.holderId]?.name} size="sm" /> : <Crest team={L.teams[r.holderId]} size="sm" />}{isP ? L.players[r.holderId]?.name : L.teams[r.holderId]?.name}{isP && <Flag country={L.players[r.holderId]?.country} />}</span></td>
              <td className="muted">{r.seasonId ? L.seasons.find((s) => s.id === r.seasonId)?.name || r.seasonId : 'All-time'}</td>
            </tr>
          );
        })}</tbody>
      </table>
    </div>
  );
}

function Milestones() {
  const L = useLeague();
  const { open } = useModal();
  const { data } = useDoc<RecordsDoc>('derived/records');
  if (!data?.milestones?.length) return <Empty>No milestones reached yet — 25 career goals is the first.</Empty>;
  return (
    <div className="grid-3">
      {data.milestones.map((m) => (
        <div key={m.key + m.holderId} className="card row" style={{ cursor: 'pointer' }} onClick={() => open({ kind: 'player', id: m.holderId })}>
          <AwardBadge size={28} aria-hidden />
          <div><div className="eyebrow" style={{ margin: 0 }}>{m.label}</div><b>{L.players[m.holderId]?.name}</b><Flag country={L.players[m.holderId]?.country} /> <span className="muted small">({m.value})</span></div>
        </div>
      ))}
    </div>
  );
}
