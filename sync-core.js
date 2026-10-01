'use strict';
// 동기화 핵심 — PC(Electron)와 폰(React Native)이 똑같이 쓰는 파일. 외부 의존성 없음.
//
// 규칙
//  1) 일정마다 updatedAt(ms)이 더 큰 쪽이 이긴다.
//  2) 삭제는 지우지 않고 deleted:true(묘비)로 남겨서 다른 기기에도 전달한다.
//  3) 이 기기에서 바꾼 뒤 아직 서버에 못 올린 일정은 dirty 목록에 적어 두고, 서버의 첫 응답을 받은 뒤에 올린다
//     (오래된 데이터로 서버의 최신본을 덮어쓰지 않기 위해).
//  4) 앱이 꺼져 있거나 인터넷이 없어도 이 기기의 파일/저장소가 원본이다. 연결되면 알아서 맞춘다.

const FIELDS = ['title', 'start', 'end', 'allDay', 'location', 'memo', 'color', 'remind', 'source'];
const DAY = 86_400_000;

/** 저장 전 검사·정리 (PC·폰 공통) */
function clean(e) {
  const title = String(e.title ?? '').trim();
  if (!title) throw new Error('제목을 입력하세요');
  const start = Number(e.start);
  if (!Number.isFinite(start)) throw new Error('시작 시각이 올바르지 않습니다');
  const end = e.end == null ? null : Number(e.end);
  if (end != null && (!Number.isFinite(end) || end < start)) throw new Error('종료가 시작보다 빠릅니다');
  return {
    title, start, end, allDay: !!e.allDay,
    location: String(e.location ?? ''), memo: String(e.memo ?? ''),
    color: /^#[0-9a-f]{6}$/i.test(e.color || '') ? e.color : '',
    // 종일 일정은 00:00 기준이라 음수 허용 (-480 = 당일 오전 8시)
    remind: [...new Set((e.remind || []).map(Number).filter((n) => Number.isInteger(n) && n >= -1440 && n <= 40320))].sort((a, b) => a - b),
    source: ['ai', 'claude-code'].includes(e.source) ? e.source : '',
  };
}

/** 서버에 저장할 모양 (undefined 금지) */
function toRemote(d) {
  const o = {};
  for (const k of FIELDS) o[k] = d[k] === undefined ? null : d[k];
  o.createdAt = d.createdAt || d.updatedAt || 0;
  o.updatedAt = d.updatedAt || 0;
  o.deleted = !!d.deleted;
  return o;
}

/** 서버 문서 → 이 기기의 문서. 못 쓰는 문서는 null */
function fromRemote(id, x) {
  if (!x || typeof x !== 'object') return null;
  const deleted = !!x.deleted;
  const start = Number(x.start);
  if (!deleted && !Number.isFinite(start)) return null;
  const updatedAt = Number(x.updatedAt) || 0;
  return {
    id, title: String(x.title ?? ''), start: Number.isFinite(start) ? start : 0,
    end: x.end == null ? null : Number(x.end), allDay: !!x.allDay,
    location: String(x.location ?? ''), memo: String(x.memo ?? ''), color: String(x.color ?? ''),
    remind: Array.isArray(x.remind) ? x.remind.map(Number).filter(Number.isFinite) : [],
    source: String(x.source ?? ''), createdAt: Number(x.createdAt) || updatedAt, updatedAt, deleted,
  };
}

/**
 * map(id → 문서)에 서버 문서를 합친다. map을 직접 바꾼다.
 * full=true: remoteDocs가 서버의 전체 목록 → 서버에 없는 이 기기 문서도 올릴 대상
 * 반환: { changed, toPush }
 */
function mergeRemote(map, remoteDocs, { full = false } = {}) {
  let changed = false;
  const toPush = [];
  const seen = new Set();
  for (const r of remoteDocs) {
    seen.add(r.id);
    const l = map.get(r.id);
    if (!l || r.updatedAt > l.updatedAt) { map.set(r.id, r); changed = true; }
    else if (l.updatedAt > r.updatedAt) toPush.push(l);
  }
  if (full) for (const [id, l] of map) if (!seen.has(id)) toPush.push(l);
  return { changed, toPush };
}

const normalizeDoc = (raw) => {
  const updatedAt = Number(raw.updatedAt) || Number(raw.createdAt) || 0;
  return { ...raw, deleted: !!raw.deleted, updatedAt, createdAt: Number(raw.createdAt) || updatedAt };
};

/** 이 기기의 일정 저장소 (PC는 파일, 폰은 AsyncStorage에 persist 함수로 저장) */
class LocalDocStore {
  constructor({ data, persist, now = Date.now, newId } = {}) {
    this.now = now;
    this._persist = persist || (() => {});
    this._id = newId || (() => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
    this.handlers = { change: new Set(), 'local-write': new Set() };
    this.hydrate(data, false);
  }

  /** 저장된 데이터로 채운다 (폰은 저장소를 비동기로 읽은 뒤 호출) */
  hydrate(data, emit = true) {
    this.map = new Map();
    const d = data && typeof data === 'object' ? data : {};
    this.owner = d.owner || null;
    this.dirty = d.dirty && typeof d.dirty === 'object' ? { ...d.dirty } : {};
    const cutoff = this.now() - 180 * DAY; // 오래된 삭제 표시는 이 기기에서만 정리
    for (const raw of Array.isArray(d.events) ? d.events : []) {
      if (!raw || !raw.id) continue;
      const doc = normalizeDoc(raw);
      if (doc.deleted && doc.updatedAt < cutoff && !this.dirty[doc.id]) continue;
      this.map.set(doc.id, doc);
    }
    if (emit) this._emitChange();
  }

  on(event, fn) { this.handlers[event].add(fn); return () => this.handlers[event].delete(fn); }
  _emitChange() { const l = this.list(); for (const fn of this.handlers.change) fn(l); }
  _emitLocal(docs) { for (const fn of this.handlers['local-write']) fn(docs); }
  snapshot() { return { version: 1, owner: this.owner, dirty: this.dirty, events: [...this.map.values()] }; }
  _save(emit = true) {
    try {
      const r = this._persist(this.snapshot());
      if (r && typeof r.catch === 'function') r.catch((e) => console.warn('일정 저장 실패', e));
    } catch (e) { console.warn('일정 저장 실패', e); }
    if (emit) this._emitChange();
  }
  _stamp(old) { return Math.max(this.now(), (old ? old.updatedAt : 0) + 1); }
  _wrote(docs) { for (const d of docs) this.dirty[d.id] = d.updatedAt; this._save(); this._emitLocal(docs); }

  list() { return [...this.map.values()].filter((d) => !d.deleted).sort((a, b) => a.start - b.start); }
  get(id) { const d = this.map.get(id); return d && !d.deleted ? d : null; }
  allDocs() { return [...this.map.values()]; }

  add(e) { return this.addMany([e])[0].id; }
  addMany(list) {
    const t = this.now();
    const docs = list.map((e) => ({ id: this._id(), ...clean(e), createdAt: t, updatedAt: t, deleted: false })); // 하나라도 잘못되면 전부 취소
    for (const d of docs) this.map.set(d.id, d);
    this._wrote(docs);
    return docs;
  }
  update(id, e) {
    const old = this.map.get(id);
    if (!old || old.deleted) throw new Error('일정을 찾을 수 없습니다');
    const doc = { ...old, ...clean(e), id, updatedAt: this._stamp(old), deleted: false };
    this.map.set(id, doc);
    this._wrote([doc]);
  }
  remove(ids) {
    const docs = [];
    for (const id of [].concat(ids)) {
      const old = this.map.get(id);
      if (!old || old.deleted) continue;
      const doc = { ...old, deleted: true, updatedAt: this._stamp(old) };
      this.map.set(id, doc);
      docs.push(doc);
    }
    if (docs.length) this._wrote(docs);
  }

  /** 서버 문서를 합친다. 서버에 올려야 할 문서(이 기기가 더 최신)를 돌려준다 */
  applyRemote(docs, { full = false } = {}) {
    const { changed, toPush } = mergeRemote(this.map, docs, { full });
    for (const d of toPush) this.dirty[d.id] = d.updatedAt;
    for (const id of Object.keys(this.dirty)) { // 서버 쪽이 더 최신이라 이긴 문서는 올릴 필요 없음
      const d = this.map.get(id);
      if (!d || d.updatedAt > this.dirty[id]) delete this.dirty[id];
    }
    if (changed || toPush.length) this._save(changed);
    return toPush;
  }
  getDirtyDocs() { return Object.keys(this.dirty).map((id) => this.map.get(id)).filter(Boolean); }
  markClean(pairs) {
    let any = false;
    for (const { id, updatedAt } of pairs) if (this.dirty[id] !== undefined && this.dirty[id] <= updatedAt) { delete this.dirty[id]; any = true; }
    if (any) this._save(false);
  }

  /** 로그인한 계정 확인. 이전과 다른 계정이면 이 기기의 일정을 비우고 true */
  claimOwner(uid) {
    if (this.owner === uid) return false;
    const hadOther = !!this.owner;
    this.owner = uid;
    if (hadOther) { this.map.clear(); this.dirty = {}; }
    this._save(hadOther);
    return hadOther;
  }

  /** 다른 기기의 events.json을 합친다 (더 최근에 고친 쪽이 이김) */
  importData(data) {
    const incoming = Array.isArray(data && data.events) ? data.events : Array.isArray(data) ? data : null;
    if (!incoming) throw new Error('일정 파일 형식이 아닙니다 (events.json)');
    let added = 0, updated = 0;
    const changed = [];
    for (const raw of incoming) {
      if (!raw || typeof raw !== 'object') continue;
      let doc;
      try {
        const t = Number(raw.updatedAt) || this.now();
        doc = { id: raw.id || this._id(), ...clean(raw), createdAt: Number(raw.createdAt) || t, updatedAt: t, deleted: !!raw.deleted };
      } catch { continue; }
      const old = this.map.get(doc.id);
      if (!old) { if (!doc.deleted) added++; }
      else if (doc.updatedAt > old.updatedAt) updated++;
      else continue;
      this.map.set(doc.id, doc);
      changed.push(doc);
    }
    if (changed.length) this._wrote(changed);
    return { added, updated };
  }
  exportData() { return { version: 1, exportedAt: new Date().toISOString(), events: this.list() }; }
}

/** 저장소 ↔ 서버(remote)를 이어 주는 엔진. remote = { start({onSnapshot}), push(docs) } */
class SyncEngine {
  constructor({ store, remote, log, onError }) {
    this.store = store; this.remote = remote; this.log = log || (() => {}); this.onError = onError || (() => {});
    this.synced = false;
    this.inflight = new Map();
    this.timer = null;
    this.off = null;
  }
  start() {
    this.off = this.store.on('local-write', () => { this.flush(); });
    this.remote.start({ onSnapshot: (docs, meta) => this.handleSnapshot(docs, meta) });
    this.timer = setInterval(() => this.flush(), 60_000); // 올리기에 실패했던 것 다시 시도
    if (this.timer.unref) this.timer.unref();
  }
  stop() { if (this.off) this.off(); clearInterval(this.timer); }
  reset() { this.synced = false; this.inflight.clear(); }

  async handleSnapshot(docs, { fromCache = false } = {}) {
    // 서버에서 온 첫 전체 목록일 때만 "서버에 없는 이 기기 일정"을 올린다. 캐시(오래된 사본)로는 올리지 않는다.
    this.store.applyRemote(docs, { full: !fromCache && !this.synced });
    if (!fromCache) this.synced = true;
    await this.flush();
  }

  async flush() {
    if (!this.synced) return; // 서버의 첫 응답 전에는 올리지 않는다
    const docs = this.store.getDirtyDocs().filter((d) => this.inflight.get(d.id) !== d.updatedAt);
    if (!docs.length) return;
    for (const d of docs) this.inflight.set(d.id, d.updatedAt);
    try {
      await this.remote.push(docs);
      this.store.markClean(docs.map(({ id, updatedAt }) => ({ id, updatedAt })));
    } catch (e) {
      for (const d of docs) if (this.inflight.get(d.id) === d.updatedAt) this.inflight.delete(d.id);
      this.log('동기화 올리기 실패', e && e.message);
      this.onError(e);
    }
  }
}

/** Firestore users/{uid}/events 실시간 구독. fs = 'firebase/firestore' 모듈 */
function listen(fs, db, uid, { onSnapshot, onError }) {
  const col = fs.collection(db, 'users', uid, 'events');
  let first = true;
  let lastFromCache = null;
  return fs.onSnapshot(col, { includeMetadataChanges: true }, (snap) => {
    const fromCache = !!snap.metadata.fromCache;
    if (!first && snap.docChanges().length === 0 && fromCache === lastFromCache) return;
    first = false; lastFromCache = fromCache;
    const docs = [];
    snap.forEach((d) => { const x = fromRemote(d.id, d.data()); if (x) docs.push(x); });
    onSnapshot(docs, { fromCache });
  }, (err) => onError(err));
}

async function pushDocs(fs, db, uid, docs) {
  for (let i = 0; i < docs.length; i += 400) {
    const b = fs.writeBatch(db);
    for (const d of docs.slice(i, i + 400)) b.set(fs.doc(db, 'users', uid, 'events', d.id), toRemote(d));
    await b.commit();
  }
}

const MESSAGES = {
  'auth/invalid-credential': '이메일 또는 비밀번호가 맞지 않습니다.',
  'auth/invalid-login-credentials': '이메일 또는 비밀번호가 맞지 않습니다.',
  'auth/wrong-password': '이메일 또는 비밀번호가 맞지 않습니다.',
  'auth/user-not-found': '이메일 또는 비밀번호가 맞지 않습니다.',
  'auth/invalid-email': '이메일 형식이 올바르지 않습니다.',
  'auth/missing-password': '비밀번호를 입력하세요.',
  'auth/too-many-requests': '시도가 너무 많습니다. 잠시 후 다시 시도하세요.',
  'auth/network-request-failed': '인터넷에 연결할 수 없습니다. 연결을 확인하세요. (학교 망에서 막혀 있을 수도 있습니다)',
  'auth/user-disabled': '이 계정은 사용할 수 없습니다.',
  'auth/operation-not-allowed': 'Firebase 콘솔에서 이메일/비밀번호 로그인이 켜져 있지 않습니다.',
  'permission-denied': 'Firestore 보안 규칙이 아직 게시되지 않았거나 이 계정에 권한이 없습니다. 설명서의 "보안 규칙 게시" 단계를 확인하세요.',
  unavailable: '서버에 연결할 수 없습니다. 잠시 뒤 자동으로 다시 시도합니다.',
};
function friendlyError(e) {
  const code = e && e.code ? String(e.code).replace(/^firestore\//, '') : '';
  return MESSAGES[code] || (e && e.message) || '알 수 없는 오류';
}

module.exports = { FIELDS, clean, toRemote, fromRemote, mergeRemote, LocalDocStore, SyncEngine, listen, pushDocs, friendlyError };
