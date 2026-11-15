import { useEffect, useMemo, useState } from 'react';
import { collection, getDocs } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { useLeague } from '../lib/league';
import { PageHeader, Avatar, Flag, TeamChip, Skeleton, Empty } from '../components/ui';
import { useModal } from '../modals/ModalContext';
import { SortTable, Col } from './StatsPage';
import { findCountry } from '../lib/countries';
import { POSITION_LABELS } from '../lib/types';
import type { Award, Player } from '../lib/types';

const AWARD_EMOJI: Record<string, string> = { champion: '🏆', golden_boot: '👟', playmaker: '🎯', golden_glove: '🧤', mvp: '⭐', custom: '🏅' };
interface Row { player: Player; awards: (Award & { seasonName: string })[] }

/** #players: a directory of every player (position, current team, country), with their awards under the name. */
export default function PlayersPage() {
  const L = useLeague();
  const { open } = useModal();
  const [awards, setAwards] = useState<(Award & { seasonName: string })[]>([]);
  const [q, setQ] = useState('');
  const [team, setTeam] = useState('');

  useEffect(() => {
    Promise.all(L.seasons.map(async (s) => (await getDocs(collection(db, `seasons/${s.id}/awards`))).docs
      .map((d) => ({ id: d.id, ...d.data(), seasonName: s.name }) as Award & { seasonName: string })))
      .then((x) => setAwards(x.flat().filter((a) => a.recipientType === 'player')))
      .catch(() => setAwards([]));
  }, [L.seasons]);

  const rows = useMemo<Row[]>(() => {
    const s = q.trim().toLowerCase();
    return L.playerList
      .filter((p) => !s || p.name.toLowerCase().includes(s))
      .filter((p) => !team || (team === '_fa' ? !p.currentTeamId : p.currentTeamId === team))
      .map((p) => ({ player: p, awards: awards.filter((a) => a.recipientId === p.id) }));
  }, [L.playerList, awards, q, team]);

  const cols: Col<Row>[] = [
    {
      key: 'name', label: 'Player', get: (r) => r.player.name.toLowerCase(),
      render: (r) => (
        <div style={{ minWidth: 200 }}>
          <span className="row"><Avatar src={r.player.avatarUrl} name={r.player.name} size="sm" /><b>{r.player.name}</b></span>
          {r.awards.length > 0 && (
            <div className="player-awards">{r.awards.map((a) => <span key={a.seasonName + a.id} className="badge warn" title={a.value != null ? String(a.value) : undefined}>{AWARD_EMOJI[a.type] || '🏅'} {a.label} · {a.seasonName}</span>)}</div>
          )}
        </div>
      ),
    },
    { key: 'position', label: 'Position', get: (r) => POSITION_LABELS[r.player.position] || '', render: (r) => POSITION_LABELS[r.player.position] || '—' },
    { key: 'team', label: 'Team', get: (r) => (r.player.currentTeamId ? L.teams[r.player.currentTeamId]?.name : '') || '', render: (r) => <TeamChip team={r.player.currentTeamId ? L.teams[r.player.currentTeamId] : null} /> },
    {
      key: 'country', label: 'Country', get: (r) => findCountry(r.player.country)?.name || '',
      render: (r) => findCountry(r.player.country) ? <span className="row" style={{ gap: 0 }}><Flag country={r.player.country} /><span style={{ marginLeft: 8 }}>{findCountry(r.player.country)!.name}</span></span> : <span className="muted">—</span>,
    },
  ];

  return (
    <>
      <PageHeader eyebrow={`${L.playerList.length} players`} title="Players" />
      <main className="page">
        <div className="row wrap" style={{ marginBottom: 'var(--s3)' }}>
          <input className="input" style={{ maxWidth: 260 }} placeholder="Search players…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select className="select" style={{ width: 'auto' }} value={team} onChange={(e) => setTeam(e.target.value)}>
            <option value="">All teams</option><option value="_fa">Free agents</option>
            {L.teamList.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <span className="grow" />
          <span className="small muted">Click a column to sort</span>
        </div>
        {!L.ready ? <Skeleton /> : !rows.length ? <Empty>No players match.</Empty> : (
          <div className="card flush">
            <SortTable rows={rows} cols={cols} initial="name" initialDir={1} rowKey={(r) => r.player.id} onRow={(r) => open({ kind: 'player', id: r.player.id })} />
          </div>
        )}
      </main>
    </>
  );
}
