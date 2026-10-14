// 위젯 창을 다른 창들 "뒤"로 내려 바탕화면에 붙어 있는 것처럼 보이게 한다. (Windows 전용, user32 호출)
//  · toBottom: 바탕화면(아이콘이 놓인 창) 바로 위, 다른 모든 창 아래로 내린다.
//    그냥 맨 아래(HWND_BOTTOM)로 보내면 일부 Windows에서 바탕화면 창 "밑"으로 들어가 위젯이 안 보일 수 있어서
//    바탕화면 창을 찾아 그 바로 위에 맞춘다. 이미 그 자리면 아무것도 하지 않는다(깜빡임 없음).
//  · setNoActivate: WS_EX_NOACTIVATE를 켜거나 끈다. 단, Chromium(Electron)은 마우스 클릭 때 창 스타일과 상관없이 창을 활성화하므로
//    이것만으로 "눌러도 앞으로 안 나옴"이 되지는 않는다 → dock.js가 활성화되는 순간 곧바로 뒤로 내리고 원래 창으로 키보드 입력을 돌려준다.
//    (Electron의 setFocusable(false)는 클릭 자체를 삼켜 버려서 쓰지 않는다)
// 이전 버전의 "바탕화면(Progman)을 소유자로 지정" 방식은 창이 바탕화면 뒤로 숨어 보이지 않는 경우가 있어 뺐다.
// Windows가 아니거나 호출이 실패하면 아무것도 하지 않는다(일반 창으로 동작).
let api;

function load() {
  if (api !== undefined) return api;
  api = null;
  if (process.platform !== 'win32') return api;
  try {
    const koffi = require('koffi');
    const u = koffi.load('user32.dll');
    // 꼭 필요한 것(SetWindowPos) 말고는 못 불러와도 나머지는 계속 동작하게 따로 불러온다
    const opt = (sig) => { try { return u.func(sig); } catch (e) { console.error('user32 함수를 불러오지 못했습니다:', sig.slice(0, 40), e.message); return null; } };
    api = {
      SetWindowPos: u.func('bool __stdcall SetWindowPos(intptr hWnd, intptr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags)'),
      GetWindow: opt('intptr __stdcall GetWindow(intptr hWnd, uint uCmd)'),
      FindWindowW: opt('intptr __stdcall FindWindowW(str16 lpClassName, str16 lpWindowName)'),
      FindWindowExW: opt('intptr __stdcall FindWindowExW(intptr hWndParent, intptr hWndChildAfter, str16 lpszClass, str16 lpszWindow)'),
      GetWindowLongW: opt('int __stdcall GetWindowLongW(intptr hWnd, int nIndex)'),
      SetWindowLongW: opt('int __stdcall SetWindowLongW(intptr hWnd, int nIndex, int dwNewLong)'),
      SetPropW: opt('int __stdcall SetPropW(intptr hWnd, str16 lpString, intptr hData)'),
      GetPropW: opt('intptr __stdcall GetPropW(intptr hWnd, str16 lpString)'),
      RemovePropW: opt('intptr __stdcall RemovePropW(intptr hWnd, str16 lpString)'),
      GetForegroundWindow: opt('intptr __stdcall GetForegroundWindow()'),
      SetForegroundWindow: opt('int __stdcall SetForegroundWindow(intptr hWnd)'),
      IsWindowVisible: opt('int __stdcall IsWindowVisible(intptr hWnd)'),
      IsIconic: opt('int __stdcall IsIconic(intptr hWnd)'),
    };
  } catch (e) {
    console.error('바탕화면 고정 기능을 불러오지 못했습니다:', e);
  }
  return api;
}

const HWND_TOP = 0, HWND_BOTTOM = 1;
const SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2, SWP_NOACTIVATE = 0x10;
const GW_HWNDPREV = 3;
const GWL_EXSTYLE = -20;
const WS_EX_TOPMOST = 0x8, WS_EX_NOACTIVATE = 0x08000000;

function hwndOf(win) {
  const b = win.getNativeWindowHandle();
  return b.length >= 8 ? Number(b.readBigUInt64LE(0)) : b.readUInt32LE(0);
}

/** 바탕화면 아이콘이 놓인 창: 아이콘 목록(SHELLDLL_DefView)을 가진 WorkerW, 없으면 Progman */
function desktopHost(os) {
  if (!os.FindWindowW) return 0;
  if (os.FindWindowExW) {
    let w = 0;
    for (let i = 0; i < 16; i++) {
      w = os.FindWindowExW(0, w, 'WorkerW', null);
      if (!w) break;
      if (os.FindWindowExW(w, 0, 'SHELLDLL_DefView', null)) return w;
    }
  }
  return os.FindWindowW('Progman', null) || 0;
}

/**
 * hwnd를 "바탕화면 바로 위, 다른 모든 창 아래"로 옮긴다. 돌려주는 값:
 *  'same' 이미 그 자리 · 'above-desktop' 바탕화면 바로 위로 옮김 · 'top' 열린 창이 없어 일반 창 중 맨 위(=바탕화면 위)로 옮김
 *  'bottom' 바탕화면 창을 못 찾아 맨 아래로 보냄 · 'fail' 실패
 */
function sinkTo(os, hwnd) {
  const flags = SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE;
  const put = (after, tag) => (os.SetWindowPos(hwnd, after, 0, 0, 0, 0, flags) ? tag : 'fail');
  const host = os.GetWindow ? desktopHost(os) : 0;
  if (!host) return put(HWND_BOTTOM, 'bottom');
  const above = os.GetWindow(host, GW_HWNDPREV); // 바탕화면 바로 위에 있는 창
  if (above === hwnd) return 'same';
  if (!above) return put(HWND_BOTTOM, 'bottom');
  // 바로 위가 항상-위 창(작업표시줄 등)이면 그 뒤에 끼우면 우리도 항상-위가 되어 버린다 → 일반 창 중 맨 위로
  if (os.GetWindowLongW && (os.GetWindowLongW(above, GWL_EXSTYLE) & WS_EX_TOPMOST)) return put(HWND_TOP, 'top');
  return put(above, 'above-desktop');
}

/** 위젯을 바탕화면 바로 위(다른 창들 아래)로 내린다. 결과 문구(sinkTo 참고) 또는 false(할 수 없음) */
function toBottom(win) {
  const a = load();
  if (!a || win.isDestroyed()) return false;
  try {
    const r = sinkTo(a, hwndOf(win));
    return r === 'fail' ? false : r;
  } catch (e) {
    console.error('SetWindowPos 실패:', e);
    return false;
  }
}

/** 눌러도 활성화되지 않는 창으로 바꾼다(on=true) / 되돌린다(on=false) */
function setNoActivate(win, on) {
  const a = load();
  if (!a || !a.GetWindowLongW || !a.SetWindowLongW || win.isDestroyed()) return false;
  try {
    const h = hwndOf(win);
    const cur = a.GetWindowLongW(h, GWL_EXSTYLE);
    const next = on ? (cur | WS_EX_NOACTIVATE) : (cur & ~WS_EX_NOACTIVATE);
    if (next !== cur) a.SetWindowLongW(h, GWL_EXSTYLE, next);
    return true;
  } catch (e) {
    console.error('SetWindowLong 실패:', e);
    return false;
  }
}

// Chromium은 창에 이 이름의 속성이 있으면 "다음 한 번의" 마우스 클릭 때 창을 활성화하지 않는다(ui::kIgnoreTouchMouseActivateForWindow,
// 터치 메뉴용 내부 장치). 붙여 둔 위젯을 눌러도 앞으로 튀어나오거나 쓰던 창의 키보드 입력을 빼앗지 않게 클릭 전에 켜 둔다.
// Electron 버전이 바뀌어 이 장치가 사라져도 위험은 없다 — 그때는 dock.js가 활성화된 위젯을 곧바로 뒤로 내리고 입력을 돌려준다.
const IGNORE_ACTIVATE_PROP = 'Chrome.IgnoreMouseActivate';
function armNoActivate(win, on = true) {
  const a = load();
  if (!a || !a.SetPropW || !a.GetPropW || !a.RemovePropW || win.isDestroyed()) return false;
  try {
    const h = hwndOf(win);
    if (on) { if (!a.GetPropW(h, IGNORE_ACTIVATE_PROP)) a.SetPropW(h, IGNORE_ACTIVATE_PROP, 1); }
    else a.RemovePropW(h, IGNORE_ACTIVATE_PROP);
    return true;
  } catch (e) {
    console.error('클릭 활성화 방지 속성 실패:', e);
    return false;
  }
}

/** 지금 앞에 있는(키보드 입력을 받는) 창. 위젯을 쓰고 나서 이 창으로 되돌려 주려고 기억해 둔다. 모르면 0 */
function getForeground() {
  const a = load();
  if (!a || !a.GetForegroundWindow) return 0;
  try { return a.GetForegroundWindow() || 0; } catch { return 0; }
}
/** 기억해 둔 창을 다시 앞으로(아직 보이고 최소화되지 않았을 때만). 했으면 true */
function setForeground(h) {
  const a = load();
  if (!a || !h || !a.SetForegroundWindow || !a.IsWindowVisible || !a.IsIconic) return false;
  try { return !!a.IsWindowVisible(h) && !a.IsIconic(h) && !!a.SetForegroundWindow(h); } catch { return false; }
}

module.exports = { toBottom, setNoActivate, armNoActivate, getForeground, setForeground, hwnd: (win) => { try { return hwndOf(win); } catch { return 0; } }, available: () => !!load(), _sinkTo: sinkTo, _desktopHost: desktopHost };
