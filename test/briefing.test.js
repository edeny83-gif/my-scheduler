// 브리핑 저장·표시 규칙 시험 — 일정 모델은 그대로이고, 같은 날짜는 하나만 남는다
process.env.TZ = 'Asia/Seoul';
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { itemToEvent, sod } = require('../convert');
const { isBriefing, briefingTitle, briefingItem, upsertBriefing, MAX_TEXT } = require('../briefing');

const ok = (m) => console.log('  ✓', m);

// 가짜 저장소(list/add/update)
const makeStore = () => {
  const items = [];
  let n = 0;
  return { items, list: () => items, add: (ev) => { const id = `e${++n}`; items.push({ ...ev, id }); return id; }, update: (id, ev) => { const i = items.findIndex((x) => x.id === id); items[i] = { ...items[i], ...ev }; } };
};
const deps = { itemToEvent, sod };

console.log('브리핑 저장');
assert.strictEqual(briefingTitle('2026-11-03'), '📋 브리핑 11/3');
ok('제목은 "📋 브리핑 M/D"');

const item = briefingItem({ date: '2026-11-03', text: '# 오늘\n- 출석부 제출' });
assert.strictEqual(item.allDay, true);
assert.deepStrictEqual(item.remind, []);
ok('종일 일정·알림 없음');

assert.throws(() => briefingItem({ date: '2026-11-03', text: '   ' }), /비어/);
ok('빈 글은 거절');

const store = makeStore();
const a = upsertBriefing(store, { date: '2026-11-03', text: '첫 글' }, deps);
assert.strictEqual(a.created, true);
const ev = store.items[0];
assert.strictEqual(ev.title, '📋 브리핑 11/3');
assert.strictEqual(ev.memo, '첫 글');
assert.strictEqual(ev.allDay, true);
assert.strictEqual(ev.source, 'claude-code');
assert.ok(new Date(ev.start).getDate() === 3 && new Date(ev.start).getMonth() === 10, '그 날짜의 일정');
ok('일정 하나로 저장(날짜·메모·출처)');

const b = upsertBriefing(store, { date: '2026-11-03', text: '고친 글' }, deps);
assert.strictEqual(b.created, false);
assert.strictEqual(b.id, a.id);
assert.strictEqual(store.items.length, 1);
assert.strictEqual(store.items[0].memo, '고친 글');
ok('같은 날짜는 글만 바뀐다(하나만 남음)');

upsertBriefing(store, { date: '2026-11-04', text: '다음 날' }, deps);
assert.strictEqual(store.items.length, 2);
ok('다른 날짜는 따로');

store.add(itemToEvent({ title: '📋 브리핑 이야기 모임', date: '2026-11-03', time: '15:00' }, { source: '' }));
const c = upsertBriefing(store, { date: '2026-11-03', text: '또 고침' }, deps);
assert.strictEqual(c.id, a.id, '시간이 있는 일정은 브리핑으로 치지 않고, 원래 브리핑을 계속 갱신한다');
assert.strictEqual(store.items.filter((x) => x.title === '📋 브리핑 이야기 모임').length, 1, '시간 일정은 건드리지 않는다');
ok('시간이 있는 일정은 브리핑으로 보지 않음');

assert.ok(isBriefing({ title: '📋 브리핑 11/3', allDay: true }));
assert.ok(!isBriefing({ title: '📋 브리핑 11/3', allDay: false }));
assert.ok(!isBriefing({ title: '📋 브리핑 11/3', allDay: true, readOnly: true }), '외부 캘린더 일정은 브리핑이 아니다');
assert.ok(!isBriefing({ title: '회의', allDay: true }));
ok('브리핑 판별');

const long = briefingItem({ date: '2026-11-03', text: 'x'.repeat(MAX_TEXT + 500) });
assert.ok(long.memo.length < MAX_TEXT + 100 && long.memo.endsWith('잘렸습니다)'));
ok('너무 긴 글은 잘라 저장');

console.log('MCP 도구');
const srv = spawn(process.execPath, [path.join(__dirname, '..', 'tools', 'mcp-server.js')], { stdio: ['pipe', 'pipe', 'inherit'] });
let out = '';
srv.stdout.on('data', (d) => { out += d; });
srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
setTimeout(() => {
  srv.kill();
  const tools = JSON.parse(out.trim().split('\n')[0]).result.tools;
  const t = tools.find((x) => x.name === 'briefing_save');
  assert.ok(t, 'briefing_save 도구가 있다');
  assert.deepStrictEqual(t.inputSchema.required, ['date', 'text']);
  ok('briefing_save 등록됨(date·text 필수)');
  console.log('모두 통과');
}, 800);
