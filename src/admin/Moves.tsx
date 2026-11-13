import { useState } from 'react';
import { orderBy } from 'firebase/firestore';
import { call } from '../lib/firebase';
import { useLeague } from '../lib/league';
import { useCol } from '../lib/hooks';
import { SectionHeader, Empty, Field, useAction, TeamChip, Tabs } from '../components/ui';
import { fmtAgo, ms } from '../lib/format';
import type { RequestDoc } from '../lib/types';

export function AdminTransfers() {
  const L = useLeague();
  const { run, busy } = useAction();
  const { data: transfers } = useCol<{ playerId: string; fromTeamId: string | null; toTeamId: string; startingRound: number; source: string; createdAt: { toMillis(): number } }>(
    L.seasonId ? `seasons/${L.seasonId}/transfers` : null, orderBy('createdAt', 'desc'));
  const nextRound = Math.max(0, ...L.matches.filter((m) => m.status === 'played' && m.stage === 'league').map((m) => m.round)) + 1;
  const [f, setF] = useState({ playerId: '', toTeamId: '', startingRound: nextRound });
  const from = f.playerId ? Object.entries(L.rosters).find(([, ps]) => ps.includes(f.playerId))?.[0] : undefined;
  return (
    <>
      <SectionHeader eyebrow={`Moves · ${L.season?.name || ''}`} title="Mid-season" accent="transfers" />
      <div className="card stack">
        <div className="form-grid">
          <Field label="Player"><select className="select" value={f.playerId} onChange={(e) => setF({ ...f, playerId: e.target.value })}><option value="">—</option>{L.playerList.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
          <Field label="From"><div style={{ padding: '8px 0' }}><TeamChip team={from ? L.teams[from] : null} /></div></Field>
          <Field label="To"><select className="select" value={f.toTeamId} onChange={(e) => setF({ ...f, toTeamId: e.target.value })}><option value="">Free agent (release)</option>{L.teamList.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
          <Field label="Starting round"><input className="input" type="number" min={1} value={f.startingRound} onChange={(e) => setF({ ...f, startingRound: Number(e.target.value) })} /></Field>
        </div>
        <button className="btn primary" disabled={busy || !f.playerId || f.toTeamId === from} onClick={() => run(() => call('transferPlayer')({ seasonId: L.seasonId, ...f, toTeamId: f.toTeamId || null }), 'Transfer complete — roster, team and Discord roles updated')}>Confirm transfer</button>
      </div>
      <div className="card flush table-wrap">
        <table className="data">
          <thead><tr><th>Player</th><th>From</th><th>To</th><th className="n">From round</th><th>Source</th><th>When</th></tr></thead>
          <tbody>{transfers.map((t) => (
            <tr key={t.id}><td>{L.players[t.playerId]?.name}</td><td><TeamChip team={t.fromTeamId ? L.teams[t.fromTeamId] : null} /></td><td><TeamChip team={L.teams[t.toTeamId]} /></td>
              <td className="n">{t.startingRound}</td><td className="small">{t.source}</td><td className="small muted">{fmtAgo(t.createdAt)}</td></tr>
          ))}</tbody>
        </table>
        {!transfers.length && <Empty>No transfers this season.</Empty>}
      </div>
    </>
  );
}

export function AdminRequests() {
  const L = useLeague();
  const { run, busy } = useAction();
  const [tab, setTab] = useState<'pending' | 'all'>('pending');
  const { data: reqs } = useCol<RequestDoc>('requests', orderBy('createdAt', 'desc'));
  const list = reqs.filter((r) => tab === 'all' || r.status === 'pending').sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
  const decide = (id: string, decision: 'accept' | 'decline') => run(() => call<unknown, { removedFixtures?: number }>('decideRequest')({ requestId: id, decision }),
    (res) => decision === 'decline' ? 'Declined' : res?.removedFixtures ? `Accepted — ${res.removedFixtures} unplayed fixtures removed` : 'Accepted');
  return (
    <>
      <SectionHeader eyebrow="Moves" title="Team & season" accent="requests" />
      <Tabs tabs={[{ key: 'pending', label: `Pending (${reqs.filter((r) => r.status === 'pending').length})` }, { key: 'all', label: 'All' }]} active={tab} onChange={setTab} />
      <div className="card flush table-wrap">
        <table className="data">
          <thead><tr><th>Player</th><th>Type</th><th>From</th><th>To</th><th>Message</th><th>Status</th><th /></tr></thead>
          <tbody>{list.map((r) => (
            <tr key={r.id}>
              <td>{L.players[r.playerId]?.name}</td>
              <td className="small">{r.type.replace('_', ' ')}{(r.type === 'join_season' || r.type === 'leave_season') && <><br /><span className="muted">{L.seasons.find((x) => x.id === r.seasonId)?.name || r.seasonId}</span></>}</td>
              <td>{r.type === 'leave_season' ? <TeamChip team={r.teamId ? L.teams[r.teamId] : null} /> : r.type === 'join_season' ? '—' : <TeamChip team={r.fromTeamId ? L.teams[r.fromTeamId] : null} />}</td>
              <td>{r.type === 'new_team' ? <span className="row"><i style={{ display: 'inline-block', width: 12, height: 12, background: r.color, borderRadius: 3 }} />{r.teamName}</span>
                : r.type === 'join_season' ? <TeamChip team={r.teamId ? L.teams[r.teamId] : null} />
                : r.type === 'leave_season' ? <span className="small muted">leaves season</span>
                : <TeamChip team={r.toTeamId ? L.teams[r.toTeamId] : null} />}</td>
              <td className="small" style={{ whiteSpace: 'normal', maxWidth: 240 }}>{r.message}</td>
              <td><span className={`badge ${r.status === 'accepted' ? 'ok' : r.status === 'pending' ? 'warn' : ''}`}>{r.status}</span></td>
              <td className="right">{r.status === 'pending' && <>
                <button className="btn sm primary" disabled={busy} onClick={() => decide(r.id, 'accept')}>Accept</button>{' '}
                <button className="btn sm" disabled={busy} onClick={() => decide(r.id, 'decline')}>Decline</button>
              </>}</td>
            </tr>
          ))}</tbody>
        </table>
        {!list.length && <Empty>No requests.</Empty>}
      </div>
    </>
  );
}
