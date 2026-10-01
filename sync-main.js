// 메인 프로세스의 동기화 관리자: 숨은 창(Firebase)과 일정 저장소를 SyncEngine으로 연결한다.
const { BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const { SyncEngine } = require('./sync-core');

class SyncManager {
  constructor({ store, log, onState }) {
    this.store = store;
    this.log = log || (() => {});
    this.onState = onState || (() => {});
    this.state = { phase: 'starting', email: '', uid: '', error: '' };
    this.pending = new Map();
    this.seq = 0;
    this.handlers = null;
    this.isReady = false;
    this.ready = new Promise((r) => { this.readyResolve = r; });
  }

  start() {
    this.win = new BrowserWindow({
      show: false, width: 420, height: 320,
      webPreferences: { preload: path.join(__dirname, 'sync-preload.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false },
    });
    this.win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) this.log('동기화 창:', msg); });
    this.win.webContents.on('did-fail-load', (_e, code, desc) => this.log('동기화 창을 불러오지 못했습니다', code, desc));
    ipcMain.on('sync-msg', (e, msg) => { if (this.win && e.sender === this.win.webContents) this.onMsg(msg || {}); });
    this.win.loadFile(path.join(__dirname, 'src', 'sync.html'));

    const remote = {
      start: (h) => { this.handlers = h; },
      push: async (docs) => {
        const r = await this.request({ cmd: 'push', docs });
        if (!r.ok) { const e = new Error(r.error || '올리기 실패'); e.code = r.code; throw e; }
      },
    };
    this.engine = new SyncEngine({ store: this.store, remote, log: this.log });
    this.engine.start();

    setTimeout(() => {
      if (this.isReady) return;
      this.state = { phase: 'error', email: '', uid: '', error: '동기화 모듈을 불러오지 못했습니다 (src/sync-window.bundle.js가 없습니다)' };
      this.log(this.state.error);
      this.onState(this.state);
      this.readyResolve();
    }, 12_000);
  }

  onMsg(m) {
    if (m.type === 'ready') { this.isReady = true; this.readyResolve(); return; }
    if (m.type === 'reply') {
      const done = this.pending.get(m.id);
      if (done) { this.pending.delete(m.id); done(m); }
      return;
    }
    if (m.type === 'snapshot') {
      if (this.store.claimOwner(m.uid)) this.log('다른 계정으로 로그인해서 이 PC의 일정을 새 계정의 데이터로 바꿉니다');
      if (this.handlers) this.handlers.onSnapshot(m.docs, { fromCache: m.fromCache });
      return;
    }
    if (m.type === 'state') {
      this.state = { phase: m.phase, email: m.email, uid: m.uid, error: m.error, code: m.code };
      if (m.phase === 'signed-out') this.engine.reset();
      if (m.phase === 'online') this.engine.flush();
      this.log('동기화 상태', m.phase, m.error || '');
      this.onState(this.state);
    }
  }

  async request(msg) {
    await this.ready;
    if (!this.isReady) return { ok: false, error: '동기화 모듈이 준비되지 않았습니다' };
    const id = ++this.seq;
    return new Promise((resolve) => {
      // 올리기(push)는 인터넷이 끊겨 있으면 연결될 때까지 기다린다. 로그인·로그아웃만 시간 제한.
      const timer = msg.cmd === 'push' ? null : setTimeout(() => { this.pending.delete(id); resolve({ ok: false, error: '응답이 없습니다. 인터넷 연결을 확인하세요.' }); }, 30_000);
      this.pending.set(id, (r) => { if (timer) clearTimeout(timer); resolve(r); });
      this.win.webContents.send('cmd', { id, ...msg });
    });
  }

  login(email, password) { return this.request({ cmd: 'login', email, password }); }
  logout() { return this.request({ cmd: 'logout' }); }
  status() { return this.state; }
}

module.exports = { SyncManager };
