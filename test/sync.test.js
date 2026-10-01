// 동기화 시험 — 가짜 Firestore로 두 기기(PC·폰)가 어긋나지 않는지 확인. PC·폰 프로젝트에서 같은 파일을 쓴다.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const core = require(fs.existsSync(path.join(__dirname, '../sync-core.js')) ? '../sync-core' : '../src/core/sync-core');
const { LocalDocStore, SyncEngine, listen, pushDocs, mergeRemote, toRemote, fromRemote, clean } = core;
const ok = (m) => console.log('  ✓', m);
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };

// ---- 가짜 Firestore ----
class Backend {
  constructor() { this.docs = new Map(); this.subs = new Set(); }
  fsFor(dev) {
    const be = this;
    const snapOf = (changed, fromCache) => ({
      metadata: { fromCache },
      docChanges: () => changed,
      forEach: (fn) => { for (const [id, data] of be.docs) fn({ id, data: () => data }); },
    });
    return {
      collection: (db, ...s) => ({ path: s.join('/') }),
      doc: (db, ...s) => ({ path: s.join('/'), id: s[s.length - 1] }),
      onSnapshot(col, opts, next) {
        const sub = { dev, next, snapOf, all: () => [...be.docs.keys()] };
        be.subs.add(sub);
        next(snapOf([1], true)); // 먼저 캐시에서
        if (dev.online) setImmediate(() => next(snapOf([...be.docs.keys()], false))); // 그다음 서버에서
        return () => be.subs.delete(sub);
      },
      writeBatch: () => {
        const ops = [];
        return {
          set: (ref, data) => ops.push([ref.id, JSON.parse(JSON.stringify(data))]),
          commit: async () => {
            if (!dev.online) { const e = new Error('offline'); e.code = 'unavailable'; throw e; }
            for (const [id, data] of ops) be.docs.set(id, data);
            for (const s of be.subs) if (s.dev.online) setImmediate(() => s.next(s.snapOf(ops.map((o) => o[0]), false)));
          },
        };
      },
    };
  }
}
let clock = 1_000_000;
const tick = () => ++clock;
function device(be, label) {
  const dev = { online: true, label };
  const store = new LocalDocStore({ now: tick, persist: () => {} });
  const f = be.fsFor(dev);
  let handlers, unsub;
  const engine = new SyncEngine({ store, remote: { start: (h) => { handlers = h; }, push: (docs) => pushDocs(f, null, 'u1', docs) } });
  engine.start();
  return {
    store, engine, dev,
    signIn() { unsub = listen(f, null, 'u1', { onSnapshot: (d, m) => handlers.onSnapshot(d, m), onError: (e) => { throw e; } }); },
    goOnline() { dev.online = true; unsub(); engine.reset(); this.signIn(); },
    titles: () => store.list().map((e) => e.title).sort(),
  };
}
const ev = (title, day = 1) => ({ title, start: Date.UTC(2026, 9, day), end: null, allDay: true, remind: [] });

(async () => {
  console.log('기본 규칙');
  const m = new Map([['a', { id: 'a', updatedAt: 5 }], ['b', { id: 'b', updatedAt: 9 }]]);
  const r = mergeRemote(m, [{ id: 'a', updatedAt: 7 }, { id: 'b', updatedAt: 3 }, { id: 'c', updatedAt: 1 }], { full: false });
  assert.strictEqual(m.get('a').updatedAt, 7); assert.deepStrictEqual(r.toPush.map((d) => d.id), ['b']); assert.ok(m.has('c'));
  assert.deepStrictEqual(mergeRemote(new Map([['z', { id: 'z', updatedAt: 1 }]]), [], { full: true }).toPush.map((d) => d.id), ['z']);
  assert.strictEqual(fromRemote('x', { title: 't' }), null, '시작 시각 없는 문서는 버림');
  assert.ok(!Object.values(toRemote({ title: 'a', start: 1 })).includes(undefined));
  assert.ok(fromRemote('x', toRemote({ id: 'x', title: 't', start: 5, end: null, remind: [-480], updatedAt: 3, deleted: false })).remind[0] === -480);
  ok('최신 우선 합치기·전체 목록 비교·잘못된 문서 거르기·서버 형식 왕복');

  console.log('저장소');
  const s = new LocalDocStore({ now: tick, persist: () => {} });
  const id = s.add(ev('회의')); s.update(id, ev('회의2'));
  assert.strictEqual(s.list()[0].title, '회의2');
  s.remove(id);
  assert.strictEqual(s.list().length, 0); assert.strictEqual(s.allDocs().length, 1, '삭제는 표시로 남음'); assert.ok(s.dirty[id]);
  assert.throws(() => s.update(id, ev('x')), /찾을 수 없/);
  assert.throws(() => s.addMany([ev('ok'), { title: '', start: 1 }]), /제목/); assert.strictEqual(s.allDocs().length, 1, '하나라도 잘못되면 전부 취소');
  const old = new LocalDocStore({ now: () => 9e12, persist: () => {}, data: { events: [{ id: 'g', title: 'x', start: 1, updatedAt: 1, deleted: true }, { id: 'h', title: 'y', start: 1, updatedAt: 1 }] } });
  assert.deepStrictEqual(old.allDocs().map((d) => d.id), ['h'], '오래된 삭제 표시만 정리');
  const o = new LocalDocStore({ now: tick, persist: () => {} }); o.add(ev('a'));
  assert.strictEqual(o.claimOwner('u1'), false); assert.strictEqual(o.list().length, 1, '처음 로그인은 기존 일정을 그대로 가져감');
  assert.strictEqual(o.claimOwner('u2'), true); assert.strictEqual(o.list().length, 0, '다른 계정이면 비움');
  const imp = new LocalDocStore({ now: tick, persist: () => {} });
  assert.deepStrictEqual(imp.importData({ events: [{ id: 'p1', title: 'PC일정', start: 5, updatedAt: 50 }, { title: '', start: 1 }] }), { added: 1, updated: 0 });
  assert.deepStrictEqual(imp.importData({ events: [{ id: 'p1', title: 'PC일정(수정)', start: 5, updatedAt: 60 }] }), { added: 0, updated: 1 });
  assert.deepStrictEqual(imp.importData({ events: [{ id: 'p1', title: '옛날', start: 5, updatedAt: 10 }] }), { added: 0, updated: 0 });
  ok('추가·수정·삭제 표시·일괄 취소·묘비 정리·계정 전환·파일 가져오기');

  console.log('두 기기 동기화 (가짜 서버)');
  const be = new Backend();
  const pc = device(be, 'PC'), phone = device(be, '폰');
  pc.store.add(ev('PC에서 입력', 1)); pc.store.add(ev('공통 일정', 2));
  phone.store.add(ev('폰에서 입력', 3));
  pc.signIn(); phone.signIn(); await settle();
  assert.deepStrictEqual(pc.titles(), ['PC에서 입력', '공통 일정', '폰에서 입력']);
  assert.deepStrictEqual(phone.titles(), pc.titles());
  assert.strictEqual(Object.keys(pc.store.dirty).length + Object.keys(phone.store.dirty).length, 0, '다 올라가면 dirty 비움');
  ok('처음 로그인: 서로의 기존 일정이 합쳐짐');

  const target = pc.store.list().find((e) => e.title === '공통 일정');
  pc.store.update(target.id, ev('공통 일정(수정)', 2)); await settle();
  assert.ok(phone.titles().includes('공통 일정(수정)') && !phone.titles().includes('공통 일정'));
  phone.store.remove(phone.store.list().find((e) => e.title === 'PC에서 입력').id); await settle();
  assert.ok(!pc.titles().includes('PC에서 입력'), '삭제도 전달');
  const added = phone.store.add(ev('폰 새 일정', 9)); await settle();
  assert.ok(pc.store.get(added));
  ok('수정·삭제·추가가 상대 기기에 즉시 반영');

  phone.dev.online = false; // 폰이 인터넷 끊김
  const x = phone.store.list().find((e) => e.title === '공통 일정(수정)');
  phone.store.update(x.id, ev('폰이 오프라인에서 수정', 2)); await settle();
  pc.store.update(x.id, ev('PC가 나중에 수정', 2)); await settle(); // 더 늦은 시각
  phone.goOnline(); await settle();
  assert.ok(phone.titles().includes('PC가 나중에 수정'), '더 늦게 고친 쪽(PC)이 이김');
  assert.ok(!phone.titles().includes('폰이 오프라인에서 수정'));
  assert.strictEqual(Object.keys(phone.store.dirty).length, 0);
  ok('오프라인 충돌: 더 늦게 고친 쪽이 이기고, 이긴 쪽 데이터가 서버의 최신본을 덮지 않음');

  phone.dev.online = false;
  const y = phone.store.list().find((e) => e.title === '폰 새 일정');
  phone.store.update(y.id, ev('폰 오프라인 수정이 최신', 9)); await settle();
  assert.strictEqual(Object.keys(phone.store.dirty).length, 1, '못 올린 건 dirty로 남음');
  phone.goOnline(); await settle();
  assert.ok(pc.titles().includes('폰 오프라인 수정이 최신'), '연결되면 자동으로 올라감');
  ok('오프라인 수정은 dirty로 남았다가 연결되면 자동 전송');

  const del = pc.store.list().find((e) => e.title === '폰 오프라인 수정이 최신');
  pc.dev.online = false; pc.store.remove(del.id); await settle();
  pc.goOnline(); await settle();
  assert.ok(!phone.titles().includes('폰 오프라인 수정이 최신'), '오프라인에서 한 삭제도 전달');
  assert.deepStrictEqual(phone.titles(), pc.titles());
  ok('오프라인 삭제 전달 · 양쪽 최종 목록 동일: ' + pc.titles().join(' / '));

  const late = device(be, '새 폰'); late.signIn(); await settle();
  assert.deepStrictEqual(late.titles(), pc.titles());
  ok('새 기기로 로그인하면 전체 일정을 받아 옴');

  const mid = new Backend(); const m1 = device(mid, 'A'); m1.signIn(); await settle();
  m1.dev.online = false; m1.store.add(ev('캐시 단계에서는 올리지 않음')); await settle();
  assert.strictEqual(mid.docs.size, 0);
  console.log('\n모든 동기화 시험 통과');
})().catch((e) => { console.error('\n실패:', e); process.exit(1); });
