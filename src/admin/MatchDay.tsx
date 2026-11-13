import { useMemo, useState } from 'react';
import { collection, doc, Timestamp } from 'firebase/firestore';
import { addDoc, deleteDoc, updateDoc } from '../lib/db';
import { call, db } from '../lib/firebase';
import { useLeague } from '../lib/league';
import { useCol, go } from '../lib/hooks';
import { SectionHeader, Empty, Crest, Field, useAction, Confirm } from '../components/ui';
import { fmtDateTime, toLocalInput } from '../lib/format';
import { matchweekOf, summarizeSeries, groupBy, DEFAULT_SEASON, STAT_KEYS, STAT_LABELS } from '../lib/types';
import type { Game, MatchDoc, PlayerGameStats, Cup } from '../lib/types';
import { afterMatchChange, newMatchDoc, stamp } from './util';

const STAT_FIELDS = STAT_KEYS;
const blankLine = (teamId: string): PlayerGameStats => ({ teamId, goals: 0, assists: 0, interceptions: 0, passes: 0, saves: 0 });
const matchLabel = (m: MatchDoc, name: (id: string) => string) =>
  `${m.stage === 'league' ? `R${m.round}` : m.stage.toUpperCase()} · ${name(m.homeTeamId)} vs ${name(m.awayTeamId)}${m.status === 'played' ? ` (${m.seriesHome}–${m.seriesAway})` : ''}`;

// ======================= Add Result =======================
export function AddResult({ params }: { params: URLSearchParams }) {
  const L = useLeague();
  const cupId = params.get('cup') || '';
  const matchId = params.get('match') || '';
  const { data: cupMatches } = useCol<MatchDoc>(cupId ? `cups/${cupId}/matches` : null);
  const pool = cupId ? cupMatches : L.matches;
  const name = (id: string) => L.teams[id]?.name || '?';
  const sorted = [...pool].sort((a, b) => a.round - b.round);
  const m = pool.find((x) => x.id === matchId);
  return (
    <>
      <SectionHeader eyebrow={cupId ? 'Cup result' : `Match Day · ${L.season?.name || ''}`} title="Add" accent="result" />
      {L.season?.locked && !cupId && <div className="card"><b>🔒 This season is locked.</b> Unlock it in Season settings to edit results.</div>}
      <Field label="Match">
        <select className="select" value={matchId} onChange={(e) => go(`admin/result?${cupId ? `cup=${cupId}&` : ''}match=${e.target.value}`)}>
          <option value="">Pick a fixture…</option>
          {sorted.filter((x) => x.status !== 'void').map((x) => <option key={x.id} value={x.id}>{matchLabel(x, name)}</option>)}
        </select>
      </Field>
      {m ? <ResultEditor key={m.id} m={m} path={cupId ? `cups/${cupId}/matches/${m.id}` : `seasons/${L.seasonId}/matches/${m.id}`} /> : <Empty>Pick a match to enter the series game by game.</Empty>}
    </>
  );
}

function ResultEditor({ m, path }: { m: MatchDoc; path: string }) {
  const L = useLeague();
  const { run, busy } = useAction();
  const fmt = L.season?.seriesFormat || DEFAULT_SEASON.seriesFormat;
  const [games, setGames] = useState<Game[]>(m.games?.length ? m.games : [{ n: 1, homeGoals: 0, awayGoals: 0, playerStats: {} }]);
  const [mvp, setMvp] = useState(m.mvpPlayerId || '');
  const [date, setDate] = useState(toLocalInput(m.matchDate || m.kickoffAt) || toLocalInput(Timestamp.now()));
  const [openGame, setOpenGame] = useState(0);
  const [extra, setExtra] = useState<Record<string, string>>({});
  const sum = summarizeSeries(games, fmt);
  const rosterOf = (teamId: string) => [...new Set([...(L.rosters[teamId] || []), ...games.flatMap((g) => Object.entries(g.playerStats || {}).filter(([, s]) => s.teamId === teamId).map(([p]) => p)), ...(extra[teamId] ? [extra[teamId]] : [])])];
  const sides = [m.homeTeamId, m.awayTeamId];
  const allPlayers = [...new Set(sides.flatMap(rosterOf))];

  const setGame = (i: number, patch: Partial<Game>) => setGames((gs) => gs.map((g, j) => (j === i ? { ...g, ...patch } : g)));
  const setStat = (i: number, pid: string, teamId: string, key: keyof PlayerGameStats, value: number | boolean | undefined) =>
    setGames((gs) => gs.map((g, j) => {
      if (j !== i) return g;
      const ps = { ...(g.playerStats || {}) };
      ps[pid] = { ...(ps[pid] || { teamId }), teamId, [key]: value };
      return { ...g, playerStats: ps };
    }));
  const togglePlayed = (i: number, pid: string, teamId: string, on: boolean) => setGames((gs) => gs.map((g, j) => {
    if (j !== i) return g;
    const ps = { ...(g.playerStats || {}) };
    if (on) ps[pid] = blankLine(teamId); else delete ps[pid];
    return { ...g, playerStats: ps };
  }));
  const addGame = () => {
    const prev = games[games.length - 1];
    const lineup = Object.fromEntries(Object.entries(prev?.playerStats || {}).map(([p, s]) => [p, blankLine(s.teamId)]));
    setGames([...games, { n: games.length + 1, homeGoals: 0, awayGoals: 0, playerStats: lineup }]);
    setOpenGame(games.length);
  };
  const save = () => run(async () => {
    const clean = games.map((g, i) => ({ ...g, n: i + 1, sidesSwapped: !!g.sidesSwapped, playerStats: g.playerStats || {} }));
    const s = summarizeSeries(clean, fmt);
    await updateDoc(doc(db, path), {
      games: clean, status: 'played', mvpPlayerId: mvp || null,
      matchDate: Timestamp.fromDate(new Date(date)),
      seriesHome: s.seriesHome, seriesAway: s.seriesAway, goalsHome: s.goalsHome, goalsAway: s.goalsAway,
      winnerTeamId: s.winnerSide === 'home' ? m.homeTeamId : s.winnerSide === 'away' ? m.awayTeamId : null,
      ...stamp(),
    });
    await afterMatchChange(path);
  }, 'Result saved — standings, brackets and records updated');

  return (
    <div className="stack">
      <div className="card">
        <div className="teams" style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', alignItems: 'center', gap: 12 }}>
          <div className="row"><Crest team={L.teams[m.homeTeamId]} />{L.teams[m.homeTeamId]?.name}</div>
          <div className="num" style={{ fontFamily: 'var(--font-display)', fontSize: 36, fontWeight: 800 }}>{sum.seriesHome}–{sum.seriesAway}</div>
          <div className="row" style={{ justifyContent: 'flex-end' }}>{L.teams[m.awayTeamId]?.name}<Crest team={L.teams[m.awayTeamId]} /></div>
        </div>
        <div className="center small" style={{ marginTop: 6 }}>
          {sum.complete ? <span className="badge ok">Series complete</span> : <span className="badge warn">Game {games.length + 1} needed ({fmt.rule}, {fmt.minGames}–{fmt.maxGames} games)</span>}
          {m.verification === 'check' && <span className="badge warn" style={{ marginLeft: 6 }}>⚠️ {(m.verificationIssues || []).join('; ')}</span>}
        </div>
      </div>

      {games.map((g, i) => (
        <div key={i} className="card">
          <div className="row wrap">
            <b style={{ cursor: 'pointer' }} onClick={() => setOpenGame(openGame === i ? -1 : i)}>{openGame === i ? '▾' : '▸'} Game {i + 1}</b>
            <span className="grow" />
            <span className="small muted">{L.teams[m.homeTeamId]?.shortName}</span>
            <input className="input num-in" type="number" min={0} value={g.homeGoals} onChange={(e) => setGame(i, { homeGoals: Number(e.target.value) })} />
            <span>–</span>
            <input className="input num-in" type="number" min={0} value={g.awayGoals} onChange={(e) => setGame(i, { awayGoals: Number(e.target.value) })} />
            <span className="small muted">{L.teams[m.awayTeamId]?.shortName}</span>
            <label className="check small"><input type="checkbox" checked={!!g.sidesSwapped} onChange={(e) => setGame(i, { sidesSwapped: e.target.checked })} />sides swapped</label>
            <button className="btn sm ghost" onClick={() => setGames(games.filter((_, j) => j !== i))}>✕</button>
          </div>
          {openGame === i && sides.map((teamId) => (
            <div key={teamId} className="table-wrap" style={{ marginTop: 10 }}>
              <div className="eyebrow">{L.teams[teamId]?.name}</div>
              <table className="data">
                <thead><tr><th>Played</th><th>Player</th>{STAT_FIELDS.map((f) => <th key={f} className="n">{STAT_LABELS[f]}</th>)}<th className="n">MVP</th></tr></thead>
                <tbody>{rosterOf(teamId).map((pid) => {
                  const s = g.playerStats?.[pid];
                  const on = !!s && s.teamId === teamId;
                  return (
                    <tr key={pid}>
                      <td><input type="checkbox" checked={on} onChange={(e) => togglePlayed(i, pid, teamId, e.target.checked)} /></td>
                      <td>{L.players[pid]?.name || pid}</td>
                      {STAT_FIELDS.map((f) => (
                        <td key={f} className="n"><input className="input num-in" type="number" min={0} step={1} disabled={!on}
                          value={on ? Number(s?.[f] ?? '') || '' : ''} onChange={(e) => setStat(i, pid, teamId, f, e.target.value === '' ? undefined : Number(e.target.value))} /></td>
                      ))}
                      <td className="n"><input type="checkbox" disabled={!on} checked={!!s?.mvp} onChange={(e) => setStat(i, pid, teamId, 'mvp', e.target.checked)} /></td>
                    </tr>
                  );
                })}</tbody>
              </table>
              <select className="select" style={{ width: 'auto', marginTop: 6 }} value="" onChange={(e) => setExtra({ ...extra, [teamId]: e.target.value })}>
                <option value="">+ Add a sub / ringer…</option>
                {L.playerList.filter((p) => !rosterOf(teamId).includes(p.id)).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          ))}
        </div>
      ))}
      <div className="row"><button className="btn" onClick={addGame} disabled={games.length >= fmt.maxGames}>+ Add game</button></div>

      <div className="card form-grid">
        <Field label="Series MVP">
          <select className="select" value={mvp} onChange={(e) => setMvp(e.target.value)}>
            <option value="">—</option>{allPlayers.map((p) => <option key={p} value={p}>{L.players[p]?.name}</option>)}
          </select>
        </Field>
        <Field label="Date played"><input className="input" type="datetime-local" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
      </div>
      <div className="row wrap">
        <button className="btn primary" disabled={busy || !games.length} onClick={save}>💾 Save result</button>
        {m.verification === 'check' && <button className="btn" disabled={busy} onClick={() => run(async () => { await updateDoc(doc(db, path), { verifiedOverride: true, verification: 'ok', ...stamp() }); await afterMatchChange(path); }, 'Marked verified')}>✅ Mark verified</button>}
        {m.status === 'played' && <Confirm text="Clear this result? Standings and brackets roll back." onYes={() => run(async () => { await updateDoc(doc(db, path), { status: m.kickoffAt ? 'agreed' : 'scheduled', games: [], mvpPlayerId: null, winnerTeamId: null, verifiedOverride: false, ...stamp() }); await afterMatchChange(path); }, 'Result cleared')}>Clear result</Confirm>}
      </div>
    </div>
  );
}

// ======================= Fixtures =======================
export function AdminFixtures() {
  const L = useLeague();
  const { run, busy } = useAction();
  const [gen, setGen] = useState({ double: true, mode: 'replace' as 'replace' | 'topUp', force: false });
  const [add, setAdd] = useState({ home: '', away: '', round: 1 });
  const { data: weeksDocs } = useCol<{ publishedAt?: unknown; completedAt?: unknown; note?: string }>(L.seasonId ? `seasons/${L.seasonId}/matchweeks` : null);
  const league = L.matches.filter((m) => m.stage === 'league');
  const byWeek = useMemo(() => groupBy(league, (m) => String(m.matchweek || 0)), [league]);
  const name = (id: string) => L.teams[id]?.shortName || L.teams[id]?.name || '?';
  const [kick, setKick] = useState<Record<string, string>>({});
  const rpw = L.season?.roundsPerWeek || 2;

  return (
    <>
      <SectionHeader eyebrow="Match Day" title="Fixtures &" accent="schedule" />
      <div className="grid-2">
        <div className="card stack">
          <h3>⚙️ Generate schedule</h3>
          <p className="small muted">Circle-method round-robin over confirmed entries. Odd counts get byes; divisions share round numbers. Top-up adds missing pairings for late teams in new rounds.</p>
          <div className="row wrap">
            <label className="check"><input type="radio" checked={gen.double} onChange={() => setGen({ ...gen, double: true })} />Double</label>
            <label className="check"><input type="radio" checked={!gen.double} onChange={() => setGen({ ...gen, double: false })} />Single</label>
            <select className="select" style={{ width: 'auto' }} value={gen.mode} onChange={(e) => setGen({ ...gen, mode: e.target.value as 'replace' | 'topUp' })}>
              <option value="replace">Replace unplayed</option><option value="topUp">Top up (late teams)</option>
            </select>
            {gen.mode === 'replace' && <label className="check small"><input type="checkbox" checked={gen.force} onChange={(e) => setGen({ ...gen, force: e.target.checked })} />keep results & force</label>}
          </div>
          <button className="btn primary" disabled={busy || !L.seasonId} onClick={() => run(() => call<unknown, { created: number; rounds: number }>('generateSchedule')({ seasonId: L.seasonId, ...gen }), (r) => `Created ${r.created} fixtures over ${r.rounds} rounds`)}>Generate</button>
        </div>
        <div className="card stack">
          <h3>➕ Add fixture</h3>
          <div className="form-grid">
            <Field label="Home"><select className="select" value={add.home} onChange={(e) => setAdd({ ...add, home: e.target.value })}><option value="">—</option>{L.teamList.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
            <Field label="Away"><select className="select" value={add.away} onChange={(e) => setAdd({ ...add, away: e.target.value })}><option value="">—</option>{L.teamList.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
            <Field label="Round"><input className="input" type="number" min={1} value={add.round} onChange={(e) => setAdd({ ...add, round: Number(e.target.value) })} /></Field>
          </div>
          <button className="btn" disabled={busy || !add.home || !add.away || add.home === add.away} onClick={() => run(async () => {
            const ref = await addDoc(collection(db, `seasons/${L.seasonId}/matches`), newMatchDoc({
              stage: 'league', round: add.round, matchweek: matchweekOf(add.round, rpw), homeTeamId: add.home, awayTeamId: add.away,
              divisionId: L.entries.find((e) => e.teamId === add.home)?.divisionId ?? null,
            }));
            await afterMatchChange(ref.path, false);
          }, 'Fixture added')}>Add fixture</button>
        </div>
      </div>

      {Object.entries(byWeek).sort((a, b) => Number(a[0]) - Number(b[0])).map(([w, ms]) => {
        const wd = weeksDocs.find((d) => d.id === w);
        return (
          <div key={w} className="card">
            <div className="row wrap" style={{ marginBottom: 8 }}>
              <h3 style={{ margin: 0 }}>Matchweek {w}</h3>
              {wd?.publishedAt ? <span className="badge ok">Threads published</span> : null}
              {wd?.completedAt ? <span className="badge">Completed</span> : null}
              <span className="grow" />
              <button className="btn sm" disabled={busy} onClick={() => run(() => call<unknown, { threads: number }>('publishMatchweek')({ seasonId: L.seasonId, weekNo: Number(w) }), (r) => `${r.threads} match threads ready`)}>📣 Publish threads</button>
              <button className="btn sm" disabled={busy} onClick={() => run(() => call<unknown, { renamed: number }>('completeMatchweek')({ seasonId: L.seasonId, weekNo: Number(w) }), (r) => `Renamed ${r.renamed} threads to COMPLETED`)}>🏁 Mark completed</button>
            </div>
            <div className="table-wrap"><table className="data">
              <thead><tr><th>R</th><th>Match</th><th>Status</th><th>Kickoff (local)</th><th /></tr></thead>
              <tbody>{ms.sort((a, b) => a.round - b.round).map((m) => (
                <tr key={m.id}>
                  <td>{m.round}</td>
                  <td>{name(m.homeTeamId)} vs {name(m.awayTeamId)}{m.discordThreadId ? ' 🧵' : ''}</td>
                  <td>{m.status === 'played' ? <b>{m.seriesHome}–{m.seriesAway}</b> : m.status}</td>
                  <td>
                    {m.status === 'played' ? fmtDateTime(m.matchDate) : (
                      <span className="row">
                        <input className="input" type="datetime-local" style={{ width: 200 }} value={kick[m.id] ?? toLocalInput(m.kickoffAt)} onChange={(e) => setKick({ ...kick, [m.id]: e.target.value })} />
                        <button className="btn sm" disabled={busy || kick[m.id] === undefined} onClick={() => run(async () => {
                          const p = `seasons/${L.seasonId}/matches/${m.id}`;
                          await updateDoc(doc(db, p), { kickoffAt: kick[m.id] ? Timestamp.fromDate(new Date(kick[m.id])) : null, status: kick[m.id] ? 'agreed' : 'scheduled', ...stamp() });
                          await afterMatchChange(p, false);
                        }, 'Kickoff saved')}>Set</button>
                      </span>
                    )}
                  </td>
                  <td className="right">
                    <a className="btn sm" href={`#admin/result?match=${m.id}`}>Result</a>{' '}
                    {m.status !== 'played' && <Confirm text="Delete this fixture?" onYes={() => run(async () => { const p = `seasons/${L.seasonId}/matches/${m.id}`; await deleteDoc(doc(db, p)); await afterMatchChange(p, false); }, 'Fixture deleted')}>✕</Confirm>}
                  </td>
                </tr>
              ))}</tbody>
            </table></div>
          </div>
        );
      })}
      {!league.length && <Empty>No league fixtures yet. Generate a schedule above.</Empty>}
    </>
  );
}

// ======================= Results =======================
export function AdminResults() {
  const L = useLeague();
  const { run } = useAction();
  const [onlyCheck, setOnlyCheck] = useState(false);
  const { data: cups } = useCol<Cup>('cups');
  const played = L.matches.filter((m) => m.status === 'played' && (!onlyCheck || m.verification === 'check'))
    .sort((a, b) => (b.updatedAt?.toMillis() || 0) - (a.updatedAt?.toMillis() || 0));
  const name = (id: string) => L.teams[id]?.name || '?';
  return (
    <>
      <SectionHeader eyebrow="Match Day" title="Results" accent="log" />
      <div className="row wrap">
        <label className="check"><input type="checkbox" checked={onlyCheck} onChange={(e) => setOnlyCheck(e.target.checked)} />Only flagged for review</label>
        <span className="grow" />
        <button className="btn sm" onClick={() => run(() => call('recomputeAll')({ seasonId: L.seasonId }), 'Recomputed standings, stats and brackets')}>♻️ Recompute season</button>
      </div>
      <div className="card flush table-wrap">
        <table className="data">
          <thead><tr><th>Stage</th><th>Match</th><th className="n">Series</th><th className="n">Goals</th><th>Verification</th><th>Updated</th><th /></tr></thead>
          <tbody>{played.map((m) => (
            <tr key={m.id}>
              <td>{m.stage === 'league' ? `R${m.round}` : m.stage}</td>
              <td>{name(m.homeTeamId)} vs {name(m.awayTeamId)}</td>
              <td className="n pts">{m.seriesHome}–{m.seriesAway}</td>
              <td className="n">{m.goalsHome}–{m.goalsAway}</td>
              <td>{m.verification === 'check' ? <span className="badge warn" title={(m.verificationIssues || []).join('; ')}>check</span> : <span className="badge ok">ok</span>}</td>
              <td className="small muted">{fmtDateTime(m.updatedAt)}</td>
              <td className="right"><a className="btn sm" href={`#admin/result?match=${m.id}`}>Edit</a></td>
            </tr>
          ))}</tbody>
        </table>
        {!played.length && <Empty>No results yet.</Empty>}
      </div>
      {cups.filter((c) => !c.archived).map((c) => <CupResults key={c.id} cup={c} />)}
    </>
  );
}

function CupResults({ cup }: { cup: Cup }) {
  const L = useLeague();
  const { data: ms } = useCol<MatchDoc>(`cups/${cup.id}/matches`);
  return (
    <div className="card">
      <h3>🏆 {cup.name}</h3>
      {!ms.length && <Empty>No cup matches yet.</Empty>}
      {ms.sort((a, b) => a.round - b.round).map((m) => (
        <div key={m.id} className="row small" style={{ padding: '4px 0' }}>
          <span className="grow">{m.bracketSlot} · {L.teams[m.homeTeamId]?.name} vs {L.teams[m.awayTeamId]?.name} {m.status === 'played' ? <b>{m.seriesHome}–{m.seriesAway}</b> : ''}</span>
          <a className="btn sm" href={`#admin/result?cup=${cup.id}&match=${m.id}`}>{m.status === 'played' ? 'Edit' : 'Enter result'}</a>
        </div>
      ))}
    </div>
  );
}
