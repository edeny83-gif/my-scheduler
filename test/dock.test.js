// 바탕화면에 붙이기(dock.js)와 창 순서 맞추기(pin.js) 시험.
// 실제 Windows·Electron 없이 가짜 창·가짜 user32·가짜 시계로 동작 규칙을 확인한다.
const assert = require('node:assert');
const { createDock } = require('../dock');
const pin = require('../pin');

const ok = (m) => console.log('  ✓', m);

// ---------------- pin.js: 바탕화면 바로 위로 내리기 (가짜 user32) ----------------
function fakeOs(order, props = {}) {
  // order: 위→아래 순서의 창 핸들들. topmost: 항상-위 창들. workers/defViewHolders: WorkerW 구조
  const topmost = props.topmost || new Set();
  const os = {
    calls: [],
    FindWindowW: (cls) => (cls === 'Progman' ? props.progman || 0 : 0),
    FindWindowExW: (parent, after, cls) => {
      if (parent === 0 && cls === 'WorkerW') { const l = props.workers || []; return l[after ? l.indexOf(after) + 1 : 0] || 0; }
      if (cls === 'SHELLDLL_DefView') return (props.defViewHolders || []).includes(parent) ? 9000 + parent : 0;
      return 0;
    },
    GetWindow: (h, cmd) => { const i = order.indexOf(h); if (i < 0) return 0; return (cmd === 3 ? order[i - 1] : order[i + 1]) || 0; },
    GetWindowLongW: (h, idx) => (idx === -20 && topmost.has(h) ? 0x8 : 0),
    SetWindowPos: (h, after, _x, _y, _cx, _cy, flags) => {
      os.calls.push([h, after, flags]);
      const cur = order.indexOf(h); if (cur >= 0) order.splice(cur, 1);
      if (after === 1) order.push(h);                       // HWND_BOTTOM
      else if (after === 0) { let i = 0; while (i < order.length && topmost.has(order[i])) i++; order.splice(i, 0, h); } // HWND_TOP = 일반 창 중 맨 위
      else order.splice(order.indexOf(after) + 1, 0, h);   // 그 창 바로 뒤
      return true;
    },
  };
  return os;
}

console.log('창 순서: 바탕화면 바로 위, 다른 창 아래');
{
  const TASKBAR = 100, A = 11, B = 12, PROGMAN = 50, OURS = 7; // 0·1은 HWND_TOP·HWND_BOTTOM 값이라 피한다
  // 바탕화면 창 "밑"에 들어가 안 보이는 경우 → 바탕화면 바로 위로
  let order = [TASKBAR, A, B, PROGMAN, OURS];
  let os = fakeOs(order, { progman: PROGMAN, topmost: new Set([TASKBAR]) });
  assert.strictEqual(pin._sinkTo(os, OURS), 'above-desktop');
  assert.deepStrictEqual(order, [TASKBAR, A, B, OURS, PROGMAN]);
  assert.strictEqual(os.calls[0][2] & 0x10, 0x10, 'SWP_NOACTIVATE (포커스를 훔치지 않음)');
  // 이미 그 자리면 아무 호출도 하지 않는다(깜빡임 없음)
  const before = os.calls.length;
  assert.strictEqual(pin._sinkTo(os, OURS), 'same');
  assert.strictEqual(os.calls.length, before);
  // 다른 창이 위로 올라와 있던 경우(다른 창 사이)
  order = [TASKBAR, A, OURS, B, PROGMAN];
  os = fakeOs(order, { progman: PROGMAN, topmost: new Set([TASKBAR]) });
  assert.strictEqual(pin._sinkTo(os, OURS), 'above-desktop');
  assert.deepStrictEqual(order, [TASKBAR, A, B, OURS, PROGMAN]);
  // 열린 창이 하나도 없으면 바로 위가 작업표시줄(항상-위) → 끼워 넣으면 항상-위가 되므로 일반 창 중 맨 위로
  order = [TASKBAR, PROGMAN, OURS];
  os = fakeOs(order, { progman: PROGMAN, topmost: new Set([TASKBAR]) });
  assert.strictEqual(pin._sinkTo(os, OURS), 'top');
  assert.deepStrictEqual(order, [TASKBAR, OURS, PROGMAN]);
  // 아이콘이 WorkerW로 옮겨진 바탕화면(배경화면 프로그램): 아이콘이 있는 WorkerW 바로 위
  order = [TASKBAR, A, 61, 60, OURS];
  os = fakeOs(order, { progman: PROGMAN, workers: [60, 61], defViewHolders: [61], topmost: new Set([TASKBAR]) });
  assert.strictEqual(pin._desktopHost(os), 61);
  assert.strictEqual(pin._sinkTo(os, OURS), 'above-desktop');
  assert.deepStrictEqual(order, [TASKBAR, A, OURS, 61, 60]);
  // 바탕화면 창을 못 찾으면 맨 아래로
  order = [A, B, OURS];
  os = fakeOs(order, {});
  assert.strictEqual(pin._sinkTo(os, A), 'bottom');
  assert.deepStrictEqual(order, [B, OURS, A]);
  ok('바탕화면 밑에 숨은 위젯을 바탕화면 바로 위로 · 이미 맞으면 호출 없음 · 항상-위 창 뒤에 끼지 않음 · WorkerW 바탕화면 · 못 찾으면 맨 아래');
  // Windows가 아닌 환경(개발·시험)에서는 아무 일도 하지 않고 오류도 없다
  if (process.platform !== 'win32') {
    const fakeWin = { isDestroyed: () => false, getNativeWindowHandle: () => Buffer.alloc(8) };
    assert.strictEqual(pin.available(), false);
    assert.strictEqual(pin.toBottom(fakeWin), false);
    assert.strictEqual(pin.setNoActivate(fakeWin, true), false);
    assert.strictEqual(pin.getForeground(), 0);
    assert.strictEqual(pin.setForeground(5), false);
  }
  ok('Windows가 아니면 조용히 건너뜀');
}

// ---------------- dock.js: 상태 흐름 ----------------
function clock() {
  let t = 0, id = 0;
  const q = new Map();
  return {
    now: () => t,
    set: (fn, ms) => { const i = ++id; q.set(i, { at: t + ms, fn }); return i; },
    clear: (i) => { q.delete(i); },
    tick(ms) {
      const end = t + ms;
      for (;;) {
        const next = [...q.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        t = Math.max(t, next[1].at); q.delete(next[0]); next[1].fn();
      }
      t = end;
    },
  };
}

function setup({ docked = false, fg = 77 } = {}) {
  const clk = clock();
  const settings = { docked };
  const sent = [];
  const calls = [];
  const win = {
    focused: false, destroyed: false, bounds: { x: 1, y: 2, width: 300, height: 400 },
    isDestroyed() { return this.destroyed; }, isFocused() { return this.focused; },
    focus() { this.focused = true; calls.push('focus'); }, blur() { this.focused = false; calls.push('blur'); },
    moveTop() { calls.push('moveTop'); }, show() { calls.push('show'); }, restore() {}, isMinimized() { return false; },
    setAlwaysOnTop(v) { calls.push(['aot', v]); }, getBounds() { return this.bounds; },
  };
  const p = {
    noact: null, armed: null, fg, restored: [], bottoms: 0,
    toBottom() { this.bottoms++; return 'above-desktop'; },
    setNoActivate(_w, on) { this.noact = on; return true; },
    armNoActivate(_w, on) { this.armed = on; return true; },
    hwnd() { return 5; },
    getForeground() { return this.fg; },
    setForeground(h) { this.restored.push(h); win.focused = false; return true; },
  };
  let dock;
  const update = (patch) => { Object.assign(settings, patch); dock.apply(); return settings; }; // main.js의 updateSettings가 하는 일
  dock = createDock({ getWin: () => win, pin: p, getSettings: () => settings, update, send: (ch, d) => sent.push([ch, d]), timers: clk, now: clk.now });
  const last = () => sent[sent.length - 1][1];
  return { dock, win, pin: p, settings, sent, calls, clk, last };
}

console.log('바탕화면에 붙이기: 상태 흐름');
{
  // 처음(붙이지 않음) → 자유: 일반 창처럼 움직이고, 뒤로 내리지 않는다
  let s = setup({ docked: false });
  s.dock.init();
  assert.deepStrictEqual(s.last(), { docked: false, active: false });
  assert.strictEqual(s.pin.noact, false);
  assert.strictEqual(s.pin.bottoms, 0);
  s.dock.enforce();
  assert.strictEqual(s.pin.bottoms, 0, '붙이지 않았으면 뒤로 내리지 않는다');
  ok('붙이기 전: 일반 창 (뒤로 내리지 않고, 눌러서 활성화 가능)');

  // 설치 버튼: 착! 효과를 먼저 보여 주고, 그 뒤에 맨 뒤로
  s.win.focused = true;
  s.dock.install();
  assert.deepStrictEqual(s.last(), { docked: true, active: false, snap: true });
  assert.strictEqual(s.pin.noact, true, '붙이면 눌러도 활성화되지 않는 창');
  assert.strictEqual(s.pin.bottoms, 0, '효과가 끝나기 전에는 내리지 않음');
  s.clk.tick(449); assert.strictEqual(s.pin.bottoms, 0);
  s.clk.tick(2);
  assert.ok(s.pin.bottoms >= 1, '효과 뒤 바탕화면 위로 내려감');
  assert.ok(s.calls.includes('blur') && !s.win.focused, '내려가기 전에 키보드 입력을 아래 창에 돌려줌');
  assert.deepStrictEqual(s.dock.state(), { docked: true, active: false });
  assert.strictEqual(s.pin.armed, true, '붙은 대기 상태: 다음 클릭이 창을 활성화하지 않게 걸어 둠');
  ok('설치: 효과(snap) 알림 → 잠시 뒤 맨 뒤로, 눌러도 활성화 안 되는 창으로, 키보드 입력 반납');

  // 이미 붙어 있으면 설치를 또 눌러도 변화 없음
  const n = s.sent.length; s.dock.install(); assert.strictEqual(s.sent.length, n);

  // 더블클릭 → 입력 가능
  const b0 = s.pin.bottoms;
  s.dock.activate();
  assert.deepStrictEqual(s.last(), { docked: true, active: true });
  assert.strictEqual(s.pin.noact, false, '입력하려면 활성화 가능해야 함');
  assert.strictEqual(s.pin.armed, false, '입력 중에는 클릭이 평소처럼 창을 활성화해야 함');
  assert.ok(s.calls.includes('focus'));
  s.clk.tick(400);
  assert.ok(s.pin.bottoms >= b0 + 3, '활성화돼도 곧바로·조금 뒤에 다시 맨 뒤로');
  ok('더블클릭: 입력 가능 + 포커스, 앞으로 올라온 창은 곧바로 다시 뒤로');

  // 아무것도 안 하면 30초 뒤 다시 붙임(포커스는 원래 쓰던 창으로)
  s.clk.tick(29_000); assert.strictEqual(s.dock.state().active, true);
  s.dock.ping(false);
  s.clk.tick(29_000); assert.strictEqual(s.dock.state().active, true, '쓰는 중이라는 신호가 오면 연장');
  s.clk.tick(2_000);
  assert.strictEqual(s.dock.state().active, false);
  assert.strictEqual(s.pin.noact, true);
  assert.deepStrictEqual(s.pin.restored, [77], '원래 앞에 있던 창으로 키보드 입력을 돌려줌');
  assert.strictEqual(s.pin.armed, true, '다시 붙으면 클릭 활성화 방지를 다시 걸어 둠');
  ok('30초 쓰지 않으면 다시 붙임, 신호가 오면 연장, 원래 창으로 포커스 반환');

  // 입력 창이 열려 있거나 AI가 일하는 중(busy)이면 더 오래 기다린다
  s.dock.activate();
  s.dock.ping(true);
  s.clk.tick(100_000); assert.strictEqual(s.dock.state().active, true, 'busy면 2분까지 기다림');
  s.clk.tick(30_000); assert.strictEqual(s.dock.state().active, false, '그래도 2분 넘으면 끝');
  ok('입력 창이 열려 있으면 오래 기다리되, 신호가 끊기면 2분 뒤 끝');

  // 다른 창을 눌러서 포커스를 잃으면 다시 붙임 — 단, 활성화 직후의 흔들림은 무시
  s.dock.activate();
  s.win.focused = false; s.dock.onBlur(); s.clk.tick(300);
  assert.strictEqual(s.dock.state().active, true, '활성화 0.7초 안의 blur는 무시');
  s.clk.tick(1000);
  s.win.focused = false; s.dock.onBlur(); s.clk.tick(300);
  assert.strictEqual(s.dock.state().active, false, '다른 창으로 넘어가면 다시 붙임');
  s.dock.activate(); s.clk.tick(1000);
  s.dock.ping(true); s.win.focused = false; s.dock.onBlur(); s.clk.tick(500);
  assert.strictEqual(s.dock.state().active, true, '입력 창이 열려 있으면 잠깐 포커스를 잃어도 유지');
  s.win.focused = true; s.dock.onBlur(); s.dock.onFocus(); s.clk.tick(500); // 되돌아오면 취소
  s.dock.deactivate('Esc');
  assert.strictEqual(s.dock.state().active, false);
  ok('다른 창을 누르면 다시 붙임(활성화 직후 흔들림은 무시, 입력 창 열림은 유지), Esc로도 끝');

  // ⚙: 붙임을 풀고 위치·크기를 조정할 수 있게 (설정창과 함께)
  s.dock.activate();
  s.calls.length = 0;
  s.dock.edit();
  assert.deepStrictEqual(s.last(), { docked: false, active: false });
  assert.strictEqual(s.settings.docked, false);
  assert.strictEqual(s.pin.noact, false);
  assert.ok(s.calls.includes('moveTop') && s.calls.includes('focus') && s.calls.some((c) => Array.isArray(c) && c[0] === 'aot' && c[1] === false));
  assert.strictEqual(s.pin.armed, false, '조정 중에는 클릭이 창을 평소처럼 활성화');
  const b1 = s.pin.bottoms; s.dock.enforce(); assert.strictEqual(s.pin.bottoms, b1, '조정 중에는 뒤로 내리지 않음');
  s.dock.ping(false); s.clk.tick(60_000); // 입력 상태가 아니면 신호·시간 흐름이 아무 일도 하지 않음
  ok('⚙: 붙임 풀기 → 앞으로 꺼내 활성화, 조정하는 동안 뒤로 내리지 않음');
  // 설정창 체크박스로 풀 때는 앞으로만 꺼내고 포커스는 설정창에 둔다
  const sc = setup({ docked: true }); sc.dock.init(); sc.calls.length = 0;
  sc.settings.docked = false; sc.dock.apply();
  assert.ok(sc.calls.includes('moveTop') && !sc.calls.includes('focus'), '체크박스로 풀 때는 포커스를 가져가지 않음');
  ok('설정창 체크박스로 붙임을 풀면 위젯만 앞에 꺼내고 포커스는 설정창에 둠');

  // 다시 설치 (처음 시작할 때 저장된 설정으로도 붙을 수 있다)
  s.dock.install(); s.clk.tick(500);
  assert.strictEqual(s.dock.state().docked, true);
  s = setup({ docked: true });
  s.dock.init();
  assert.deepStrictEqual(s.last(), { docked: true, active: false }, '시작할 때는 효과 없이');
  assert.strictEqual(s.pin.noact, true);
  assert.ok(s.pin.bottoms >= 1, '시작하자마자 맨 뒤로');
  ok('저장된 상태로 시작하면 효과 없이 바로 붙임');

  // 활성화는 붙어 있을 때만
  const f = setup({ docked: false }); f.dock.init();
  f.dock.activate(); assert.strictEqual(f.dock.state().active, false);
  ok('붙지 않은 상태에서는 더블클릭 입력 상태가 생기지 않음');

  // 위젯 보이기: 잠깐 맨 앞으로, 그동안 뒤로 내리지 않고, 끝나면 다시 뒤로(키보드 입력은 아래 창에 돌려줌)
  s = setup({ docked: true }); s.dock.init();
  const b2 = s.pin.bottoms;
  s.dock.reveal(3500);
  s.dock.onFocus(); s.clk.tick(400); s.dock.enforce();
  assert.strictEqual(s.pin.bottoms, b2, '앞에 나와 있는 동안은 내리지 않음');
  assert.ok(s.calls.some((c) => Array.isArray(c) && c[0] === 'aot' && c[1] === true));
  assert.strictEqual(s.pin.restored.length, 0, '앞에 나와 있는 동안은 키보드 입력을 되돌리지 않음');
  s.clk.tick(3200);
  assert.ok(s.pin.bottoms > b2, '끝나면 다시 맨 뒤로');
  assert.strictEqual(s.pin.noact, true);
  assert.ok(s.calls.includes('blur') && !s.win.focused, '끝나면 키보드 입력도 아래 창에 돌려줌');
  ok('위젯 보이기: 잠깐 앞에 나왔다가 다시 뒤로(키보드 입력 반납)');

  // 붙여 둔 위젯을 눌러 Chromium이 활성화해 버린 경우: 곧바로 뒤로 내리고, 원래 쓰던 창으로 키보드 입력을 돌려준다
  s = setup({ docked: true, fg: 77 }); s.dock.init();
  s.dock.tick();                       // 앞에 있는 창(77)을 기억
  s.pin.fg = 5;                        // 위젯이 활성화되면 앞 창이 위젯 자신(5)이 된다
  s.dock.tick();                       // 자기 자신은 기억하지 않는다
  s.win.focused = true;
  const b3 = s.pin.bottoms;
  s.dock.onFocus();
  assert.ok(s.pin.bottoms > b3, '활성화되자마자 곧바로(같은 순간) 뒤로');
  assert.strictEqual(s.pin.restored.length, 0, '키보드 입력 반환은 바로 다음 순서에');
  s.clk.tick(1);
  assert.deepStrictEqual(s.pin.restored, [77]);
  assert.strictEqual(s.win.focused, false);
  // 원래 창을 모르면 그냥 내려놓음
  s = setup({ docked: true, fg: 0 }); s.dock.init(); s.win.focused = true; s.dock.onFocus(); s.clk.tick(1);
  assert.ok(s.calls.includes('blur') && s.pin.restored.length === 0);
  // 입력 중에는(더블클릭 뒤) 키보드 입력을 돌려주지 않는다
  s = setup({ docked: true, fg: 77 }); s.dock.init(); s.dock.activate(); s.clk.tick(500);
  s.dock.onFocus(); s.clk.tick(5);
  assert.strictEqual(s.pin.restored.length, 0);
  assert.strictEqual(s.dock.state().active, true);
  ok('눌려서 활성화된 붙은 위젯: 즉시 뒤로 + 원래 창에 키보드 입력 반환(모르면 내려놓기), 입력 중에는 그대로');

  // 클릭 한 번에 풀리는 "활성화 방지"를 다시 걸어 둔다 (마우스를 놓을 때 · 주기적으로)
  s = setup({ docked: true }); s.dock.init();
  s.pin.armed = false; s.dock.rearm();
  assert.strictEqual(s.pin.armed, true);
  s.pin.armed = false; s.dock.tick();
  assert.strictEqual(s.pin.armed, true);
  s.dock.activate(); s.dock.rearm(); s.dock.tick();
  assert.strictEqual(s.pin.armed, false, '입력 중에는 다시 걸지 않음');
  s.dock.deactivate('시험');
  s.dock.reveal(3500);
  assert.strictEqual(s.pin.armed, false, '잠깐 앞에 나온 동안에는 걸지 않음');
  s.clk.tick(3600);
  assert.strictEqual(s.pin.armed, true, '끝나면 다시 걸어 둠');
  ok('클릭 활성화 방지: 대기 중에만 걸고(마우스를 놓을 때·주기적으로 다시), 입력·조정·잠깐 보이기 중에는 풂');

  // 트레이 "일정 추가"처럼 앞에 꺼내 입력을 시작한 경우: 입력 창이 열려 있는 동안은 뒤로 숨지 않는다
  s = setup({ docked: true }); s.dock.init();
  const b4 = s.pin.bottoms;
  s.dock.reveal(3500); s.dock.activate(); s.dock.ping(true);
  s.clk.tick(4000); s.dock.ping(true);
  s.clk.tick(3000);
  assert.strictEqual(s.pin.bottoms, b4, '입력 창을 열어 둔 동안은 계속 앞에');
  s.dock.ping(false); // 입력 창을 닫음
  s.clk.tick(3100);
  assert.ok(s.pin.bottoms > b4, '입력을 마치면 뒤로');
  ok('앞에 꺼내 입력하는 중에는 입력 창이 닫힐 때까지 뒤로 숨지 않음');

  // 창이 사라져도 오류 없음
  s.win.destroyed = true;
  s.dock.apply(); s.dock.activate(); s.dock.enforce(); s.dock.onBlur(); s.dock.dispose();
  ok('창이 닫힌 뒤에 불려도 오류 없음');
}

console.log('\n모든 붙이기 테스트 통과');
