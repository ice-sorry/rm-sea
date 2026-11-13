/**
 * Minimal Firestore client over the REST API, shaped like the subset of the firebase-admin API this app uses.
 * Runs unchanged in Cloudflare Workers (service-account token → bypasses rules) and in the browser
 * (Firebase ID token → security rules apply). Only standard web APIs: fetch, crypto, TextEncoder.
 */

export type TokenSource = () => Promise<string | null>;
export interface DbOptions {
  projectId: string;
  /** Bearer token for each request (service-account access token, Firebase ID token, or null). */
  token: TokenSource;
  /** host:port of the Firestore emulator, e.g. 127.0.0.1:8080. */
  emulatorHost?: string;
}

// ---------------------------------------------------------------- values
export class Timestamp {
  constructor(readonly seconds: number, readonly nanoseconds: number) {}
  static fromMillis(ms: number) {
    const s = Math.floor(ms / 1000);
    return new Timestamp(s, Math.round((ms - s * 1000) * 1e6));
  }
  static fromDate(d: Date) { return Timestamp.fromMillis(d.getTime()); }
  static now() { return Timestamp.fromMillis(Date.now()); }
  toMillis() { return this.seconds * 1000 + Math.floor(this.nanoseconds / 1e6); }
  toDate() { return new Date(this.toMillis()); }
  isEqual(o: Timestamp) { return o instanceof Timestamp && o.seconds === this.seconds && o.nanoseconds === this.nanoseconds; }
  toISOString() {
    const base = new Date(this.seconds * 1000).toISOString().slice(0, 19);
    return `${base}.${String(this.nanoseconds).padStart(9, '0')}Z`;
  }
  static parse(iso: string) {
    const m = iso.match(/^(.*?)(?:\.(\d+))?Z$/);
    const secs = Math.floor(Date.parse(`${m ? m[1] : iso}Z`) / 1000);
    const nanos = m?.[2] ? Number(m[2].padEnd(9, '0').slice(0, 9)) : 0;
    return new Timestamp(secs, nanos);
  }
}

type FvKind = 'serverTimestamp' | 'increment' | 'arrayUnion' | 'arrayRemove' | 'delete';
export class FieldValue {
  private constructor(readonly kind: FvKind, readonly arg?: unknown) {}
  static serverTimestamp() { return new FieldValue('serverTimestamp'); }
  static increment(n: number) { return new FieldValue('increment', n); }
  static arrayUnion(...v: unknown[]) { return new FieldValue('arrayUnion', v); }
  static arrayRemove(...v: unknown[]) { return new FieldValue('arrayRemove', v); }
  static delete() { return new FieldValue('delete'); }
}

export type DocumentData = Record<string, any>;
type Value = Record<string, unknown>;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Timestamp) && !(v instanceof FieldValue)
  && !(v instanceof Date) && !(v instanceof DocumentReference);

function encode(v: unknown, db: Firestore): Value | undefined {
  if (v === undefined) return undefined;
  if (v === null) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') {
    return Number.isSafeInteger(v) ? { integerValue: String(v) } : { doubleValue: Number.isFinite(v) ? v : String(v) };
  }
  if (typeof v === 'string') return { stringValue: v };
  if (v instanceof Timestamp) return { timestampValue: v.toISOString() };
  if (v instanceof Date) return { timestampValue: Timestamp.fromDate(v).toISOString() };
  if (v instanceof DocumentReference) return { referenceValue: db.name(v.path) };
  if (Array.isArray(v)) return { arrayValue: { values: v.map((x) => encode(x, db)).filter(Boolean) } };
  if (v instanceof FieldValue) throw new Error(`FieldValue.${v.kind}() is only allowed as a field value, not inside arrays.`);
  if (typeof v === 'object') return { mapValue: { fields: encodeFields(v as Record<string, unknown>, db) } };
  throw new Error(`Unsupported Firestore value: ${typeof v}`);
}
function encodeFields(o: Record<string, unknown>, db: Firestore) {
  const out: Record<string, Value> = {};
  for (const [k, x] of Object.entries(o)) { const e = encode(x, db); if (e) out[k] = e; }
  return out;
}

function decode(v: Value, db: Firestore): unknown {
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('stringValue' in v) return v.stringValue;
  if ('timestampValue' in v) return Timestamp.parse(String(v.timestampValue));
  if ('referenceValue' in v) return db.doc(String(v.referenceValue).split('/documents/')[1]);
  if ('arrayValue' in v) return (((v.arrayValue as { values?: Value[] }).values) || []).map((x) => decode(x, db));
  if ('mapValue' in v) return decodeFields(((v.mapValue as { fields?: Record<string, Value> }).fields) || {}, db);
  if ('bytesValue' in v) return v.bytesValue;
  if ('geoPointValue' in v) return v.geoPointValue;
  return null;
}
function decodeFields(f: Record<string, Value>, db: Firestore): DocumentData {
  const out: DocumentData = {};
  for (const [k, x] of Object.entries(f)) out[k] = decode(x, db);
  return out;
}

// ---------------------------------------------------------------- field paths
const quoteSeg = (s: string) => (/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(s) ? s : `\`${s.replace(/\\/g, '\\\\').replace(/`/g, '\\`')}\``);
const fieldPath = (segs: string[]) => segs.map(quoteSeg).join('.');

/** Split data into encodable fields + transforms/deletes, recording every leaf path (for merge masks). */
function analyse(data: Record<string, unknown>, deep: boolean) {
  const transforms: { segs: string[]; fv: FieldValue }[] = [];
  const leaves: string[][] = [];
  const walk = (o: Record<string, unknown>, prefix: string[]): Record<string, unknown> => {
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) {
      if (v === undefined) continue;
      const segs = [...prefix, k];
      if (v instanceof FieldValue) { transforms.push({ segs, fv: v }); continue; }
      if (deep && isPlainObject(v) && Object.keys(v).length) { clean[k] = walk(v, segs); continue; }
      if (isPlainObject(v)) clean[k] = walkNested(v, segs);
      else clean[k] = v;
      leaves.push(segs);
    }
    return clean;
  };
  // Sentinels nested inside a replaced map still become transforms.
  const walkNested = (o: Record<string, unknown>, prefix: string[]): Record<string, unknown> => {
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) {
      if (v === undefined) continue;
      if (v instanceof FieldValue) { transforms.push({ segs: [...prefix, k], fv: v }); continue; }
      clean[k] = isPlainObject(v) ? walkNested(v, [...prefix, k]) : v;
    }
    return clean;
  };
  return { clean: walk(data, []), transforms, leaves };
}

function transformJson(t: { segs: string[]; fv: FieldValue }, db: Firestore) {
  const path = fieldPath(t.segs);
  switch (t.fv.kind) {
    case 'serverTimestamp': return { fieldPath: path, setToServerValue: 'REQUEST_TIME' };
    case 'increment': return { fieldPath: path, increment: encode(t.fv.arg, db) };
    case 'arrayUnion': return { fieldPath: path, appendMissingElements: { values: (t.fv.arg as unknown[]).map((x) => encode(x, db)) } };
    case 'arrayRemove': return { fieldPath: path, removeAllFromArray: { values: (t.fv.arg as unknown[]).map((x) => encode(x, db)) } };
    default: return null;
  }
}

type Mode = 'set' | 'merge' | 'update' | 'create';
function buildWrite(db: Firestore, path: string, data: DocumentData, mode: Mode) {
  let input = data;
  if (mode === 'update') {
    // update() keys are field paths: "a.b" targets nested field b of map a.
    input = {};
    for (const [k, v] of Object.entries(data)) {
      const segs = k.split('.');
      let cur = input as Record<string, unknown>;
      segs.slice(0, -1).forEach((s) => { cur[s] = isPlainObject(cur[s]) ? cur[s] : {}; cur = cur[s] as Record<string, unknown>; });
      cur[segs[segs.length - 1]] = v;
    }
  }
  const deepMask = mode === 'merge';
  const { clean, transforms, leaves } = analyse(input, deepMask);
  const write: Record<string, unknown> = { update: { name: db.name(path), fields: encodeFields(clean, db) } };
  const deletes = transforms.filter((t) => t.fv.kind === 'delete').map((t) => t.segs);
  if (mode === 'merge') write.updateMask = { fieldPaths: [...leaves, ...deletes].map(fieldPath) };
  if (mode === 'update') {
    const tops = Object.keys(data).filter((k) => data[k] !== undefined && !(data[k] instanceof FieldValue && data[k].kind !== 'delete'));
    write.updateMask = { fieldPaths: tops.map((k) => fieldPath(k.split('.'))) };
    write.currentDocument = { exists: true };
  }
  if (mode === 'create') write.currentDocument = { exists: false };
  const tj = transforms.map((t) => transformJson(t, db)).filter(Boolean);
  if (tj.length) write.updateTransforms = tj;
  return write;
}

// ---------------------------------------------------------------- errors
export class FirestoreError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

// ---------------------------------------------------------------- snapshots
export class DocumentSnapshot {
  constructor(readonly ref: DocumentReference, private readonly _data: DocumentData | undefined, readonly updateTime?: string) {}
  get id() { return this.ref.id; }
  get exists() { return this._data !== undefined; }
  data(): DocumentData | undefined { return this._data; }
  get(field: string): any { return field.split('.').reduce<any>((o, k) => (o == null ? undefined : o[k]), this._data); }
}
/** Query results always exist, so data() is never undefined (same typing as firebase-admin). */
export class QueryDocumentSnapshot extends DocumentSnapshot {
  data(): DocumentData { return super.data()!; }
}
export class QuerySnapshot {
  constructor(readonly docs: QueryDocumentSnapshot[]) {}
  get size() { return this.docs.length; }
  get empty() { return this.docs.length === 0; }
  forEach(fn: (d: DocumentSnapshot) => void) { this.docs.forEach(fn); }
}

// ---------------------------------------------------------------- references & queries
type Op = '<' | '<=' | '==' | '!=' | '>=' | '>' | 'array-contains' | 'in' | 'not-in' | 'array-contains-any';
const OPS: Record<Op, string> = {
  '<': 'LESS_THAN', '<=': 'LESS_THAN_OR_EQUAL', '==': 'EQUAL', '!=': 'NOT_EQUAL', '>=': 'GREATER_THAN_OR_EQUAL', '>': 'GREATER_THAN',
  'array-contains': 'ARRAY_CONTAINS', in: 'IN', 'not-in': 'NOT_IN', 'array-contains-any': 'ARRAY_CONTAINS_ANY',
};

export class Query {
  constructor(
    readonly firestore: Firestore,
    /** Parent document path ('' = database root). */
    protected readonly parentPath: string,
    protected readonly collectionId: string,
    protected readonly allDescendants = false,
    protected readonly filters: unknown[] = [],
    protected readonly orders: unknown[] = [],
    protected readonly limitN?: number,
  ) {}
  private clone(p: { filters?: unknown[]; orders?: unknown[]; limitN?: number }) {
    return new Query(this.firestore, this.parentPath, this.collectionId, this.allDescendants,
      p.filters ?? this.filters, p.orders ?? this.orders, p.limitN ?? this.limitN);
  }
  where(field: string, op: Op, value: unknown): Query {
    const fp = { fieldPath: fieldPath(field.split('.')) };
    const f = value === null && (op === '==' || op === '!=')
      ? { unaryFilter: { field: fp, op: op === '==' ? 'IS_NULL' : 'IS_NOT_NULL' } }
      : { fieldFilter: { field: fp, op: OPS[op], value: encode(value, this.firestore) } };
    return this.clone({ filters: [...this.filters, f] });
  }
  orderBy(field: string, dir: 'asc' | 'desc' = 'asc'): Query {
    return this.clone({ orders: [...this.orders, { field: { fieldPath: fieldPath(field.split('.')) }, direction: dir === 'desc' ? 'DESCENDING' : 'ASCENDING' }] });
  }
  limit(n: number): Query { return this.clone({ limitN: n }); }
  /** @internal */
  toRequest() {
    const sq: Record<string, unknown> = { from: [{ collectionId: this.collectionId, allDescendants: this.allDescendants }] };
    if (this.filters.length === 1) sq.where = this.filters[0];
    else if (this.filters.length > 1) sq.where = { compositeFilter: { op: 'AND', filters: this.filters } };
    if (this.orders.length) sq.orderBy = this.orders;
    if (this.limitN !== undefined) sq.limit = this.limitN;
    return { parent: this.firestore.name(this.parentPath), structuredQuery: sq };
  }
  get(): Promise<QuerySnapshot> { return this.firestore._runQuery(this); }
}

export class CollectionReference extends Query {
  constructor(firestore: Firestore, readonly path: string) {
    const segs = path.split('/');
    super(firestore, segs.slice(0, -1).join('/'), segs[segs.length - 1]);
  }
  get id() { return this.collectionId; }
  get parent(): DocumentReference | null { return this.parentPath ? new DocumentReference(this.firestore, this.parentPath) : null; }
  doc(id?: string) { return new DocumentReference(this.firestore, `${this.path}/${id ?? autoId()}`); }
  async add(data: DocumentData) { const ref = this.doc(); await ref.set(data); return ref; }
  /** Every document id in the collection, including "missing" parents that only hold subcollections. */
  async listDocuments(): Promise<DocumentReference[]> {
    const out: DocumentReference[] = [];
    let pageToken = '';
    do {
      const q = new URLSearchParams({ showMissing: 'true', pageSize: '300', 'mask.fieldPaths': '__name__' });
      if (pageToken) q.set('pageToken', pageToken);
      const res = await this.firestore._fetch<{ documents?: { name: string }[]; nextPageToken?: string }>('GET', `${this.firestore.name(this.path)}?${q}`);
      for (const d of res.documents || []) out.push(this.firestore.doc(d.name.split('/documents/')[1]));
      pageToken = res.nextPageToken || '';
    } while (pageToken);
    return out;
  }
}

export class DocumentReference {
  constructor(readonly firestore: Firestore, readonly path: string) {}
  get id() { return this.path.slice(this.path.lastIndexOf('/') + 1); }
  get parent() { return new CollectionReference(this.firestore, this.path.slice(0, this.path.lastIndexOf('/'))); }
  collection(id: string) { return new CollectionReference(this.firestore, `${this.path}/${id}`); }
  async get() { return (await this.firestore.getAll(this))[0]; }
  set(data: DocumentData, opts?: { merge?: boolean }) { return this.firestore._commit([buildWrite(this.firestore, this.path, data, opts?.merge ? 'merge' : 'set')]); }
  update(data: DocumentData) { return this.firestore._commit([buildWrite(this.firestore, this.path, data, 'update')]); }
  create(data: DocumentData) { return this.firestore._commit([buildWrite(this.firestore, this.path, data, 'create')]); }
  delete() { return this.firestore._commit([{ delete: this.firestore.name(this.path) }]); }
  listCollections() { return this.firestore._listCollections(this.path); }
}

const AUTO_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export function autoId() {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return Array.from(bytes, (b) => AUTO_CHARS[b % AUTO_CHARS.length]).join('');
}

// ---------------------------------------------------------------- batches & transactions
export class WriteBatch {
  protected writes: unknown[] = [];
  constructor(protected readonly firestore: Firestore) {}
  set(ref: DocumentReference, data: DocumentData, opts?: { merge?: boolean }) { this.writes.push(buildWrite(this.firestore, ref.path, data, opts?.merge ? 'merge' : 'set')); return this; }
  update(ref: DocumentReference, data: DocumentData) { this.writes.push(buildWrite(this.firestore, ref.path, data, 'update')); return this; }
  create(ref: DocumentReference, data: DocumentData) { this.writes.push(buildWrite(this.firestore, ref.path, data, 'create')); return this; }
  delete(ref: DocumentReference) { this.writes.push({ delete: this.firestore.name(ref.path) }); return this; }
  async commit() { if (this.writes.length) await this.firestore._commit(this.writes); }
}

export class Transaction extends WriteBatch {
  constructor(firestore: Firestore, readonly id: string) { super(firestore); }
  get(ref: DocumentReference): Promise<DocumentSnapshot>;
  get(q: Query): Promise<QuerySnapshot>;
  async get(x: DocumentReference | Query): Promise<DocumentSnapshot | QuerySnapshot> {
    if (x instanceof DocumentReference) return (await this.firestore.getAll(x, { transaction: this.id }))[0];
    return this.firestore._runQuery(x, this.id);
  }
  /** @internal */
  pending() { return this.writes; }
}

// ---------------------------------------------------------------- client
export class Firestore {
  private readonly base: string;
  private readonly root: string;
  constructor(private readonly opts: DbOptions) {
    this.base = opts.emulatorHost ? `http://${opts.emulatorHost}/v1/` : 'https://firestore.googleapis.com/v1/';
    this.root = `projects/${opts.projectId}/databases/(default)/documents`;
  }
  /** Full resource name for a document/collection path ('' = documents root). */
  name(path: string) { return path ? `${this.root}/${path}` : this.root; }

  doc(path: string) { return new DocumentReference(this, path.replace(/^\/+|\/+$/g, '')); }
  collection(path: string) { return new CollectionReference(this, path.replace(/^\/+|\/+$/g, '')); }
  collectionGroup(id: string) { return new Query(this, '', id, true); }
  batch() { return new WriteBatch(this); }
  listCollections() { return this._listCollections(''); }

  async getAll(...args: (DocumentReference | { transaction?: string })[]): Promise<DocumentSnapshot[]> {
    const refs = args.filter((a): a is DocumentReference => a instanceof DocumentReference);
    const opt = args.find((a) => !(a instanceof DocumentReference)) as { transaction?: string } | undefined;
    if (!refs.length) return [];
    const res = await this._fetch<{ found?: { name: string; fields?: Record<string, Value>; updateTime: string }; missing?: string }[]>(
      'POST', `${this.root}:batchGet`, { documents: refs.map((r) => this.name(r.path)), ...(opt?.transaction ? { transaction: opt.transaction } : {}) });
    const byName = new Map<string, { fields?: Record<string, Value>; updateTime?: string } | null>();
    for (const r of res) {
      if (r.found) byName.set(r.found.name, r.found);
      else if (r.missing) byName.set(r.missing, null);
    }
    return refs.map((ref) => {
      const f = byName.get(this.name(ref.path));
      return new DocumentSnapshot(ref, f ? decodeFields(f.fields || {}, this) : undefined, f?.updateTime);
    });
  }

  async runTransaction<T>(fn: (tx: Transaction) => Promise<T>, maxAttempts = 5): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const { transaction } = await this._fetch<{ transaction: string }>('POST', `${this.root}:beginTransaction`, {});
      const tx = new Transaction(this, transaction);
      let result: T;
      try {
        result = await fn(tx);
      } catch (e) {
        await this._fetch('POST', `${this.root}:rollback`, { transaction }).catch(() => undefined);
        throw e;
      }
      try {
        await this._commit(tx.pending(), transaction);
        return result;
      } catch (e) {
        if (attempt < maxAttempts && e instanceof FirestoreError && (e.code === 'ABORTED' || e.status === 409)) continue;
        throw e;
      }
    }
  }

  /** @internal */
  async _runQuery(q: Query, transaction?: string): Promise<QuerySnapshot> {
    const { parent, structuredQuery } = q.toRequest();
    const res = await this._fetch<{ document?: { name: string; fields?: Record<string, Value>; updateTime: string } }[]>(
      'POST', `${parent}:runQuery`, { structuredQuery, ...(transaction ? { transaction } : {}) });
    return new QuerySnapshot(res.filter((r) => r.document).map((r) =>
      new QueryDocumentSnapshot(this.doc(r.document!.name.split('/documents/')[1]), decodeFields(r.document!.fields || {}, this), r.document!.updateTime)));
  }
  /** @internal */
  async _commit(writes: unknown[], transaction?: string) {
    for (let i = 0; i < writes.length; i += 500) {
      await this._fetch('POST', `${this.root}:commit`, { writes: writes.slice(i, i + 500), ...(transaction ? { transaction } : {}) });
    }
  }
  /** @internal */
  async _listCollections(docPath: string): Promise<CollectionReference[]> {
    const ids: string[] = [];
    let pageToken = '';
    do {
      const r = await this._fetch<{ collectionIds?: string[]; nextPageToken?: string }>('POST', `${this.name(docPath)}:listCollectionIds`, { pageSize: 1000, ...(pageToken ? { pageToken } : {}) });
      ids.push(...(r.collectionIds || []));
      pageToken = r.nextPageToken || '';
    } while (pageToken);
    return ids.map((id) => this.collection(docPath ? `${docPath}/${id}` : id));
  }
  /** @internal */
  async _fetch<T = unknown>(method: string, resource: string, body?: unknown): Promise<T> {
    const token = await this.opts.token();
    const res = await fetch(`${this.base}${resource}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      let code = String(res.status), message = text;
      try { const j = JSON.parse(text); const e = Array.isArray(j) ? j[0]?.error : j.error; code = e?.status || code; message = e?.message || text; } catch { /* not json */ }
      throw new FirestoreError(res.status, code, `Firestore ${code}: ${message}`);
    }
    return (await res.json()) as T;
  }
}
