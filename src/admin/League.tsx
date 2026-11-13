import { useState } from 'react';
import { collection, doc, getDocs, serverTimestamp, arrayRemove, arrayUnion } from 'firebase/firestore';
import { addDoc, deleteDoc, setDoc, updateDoc, writeBatch } from '../lib/db';
import { call, db } from '../lib/firebase';
import { useLeague } from '../lib/league';
import { SectionHeader, Empty, Crest, Field, useAction, Confirm, Avatar, TeamChip, Flag, CountrySelect } from '../components/ui';
import { POSITIONS, POSITION_LABELS } from '../lib/types';
import type { Position, Team, Player } from '../lib/types';
import { actor, normalizeTeamName, syncTeamRoles } from './util';

// ======================= Teams =======================
const blankTeam = { name: '', shortName: '', color: '#1D8ADE', crestUrl: '', discordRoleId: '', captainIds: [] as string[], active: true };

export function AdminTeams() {
  const L = useLeague();
  const { run, busy } = useAction();
  const [edit, setEdit] = useState<(typeof blankTeam & { id?: string }) | null>(null);
  const save = () => run(async () => {
    const e = edit!;
    const data = {
      name: e.name.trim(), shortName: (e.shortName || e.name.slice(0, 4)).trim().toUpperCase(), nameNormalized: normalizeTeamName(e.name),
      color: e.color, crestUrl: e.crestUrl, discordRoleId: e.discordRoleId || null, captainIds: e.captainIds, active: e.active,
    };
    if (e.id) await updateDoc(doc(db, 'teams', e.id), data);
    else await addDoc(collection(db, 'teams'), { ...data, mergedInto: null });
    setEdit(null);
  }, 'Team saved');
  const roster = edit?.id ? (L.rosters[edit.id] || []) : [];

  return (
    <>
      <SectionHeader eyebrow="League" title="Teams" accent="& crests" right={<button className="btn primary" onClick={() => setEdit({ ...blankTeam })}>+ Add team</button>} />
      {edit && (
        <div className="card stack">
          <h3>{edit.id ? `Edit ${edit.name}` : 'New team'}</h3>
          <div className="form-grid">
            <Field label="Name"><input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="Short name (≤4)"><input className="input" maxLength={4} value={edit.shortName} onChange={(e) => setEdit({ ...edit, shortName: e.target.value })} /></Field>
            <Field label="Colour"><input type="color" value={edit.color} onChange={(e) => setEdit({ ...edit, color: e.target.value })} style={{ width: '100%', height: 38 }} /></Field>
            <Field label="Discord role ID"><input className="input" value={edit.discordRoleId || ''} onChange={(e) => setEdit({ ...edit, discordRoleId: e.target.value.trim() })} /></Field>
          </div>
          <div className="row wrap">
            <Crest team={{ ...edit, id: edit.id || 'new', nameNormalized: '', mergedInto: null, discordRoleId: null } as Team} size="lg" />
            <input className="input" style={{ maxWidth: 360 }} placeholder="Crest image URL (square PNG/WebP, e.g. from Discord or Imgur)" value={edit.crestUrl}
              onChange={(e) => setEdit({ ...edit, crestUrl: e.target.value.trim() })} />
            <label className="check"><input type="checkbox" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} />Active</label>
          </div>
          {edit.id && (
            <Field label="Captains (from current roster)">
              <div className="row wrap">{roster.map((pid) => (
                <label key={pid} className="check small"><input type="checkbox" checked={edit.captainIds.includes(pid)}
                  onChange={(e) => setEdit({ ...edit, captainIds: e.target.checked ? [...edit.captainIds, pid] : edit.captainIds.filter((x) => x !== pid) })} />{L.players[pid]?.name}</label>
              ))}{!roster.length && <span className="small muted">Add players to the roster first.</span>}</div>
            </Field>
          )}
          <div className="row"><button className="btn primary" disabled={busy || edit.name.trim().length < 2} onClick={save}>Save</button><button className="btn ghost" onClick={() => setEdit(null)}>Cancel</button></div>
        </div>
      )}
      <div className="card flush table-wrap">
        <table className="data">
          <thead><tr><th>Team</th><th>Short</th><th>Role</th><th>Captains</th><th>Roster</th><th>Active</th><th /></tr></thead>
          <tbody>{L.teamList.map((t) => (
            <tr key={t.id}>
              <td><span className="team-cell"><Crest team={t} size="sm" />{t.name}</span></td>
              <td>{t.shortName}</td>
              <td className="small muted">{t.discordRoleId || '—'}</td>
              <td className="small">{(t.captainIds || []).map((c) => L.players[c]?.name).join(', ') || '—'}</td>
              <td>{(L.rosters[t.id] || []).length}</td>
              <td>{t.active !== false ? '✅' : '—'}</td>
              <td className="right"><button className="btn sm" onClick={() => setEdit({ ...blankTeam, ...t, discordRoleId: t.discordRoleId || '', captainIds: t.captainIds || [] })}>Edit</button></td>
            </tr>
          ))}</tbody>
        </table>
        {!L.teamList.length && <Empty>No teams yet.</Empty>}
      </div>
    </>
  );
}

// ======================= Players =======================
export function AdminPlayers() {
  const L = useLeague();
  const { run, busy } = useAction();
  const [q, setQ] = useState('');
  const [form, setForm] = useState({ name: '', discordId: '', teamId: '', position: 'UNSURE' as Position });
  const [edit, setEdit] = useState<Player | null>(null);
  const [link, setLink] = useState<Record<string, string>>({});
  const list = L.playerList.filter((p) => !q || p.nameLower.includes(q.toLowerCase()) || p.discordId?.includes(q));

  const addPlayer = () => run(async () => {
    const name = form.name.trim();
    const ref = await addDoc(collection(db, 'players'), {
      name, nameLower: name.toLowerCase(), discordId: null, ownerUid: null, linkSource: null, position: form.position,
      currentTeamId: form.teamId || null, avatarUrl: '', bio: '', country: '', mergedInto: null, createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    });
    if (form.teamId && L.seasonId) await setDoc(doc(db, `seasons/${L.seasonId}/rosters/${form.teamId}`), { playerIds: arrayUnion(ref.id), updatedAt: serverTimestamp(), updatedBy: actor() }, { merge: true });
    if (form.discordId.trim()) await call('claimPlayer')({ playerId: ref.id, discordId: form.discordId.trim() });
    if (form.teamId) await syncTeamRoles(form.teamId);
    setForm({ name: '', discordId: '', teamId: '', position: 'UNSURE' });
  }, 'Player added');

  return (
    <>
      <SectionHeader eyebrow="League" title="Players" accent="& Discord links"
        right={<button className="btn sm" disabled={busy} onClick={() => run(() => call<unknown, { checked: number; updated: number }>('refreshAvatars')({}), (r) => `Checked ${r.checked}, updated ${r.updated} avatars`)}>🔄 Refresh avatars</button>} />
      <div className="card stack">
        <h3>+ Add player</h3>
        <div className="form-grid">
          <Field label="Name"><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Discord user ID (optional)"><input className="input" value={form.discordId} placeholder="e.g. 123456789012345678" onChange={(e) => setForm({ ...form, discordId: e.target.value })} /></Field>
          <Field label="Team"><select className="select" value={form.teamId} onChange={(e) => setForm({ ...form, teamId: e.target.value })}><option value="">Free agent</option>{L.teamList.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
          <Field label="Position"><select className="select" value={form.position} onChange={(e) => setForm({ ...form, position: e.target.value as Position })}>{POSITIONS.map((p) => <option key={p} value={p}>{POSITION_LABELS[p]}</option>)}</select></Field>
        </div>
        <button className="btn primary" disabled={busy || form.name.trim().length < 2} onClick={addPlayer}>Add player</button>
      </div>
      {edit && (
        <div className="card stack">
          <h3>Edit {edit.name}</h3>
          <div className="form-grid">
            <Field label="Name"><input className="input" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="Position"><select className="select" value={edit.position} onChange={(e) => setEdit({ ...edit, position: e.target.value as Position })}>{POSITIONS.map((p) => <option key={p} value={p}>{POSITION_LABELS[p]}</option>)}</select></Field>
            <Field label={<>Country <Flag country={edit.country} /></>}><CountrySelect value={edit.country || ''} onChange={(country) => setEdit({ ...edit, country })} /></Field>
          </div>
          <div className="row">
            <button className="btn primary" disabled={busy} onClick={() => run(async () => {
              await updateDoc(doc(db, 'players', edit.id), { name: edit.name.trim(), nameLower: edit.name.trim().toLowerCase(), position: edit.position, country: edit.country || '', updatedAt: serverTimestamp() });
              setEdit(null);
            }, 'Saved')}>Save</button>
            <button className="btn ghost" onClick={() => setEdit(null)}>Cancel</button>
            <span className="grow" />
            <Confirm text={`Delete ${edit.name}? Prefer Merge duplicates if this is a duplicate.`} onYes={() => run(async () => { await deleteDoc(doc(db, 'players', edit.id)); setEdit(null); }, 'Deleted')}>Delete</Confirm>
          </div>
        </div>
      )}
      <input className="input" placeholder="Search name or Discord ID…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="card flush table-wrap">
        <table className="data">
          <thead><tr><th>Player</th><th>Team</th><th>Position</th><th>Discord</th><th /></tr></thead>
          <tbody>{list.slice(0, 200).map((p) => (
            <tr key={p.id}>
              <td><span className="row"><Avatar src={p.avatarUrl} name={p.name} size="sm" />{p.name}<Flag country={p.country} /></span></td>
              <td><TeamChip team={p.currentTeamId ? L.teams[p.currentTeamId] : null} /></td>
              <td className="small">{POSITION_LABELS[p.position]}</td>
              <td className="small">
                {p.discordId ? <span className="row">{p.discordId} <span className="muted">({p.linkSource}{p.ownerUid ? ', claimed' : ''})</span>
                  <button className="btn sm ghost" disabled={busy} onClick={() => run(() => call('unclaimPlayer')({ playerId: p.id }), 'Unlinked')}>Unlink</button></span>
                  : <span className="row"><input className="input" style={{ width: 170 }} placeholder="Discord ID" value={link[p.id] || ''} onChange={(e) => setLink({ ...link, [p.id]: e.target.value })} />
                    <button className="btn sm" disabled={busy || !link[p.id]} onClick={() => run(() => call('claimPlayer')({ playerId: p.id, discordId: link[p.id].trim() }), 'Linked to Discord')}>Link</button></span>}
              </td>
              <td className="right"><button className="btn sm" onClick={() => setEdit(p)}>Edit</button></td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </>
  );
}

// ======================= Rosters =======================
export function AdminRosters() {
  const L = useLeague();
  const { run, busy } = useAction();
  const [teamId, setTeamId] = useState('');
  const [add, setAdd] = useState('');
  const [copyFrom, setCopyFrom] = useState('');
  const isCurrent = L.seasonId === L.general.currentSeasonId;
  const roster = teamId ? L.rosters[teamId] || [] : [];
  const onOtherRoster = (pid: string) => Object.entries(L.rosters).find(([t, ps]) => t !== teamId && ps.includes(pid))?.[0];

  const addToRoster = (pid: string) => run(async () => {
    const b = writeBatch(db);
    const other = onOtherRoster(pid);
    if (other) b.update(doc(db, `seasons/${L.seasonId}/rosters/${other}`), { playerIds: arrayRemove(pid), updatedAt: serverTimestamp(), updatedBy: actor() });
    b.set(doc(db, `seasons/${L.seasonId}/rosters/${teamId}`), { playerIds: arrayUnion(pid), updatedAt: serverTimestamp(), updatedBy: actor() }, { merge: true });
    if (isCurrent) b.update(doc(db, 'players', pid), { currentTeamId: teamId, updatedAt: serverTimestamp() });
    await b.commit();
    await syncTeamRoles(other, teamId);
    setAdd('');
  }, 'Added to roster');
  const remove = (pid: string) => run(async () => {
    const b = writeBatch(db);
    b.update(doc(db, `seasons/${L.seasonId}/rosters/${teamId}`), { playerIds: arrayRemove(pid), updatedAt: serverTimestamp(), updatedBy: actor() });
    if (isCurrent) b.update(doc(db, 'players', pid), { currentTeamId: null, updatedAt: serverTimestamp() });
    await b.commit();
    await syncTeamRoles(teamId);
  }, 'Removed');
  const copy = () => run(async () => {
    const src = await getDocs(collection(db, `seasons/${copyFrom}/rosters`));
    const b = writeBatch(db);
    src.docs.forEach((d) => {
      b.set(doc(db, `seasons/${L.seasonId}/rosters/${d.id}`), { playerIds: d.data().playerIds || [], updatedAt: serverTimestamp(), updatedBy: actor() });
      if (isCurrent) (d.data().playerIds || []).forEach((pid: string) => b.update(doc(db, 'players', pid), { currentTeamId: d.id }));
    });
    await b.commit();
    await syncTeamRoles(...src.docs.map((d) => d.id));
  }, 'Rosters copied');

  return (
    <>
      <SectionHeader eyebrow={`League · ${L.season?.name || ''}`} title="Per-season" accent="rosters" />
      <div className="card row wrap">
        <span className="small muted">Copy every roster from</span>
        <select className="select" style={{ width: 'auto' }} value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}>
          <option value="">season…</option>{L.seasons.filter((s) => s.id !== L.seasonId).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <Confirm className="btn sm" text="Overwrite this season's rosters with the selected season's?" onYes={copy}>Copy rosters</Confirm>
      </div>
      <div className="row wrap">{L.teamList.map((t) => (
        <button key={t.id} className={`btn sm ${teamId === t.id ? 'primary' : ''}`} onClick={() => setTeamId(t.id)}><Crest team={t} size="sm" />{t.shortName || t.name} ({(L.rosters[t.id] || []).length})</button>
      ))}</div>
      {teamId ? (
        <div className="card stack">
          <h3>{L.teams[teamId]?.name}</h3>
          {roster.map((pid) => (
            <div key={pid} className="row"><Avatar src={L.players[pid]?.avatarUrl} name={L.players[pid]?.name} size="sm" /><span className="grow">{L.players[pid]?.name || pid}</span>
              <button className="btn sm danger" disabled={busy} onClick={() => remove(pid)}>Remove</button></div>
          ))}
          {!roster.length && <Empty>Empty roster.</Empty>}
          <div className="row">
            <select className="select" value={add} onChange={(e) => setAdd(e.target.value)}>
              <option value="">Add player…</option>
              {L.playerList.filter((p) => !roster.includes(p.id)).map((p) => <option key={p.id} value={p.id}>{p.name}{onOtherRoster(p.id) ? ` (on ${L.teams[onOtherRoster(p.id)!]?.shortName})` : ''}</option>)}
            </select>
            <button className="btn primary" disabled={busy || !add} onClick={() => addToRoster(add)}>Add</button>
          </div>
          <p className="small muted">Mid-season moves after kickoff should go through Moves → Transfers so per-game W/L stays attributed correctly.</p>
        </div>
      ) : <Empty>Pick a team.</Empty>}
    </>
  );
}
