// 바탕화면에 붙이기(도킹) 상태 관리. Electron 창·Windows 호출은 모두 밖에서 받아(주입) 시험할 수 있게 했다.
//
//  자유(edit)   settings.docked=false. 일반 창처럼 끌어서 옮기고 가장자리로 크기를 바꾼다. "설치" 버튼을 누르면 붙는다.
//  붙임(idle)   settings.docked=true.  항상 다른 창 뒤. 끌어도 안 움직이고 한 번 눌러도 반응이 없다. 더블클릭하면 입력 가능(active).
//  입력(active) 붙은 채로 잠깐 입력할 수 있는 상태. 한동안 쓰지 않거나 다른 창을 누르거나 Esc를 누르면 붙임으로 돌아간다.
// ⚙(설정)는 붙임 상태에서도 한 번만 눌러 열 수 있고, 열면서 자유(edit)로 바꿔 위치·크기를 조정할 수 있게 한다(edit()).
//
// settings.docked가 바뀌면 main.js의 updateSettings가 apply()를 부른다(install·edit·설정창 체크박스 모두 같은 길).
function createDock({
  getWin,                      // () => BrowserWindow | null
  pin,                         // { toBottom(win), setNoActivate(win, on) }
  getSettings,                 // () => settings
  update,                      // (patch) => settings  (저장하고 apply()까지 이어지는 main의 updateSettings)
  send,                        // (channel, data) => void  (모든 창에 알림)
  log = () => {},
  timers = { set: setTimeout, clear: clearTimeout },
  now = Date.now,
  idleMs = 30_000,             // 입력 상태에서 이만큼 아무것도 안 하면 다시 붙임으로
  busyMs = 120_000,            // 입력 창이 열려 있거나 AI가 일하는 중이면 이만큼까지 기다림
  snapMs = 450,                // "착 붙는" 효과를 보여 준 뒤 뒤로 내린다
}) {
  let active = false;
  let lastDocked = null;       // null = 아직 적용 전(시작 직후)
  let revealing = false;       // "위젯 보이기"로 잠깐 앞에 나와 있는 동안
  let snapping = false;        // 붙는 효과를 보여 주는 동안
  let busy = false, lastPing = 0, activatedAt = 0, lastLogAt = 0;
  let prevFg = 0;              // 입력을 시작하기 전에 앞에 있던 창 (끝나면 키보드 입력을 되돌려 준다)
  let lastFg = 0;              // 붙여 두는 동안 마지막으로 앞에 있던 "다른" 창 (위젯이 눌려 활성화되면 여기로 돌려준다)
  let idleT = null, blurT = null, snapT = null, revealT = null;
  const laterT = new Set();

  const win = () => { const w = getWin(); return w && !w.isDestroyed() ? w : null; };
  const docked = () => !!getSettings().docked;
  const state = (extra = {}) => ({ docked: docked(), active: docked() && active, ...extra });
  const emit = (extra) => send('dock-state', state(extra));
  const clear = (t) => { if (t != null) timers.clear(t); };

  /** 바탕화면 바로 위(다른 창 아래)로 내린다. 효과 중·잠깐 앞에 나온 동안·붙이지 않았을 때는 하지 않는다 */
  function sink() {
    const w = win();
    if (!w || !docked() || revealing || snapping) return false;
    const tag = pin.toBottom(w);
    if (tag && tag !== 'same' && now() - lastLogAt > 5000) { lastLogAt = now(); log('바탕화면 위로 내림:', tag); }
    return !!tag;
  }
  // 창이 활성화되면 Windows가 맨 앞으로 올리므로, 곧바로 그리고 조금 뒤에 한 번 더 내린다
  function sinkSoon() {
    sink();
    for (const ms of [80, 300]) {
      const t = timers.set(() => { laterT.delete(t); sink(); }, ms);
      laterT.add(t);
    }
  }
  /** 붙여 둔 대기 상태에서는 다음 클릭이 창을 활성화하지 않게 해 둔다(pin.js 참고). 입력·조정·잠깐 보이기 중에는 풀어서 평소처럼 활성화되게 */
  function armClick() {
    const w = win();
    if (w && pin.armNoActivate) pin.armNoActivate(w, docked() && !active && !revealing);
  }
  /** 위젯이 활성화되어 있으면 키보드 입력을 원래 쓰던 창(없으면 아래 창)에 돌려준다 */
  function handBackFocus(w, to) {
    if (!w.isFocused()) return;
    if (!(to && pin.setForeground && pin.setForeground(to))) w.blur();
  }
  /** 주기적으로 불러 붙여 둔 동안 앞에 있는 다른 창이 무엇인지 기억해 둔다 */
  function tick() {
    const w = win();
    if (!w || !docked() || active || revealing) return;
    armClick(); // 클릭 한 번에 풀리는 장치라서 다시 걸어 둔다(렌더러가 알려 주는 rearm()이 먼저지만 안전하게)
    if (!pin.getForeground) return;
    const fg = pin.getForeground();
    if (fg && fg !== (pin.hwnd ? pin.hwnd(w) : 0)) lastFg = fg;
  }
  function armIdle() { clear(idleT); idleT = timers.set(onIdle, idleMs); }
  function onIdle() {
    idleT = null;
    if (!active) return;
    const limit = busy ? busyMs : idleMs;
    const quiet = now() - lastPing;
    if (quiet >= limit) deactivate('오래 쓰지 않아서');
    else idleT = timers.set(onIdle, limit - quiet);
  }

  /** settings.docked(와 시작 직후)에 맞춰 창 상태를 맞춘다. 여러 번 불러도 안전하다 */
  function apply() {
    const w = win();
    const d = docked();
    const prev = lastDocked;
    lastDocked = d;
    if (!w) return;
    if (!d) {
      active = false; busy = false;
      clear(idleT); clear(blurT); clear(snapT); snapping = false;
      pin.setNoActivate(w, false);
      armClick();
      if (prev === true) { // 붙임을 풀었다 → 일반 창으로 앞에 꺼내 위치·크기를 조정하게 (포커스는 edit()가 가져간다. 설정창 체크박스로 풀 때는 설정창을 그대로 둔다)
        w.setAlwaysOnTop(false);
        w.moveTop();
        log('붙임 풀기 → 위치·크기 조정 가능');
      }
      emit();
      return;
    }
    const fresh = prev !== true;     // 방금 붙였거나 시작 직후
    if (fresh) { active = false; busy = false; clear(idleT); clear(blurT); }
    pin.setNoActivate(w, !active);
    armClick();
    const snap = fresh && prev === false; // 시작 직후(prev=null)에는 효과를 보이지 않는다
    if (snap) {
      snapping = true;
      clear(snapT);
      snapT = timers.set(() => {
        snapping = false; snapT = null;
        const x = win();
        if (x && x.isFocused()) x.blur(); // 아직 앞에 있을 때 내려놓아야 아래에 있던 창으로 키보드 입력이 넘어간다
        sink();
      }, snapMs);
      log('바탕화면에 붙임', w.getBounds ? w.getBounds() : '');
    } else sink();
    emit(snap ? { snap: true } : {});
  }

  /** 시작할 때 한 번 (효과 없이 저장된 상태대로) */
  function init() { lastDocked = null; apply(); }

  /** "설치" 버튼: 지금 위치·크기 그대로 붙인다 */
  function install() {
    if (!docked()) update({ docked: true });
    return state();
  }
  /** ⚙·트레이·설정창: 붙임을 풀고 위치·크기를 조정할 수 있게 한다 */
  function edit() {
    if (docked()) update({ docked: false });
    const w = win();
    if (w) { w.moveTop(); w.focus(); }
    return state();
  }

  /** 더블클릭: 붙은 채로 입력할 수 있게 한다 */
  function activate() {
    const w = win();
    if (!w || !docked() || active) return state();
    tick(); // 입력을 시작하기 전에 앞에 있던 창을 확인해 둔다
    active = true; busy = false;
    activatedAt = lastPing = now();
    prevFg = (w.isFocused() ? 0 : (pin.getForeground ? pin.getForeground() : 0)) || lastFg;
    pin.setNoActivate(w, false);   // 키보드 입력을 받으려면 활성화될 수 있는 창이어야 한다
    armClick();
    w.focus();
    sinkSoon();                    // 활성화로 앞에 올라온 창을 다시 뒤로
    armIdle();
    log('붙임: 더블클릭 → 입력 가능');
    emit();
    return state();
  }
  /** 입력 끝: 다시 붙임(눌러도 반응 없음)으로 */
  function deactivate(why = '') {
    if (!active) return state();
    const w = win();
    active = false; busy = false;
    clear(idleT); clear(blurT);
    if (w) {
      pin.setNoActivate(w, true);
      armClick();
      sink();
      handBackFocus(w, prevFg); // 아직 이 위젯이 키보드 입력을 받고 있으면 원래 쓰던 창으로 돌려준다
    }
    prevFg = 0;
    log('붙임: 입력 끝', why);
    emit();
    return state();
  }
  /** 화면에서 쓰는 중이라는 신호. busy=true면 입력 창이 열려 있거나 AI가 일하는 중이라 더 오래 기다린다 */
  function ping(isBusy) {
    if (!active) return;
    lastPing = now();
    busy = !!isBusy;
  }
  function onFocus() {
    clear(blurT);
    if (!docked() || revealing) return;
    sinkSoon();
    if (active) return;
    // 붙여 둔 위젯을 누르면 Chromium이 창을 활성화해 앞으로 올려 버린다 → 곧바로 뒤로 내리고(위), 바로 다음 순서에 원래 쓰던 창으로 키보드 입력을 돌려준다
    timers.set(() => {
      const w = win();
      if (w && docked() && !active && !revealing) handBackFocus(w, lastFg);
    }, 0);
  }
  function onBlur() {
    if (!active || busy) return;
    clear(blurT);
    blurT = timers.set(() => {
      blurT = null;
      const w = win();
      // 활성화 직후의 잠깐 흔들림은 무시하고, 정말 다른 곳으로 넘어갔을 때만
      if (active && !busy && w && !w.isFocused() && now() - activatedAt > 700) deactivate('다른 창을 눌러서');
    }, 250);
  }
  /** "위젯 보이기": 잠깐 맨 앞으로 꺼내 위치를 알려 주고, 붙임 상태면 다시 뒤로 */
  function reveal(ms = 3500) {
    const w = win();
    if (!w) return;
    if (w.isMinimized()) w.restore();
    clear(revealT);
    revealing = true;
    pin.setNoActivate(w, false);
    armClick();
    w.setAlwaysOnTop(true, 'floating');
    w.show();
    w.focus();
    const end = () => {
      // 일정 입력 창을 열어 쓰는 중이면 끝날 때까지 앞에 둔다 (쓰는 중 뒤로 숨어 버리지 않게)
      if (docked() && active && busy && now() - lastPing < busyMs) { revealT = timers.set(end, 3000); return; }
      revealing = false; revealT = null;
      const x = win();
      if (!x) return;
      x.setAlwaysOnTop(false);
      if (docked()) {
        if (!active && x.isFocused()) x.blur(); // 아직 앞에 있을 때 내려놓아야 아래에 있던 창으로 키보드 입력이 넘어간다
        pin.setNoActivate(x, !active);
        armClick();
        sink();
      }
    };
    revealT = timers.set(end, ms);
  }
  /** 화면에서 마우스를 놓을 때마다: 다음 클릭도 활성화되지 않게 다시 걸어 둔다 */
  function rearm() { if (docked() && !active && !revealing) armClick(); }
  /** 주기적으로 불러 순서가 바뀌었으면 바로잡는다(이미 맞으면 아무 일도 안 한다) */
  function enforce() { sink(); }
  function dispose() {
    for (const t of [idleT, blurT, snapT, revealT, ...laterT]) clear(t);
    laterT.clear();
  }

  return { apply, init, install, edit, activate, deactivate, ping, rearm, onFocus, onBlur, reveal, enforce, tick, dispose, state };
}

module.exports = { createDock };
