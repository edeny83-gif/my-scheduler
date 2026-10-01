// 위젯 창을 다른 창들 "뒤"로 내려 바탕화면에 붙어 있는 것처럼 보이게 한다. (Windows 전용, user32 호출)
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
    api = {
      SetWindowPos: u.func('bool __stdcall SetWindowPos(intptr hWnd, intptr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags)'),
    };
  } catch (e) {
    console.error('바탕화면 고정 기능을 불러오지 못했습니다:', e);
  }
  return api;
}

const HWND_BOTTOM = 1;
const SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2, SWP_NOACTIVATE = 0x10;

function hwndOf(win) {
  const b = win.getNativeWindowHandle();
  return b.length >= 8 ? Number(b.readBigUInt64LE(0)) : b.readUInt32LE(0);
}

function toBottom(win) {
  const a = load();
  if (!a || win.isDestroyed()) return false;
  try {
    return !!a.SetWindowPos(hwndOf(win), HWND_BOTTOM, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE);
  } catch (e) {
    console.error('SetWindowPos 실패:', e);
    return false;
  }
}

module.exports = { toBottom, available: () => !!load() };
