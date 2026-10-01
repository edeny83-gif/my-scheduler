const { app, BrowserWindow, ipcMain, Tray, Menu, screen, Notification, shell, net, dialog, safeStorage, clipboard } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { LocalStore } = require('./store');
const { Feeds } = require('./feeds');
const pin = require('./pin');
const ai = require('./ai');
const { extractText } = require('./extract');
const { itemToEvent, eventToItem, findDuplicate, parseYmd, sod } = require('./convert');
const { startApiServer } = require('./api-server');
const { SyncManager } = require('./sync-main');

// 일부 그래픽 드라이버에서 투명 창이 불투명(검정/회색)으로 그려지는 문제를 막는다.
app.disableHardwareAcceleration();

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

const userFile = (name) => path.join(app.getPath('userData'), name);

// ---------- 시작 기록 / 오류 표시 ----------
// 문제가 생기면 %APPDATA%\my-scheduler-desktop\startup.log 내용을 보내주면 원인을 알 수 있다.
function log(...a) {
  try {
    const line = new Date().toISOString() + ' ' + a.map((x) => (x instanceof Error ? x.stack : typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n';
    const f = userFile('startup.log');
    if (fs.existsSync(f) && fs.statSync(f).size > 200000) fs.renameSync(f, f + '.old');
    fs.appendFileSync(f, line);
  } catch {}
}
let errorShown = false;
function fatal(where, err) {
  log('오류', where, err);
  if (errorShown) return;
  errorShown = true;
  try {
    dialog.showErrorBox('MyScheduler 오류', where + '\n\n' + (err && err.stack ? err.stack : err) + '\n\n기록 파일: ' + userFile('startup.log'));
  } catch {}
}
// ---------- 안전 모드 (화면 처리기가 죽으면 설정을 낮춰 자동 재시작) ----------
// 일부 PC(보안 프로그램이 프로세스에 끼어드는 환경 등)에서는 Chromium 샌드박스/GPU 단계에서
// 화면 처리기가 시작하자마자 죽는다(종료 코드 -1073741515 = DLL을 못 찾음).
// 1단계: 샌드박스 끔 / 2단계: + GPU 합성 끔 / 3단계: + GPU를 같은 프로세스에서 실행
// 한 번 정해진 단계는 유지된다. 처음(0단계)으로 되돌리려면 safe-mode.json 파일을 지운다.
const MAX_SAFE_LEVEL = 3;
function readSafeLevel() {
  try { return Math.min(MAX_SAFE_LEVEL, Math.max(0, Number(JSON.parse(fs.readFileSync(userFile('safe-mode.json'), 'utf8')).level) || 0)); }
  catch { return 0; }
}
const safeLevel = readSafeLevel();
if (safeLevel >= 1) app.commandLine.appendSwitch('no-sandbox');
if (safeLevel >= 2) { app.commandLine.appendSwitch('disable-gpu'); app.commandLine.appendSwitch('disable-gpu-compositing'); }
if (safeLevel >= 3) { app.commandLine.appendSwitch('in-process-gpu'); app.commandLine.appendSwitch('disable-gpu-sandbox'); }

app.on('render-process-gone', (_e, _wc, d) => {
  log('화면 처리기 종료', d, 'safeLevel=' + safeLevel);
  if (d.reason === 'clean-exit' || d.reason === 'killed') return;
  if (safeLevel < MAX_SAFE_LEVEL) {
    try { fs.writeFileSync(userFile('safe-mode.json'), JSON.stringify({ level: safeLevel + 1, at: new Date().toISOString(), reason: d })); } catch {}
    log('안전 모드 ' + (safeLevel + 1) + '단계로 다시 시작합니다');
    app.releaseSingleInstanceLock(); // 새로 뜨는 프로세스가 잠금 때문에 바로 종료되지 않도록
    // 포터블 판은 임시 폴더에서 실행되므로 원본 exe로 다시 시작한다
    app.relaunch(process.env.PORTABLE_EXECUTABLE_FILE ? { execPath: process.env.PORTABLE_EXECUTABLE_FILE, args: [] } : {});
    app.exit(0);
    return;
  }
  const hint = d.exitCode === -1073741515 ? '\n\n(필요한 시스템 파일(DLL)을 불러오지 못했습니다. 보안 프로그램이 막고 있을 수 있습니다.)' : '';
  fatal('화면 처리기가 계속 종료됩니다', JSON.stringify(d) + hint);
});
app.on('child-process-gone', (_e, d) => log('하위 프로세스 종료', d));

process.on('uncaughtException', (e) => fatal('예기치 않은 오류', e));
process.on('unhandledRejection', (e) => log('처리되지 않은 Promise 오류', e));

const DEFAULTS = {
  bounds: null,
  fontFamily: 'Malgun Gothic',
  titleSize: 34,
  dateSize: 13,
  eventSize: 12,
  colors: {
    title: '#ffffff',
    weekday: '#d5dde8',
    date: '#f4f7fb',
    sunday: '#ff8f8f',
    saturday: '#90b8ff',
    event: '#a8e0ff',
    list: '#f4f7fb',
  },
  bgColor: '#16202c',
  bgOpacity: 0.35,
  todayColor: '#ffffff',
  todayOpacity: 0.16,
  border: true,
  showList: true,
  showQuick: true,               // 달력 아래 빠른 입력 칸(글·말로 일정 넣기)
  maxLanes: 3,
  locked: false,
  pinToDesktop: false,
  settingsVersion: 2,
  openAtLogin: true,
  holidays: { enabled: true, observances: false },
  google: { enabled: false, email: '', privateUrl: '', color: '#ffd28a' },
  calendars: [],
  ai: {
    provider: 'gemini',            // 'gemini' | 'claude'
    geminiModel: 'gemini-2.5-flash',
    claudeModel: 'claude-sonnet-5-5',
    about: '학교 교사',            // 분석할 때 참고하는 사용자 소개
    autoAdd: false,               // 분석 후 확인 없이 바로 추가
    minConfidence: 0.6,           // 자동 추가·기본 선택 기준
    color: '#ffd28a',             // AI가 넣은 일정 글자색 (빈 값 = 기본색)
  },
  api: { enabled: true, port: 17843 },
  syncPrompted: false,   // 처음 한 번 클라우드 동기화 로그인 안내를 띄웠는지
};

let settings;
let store;
let feeds;
let widget, settingsWin, assistantWin, tray;
let apiServer = null;
let sync = null;
let checkUpdates = null; // 설치본에서만 만들어짐 (자동 업데이트)
let resizeState = null;
let lastReminderCheck = Date.now();

// ---------- 설정 ----------
function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(userFile('settings.json'), 'utf8')); } catch {}
  if ((saved.settingsVersion || 1) < 2) { saved.pinToDesktop = false; saved.locked = false; } // 0.2.0의 고정 방식은 창이 안 보일 수 있었음
  return {
    ...DEFAULTS,
    ...saved,
    colors: { ...DEFAULTS.colors, ...(saved.colors || {}) },
    holidays: { ...DEFAULTS.holidays, ...(saved.holidays || {}) },
    google: { ...DEFAULTS.google, ...(saved.google || {}) },
    ai: { ...DEFAULTS.ai, ...(saved.ai || {}) },
    api: { ...DEFAULTS.api, ...(saved.api || {}) },
  };
}
function saveSettings() {
  fs.writeFileSync(userFile('settings.json'), JSON.stringify(settings, null, 2));
}
function broadcast(channel, data) {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, data);
}
function updateSettings(patch) {
  const prev = settings;
  settings = { ...settings, ...patch };
  saveSettings();
  if (['holidays', 'google', 'calendars'].some((k) => k in patch && JSON.stringify(prev[k]) !== JSON.stringify(settings[k]))) {
    feeds.configure(settings);
  }
  if ('pinToDesktop' in patch && prev.pinToDesktop !== settings.pinToDesktop) applyPin();
  applyWindowSettings();
  broadcast('settings', settings);
  return settings;
}

// ---------- 위젯 창 ----------
function onScreen(b) {
  return b && screen.getAllDisplays().some(({ workArea: a }) =>
    b.x < a.x + a.width - 40 && b.x + b.width > a.x + 40 && b.y < a.y + a.height - 40 && b.y + b.height > a.y);
}
function defaultBounds() {
  const wa = screen.getPrimaryDisplay().workArea;
  const width = Math.min(760, Math.round(wa.width * 0.45));
  const height = Math.min(720, Math.round(wa.height * 0.8));
  return { width, height, x: wa.x + wa.width - width - 40, y: wa.y + 40 };
}

function createWidget() {
  const b = onScreen(settings.bounds) ? settings.bounds : defaultBounds();
  widget = new BrowserWindow({
    ...b,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    // 투명 창에서 resizable:true면 Windows에서 투명이 깨질 수 있어 끄고, 크기 조절은 직접 구현(가장자리 손잡이)
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: false,
    show: false,
    title: 'MyScheduler',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  widget.loadFile(path.join(__dirname, 'src', 'index.html'));
  const wc = widget.webContents;
  wc.on('did-fail-load', (_e, code, desc) => fatal('화면을 불러오지 못했습니다', code + ' ' + desc));
  // 개발 확인용: MS_TEST_CRASH=N 이면 안전 단계가 N 미만일 때 일부러 화면 처리기를 죽여 자동 복구를 시험한다
  if (process.env.MS_TEST_CRASH && safeLevel < Number(process.env.MS_TEST_CRASH)) wc.once('did-finish-load', () => wc.forcefullyCrashRenderer());
  wc.on('console-message', (_e, level, msg) => { if (level >= 2) log('화면 오류:', msg); });
  let shown = false;
  const showIt = () => {
    if (shown || widget.isDestroyed()) return;
    shown = true;
    widget.show();
    log('위젯 표시', widget.getBounds());
    revealOnTop(); // 처음에는 맨 앞에 잠깐 띄워서 위치를 알려준다
  };
  widget.once('ready-to-show', showIt);
  setTimeout(showIt, 4000); // ready-to-show가 안 와도 강제로 표시
  widget.on('moved', saveBounds);
  // "다른 창 뒤에 깔기" 옵션을 켠 경우에만: 클릭해도 다른 창 위로 올라오지 않게 맨 아래로 유지
  widget.on('focus', () => { if (settings.pinToDesktop) setTimeout(() => pin.toBottom(widget), 50); });
  applyWindowSettings();
}

// 위젯을 잠깐 맨 앞으로 (실행 직후, 바로가기·트레이를 다시 눌렀을 때 "여기 있다"를 보여줌)
function revealOnTop() {
  if (!widget || widget.isDestroyed()) return;
  if (widget.isMinimized()) widget.restore();
  if (!onScreen(widget.getBounds())) widget.setBounds(defaultBounds());
  widget.setAlwaysOnTop(true, 'floating');
  widget.show();
  widget.focus();
  setTimeout(() => {
    if (widget.isDestroyed()) return;
    widget.setAlwaysOnTop(false);
    applyPin();
  }, 3500);
}

function applyPin() {
  if (widget && !widget.isDestroyed() && settings.pinToDesktop) log('맨 아래로 내림:', pin.toBottom(widget));
}

function saveBounds() {
  if (!widget || widget.isDestroyed()) return;
  settings.bounds = widget.getBounds();
  saveSettings();
}

function applyWindowSettings() {
  if (widget && !widget.isDestroyed()) widget.setIgnoreMouseEvents(!!settings.locked, { forward: true });
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: !!settings.openAtLogin });
  if (tray) buildTrayMenu();
}

function windowAction(name) {
  if (!widget || widget.isDestroyed()) return;
  const display = screen.getDisplayMatching(widget.getBounds());
  if (name === 'fill') widget.setBounds(display.workArea);
  if (name === 'reset') widget.setBounds(defaultBounds());
  if (name === 'show') revealOnTop();
  saveBounds();
}

function openSettings(section) {
  const hash = typeof section === 'string' ? section : '';
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    if (hash) settingsWin.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`).catch(() => {});
    return settingsWin.focus();
  }
  settingsWin = new BrowserWindow({
    width: 520, height: 760, minWidth: 460, minHeight: 500,
    title: '캘린더 설정', autoHideMenuBar: true, backgroundColor: '#18212c',
    icon: path.join(__dirname, 'assets', 'tray.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  settingsWin.loadFile(path.join(__dirname, 'src', 'settings.html'), hash ? { hash } : undefined);
}

// ---------- 트레이 ----------
function createTray() {
  tray = new Tray(path.join(__dirname, 'assets', 'tray.png'));
  tray.setToolTip('MyScheduler 캘린더');
  tray.on('click', () => windowAction('show'));
  buildTrayMenu();
}
function buildTrayMenu() {
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '일정 추가', click: () => { if (settings.locked) updateSettings({ locked: false }); windowAction('show'); widget.webContents.send('open-add'); } },
    { label: 'AI 비서 (파일로 일정 만들기)', click: () => openAssistant() },
    { label: '클라우드 동기화 (폰 연동)', click: () => openSettings('s-sync') },
    { label: '설정', click: () => openSettings() },
    { type: 'separator' },
    { label: '위젯 잠금 (클릭이 바탕화면으로 통과)', type: 'checkbox', checked: !!settings.locked, click: (i) => updateSettings({ locked: i.checked }) },
    { label: '위젯 보이기 (맨 앞으로)', click: () => windowAction('show') },
    { label: '다른 창 뒤에 깔기', type: 'checkbox', checked: !!settings.pinToDesktop, click: (i) => updateSettings({ pinToDesktop: i.checked }) },
    { label: '바탕화면 전체 크기로', click: () => windowAction('fill') },
    { label: '위치·크기 초기화', click: () => windowAction('reset') },
    { type: 'separator' },
    { label: '업데이트 확인', click: () => (checkUpdates ? checkUpdates(true) : new Notification({ title: 'MyScheduler', body: '설치한 앱에서만 업데이트를 확인할 수 있습니다.' }).show()) },
    { label: '캘린더 새로고침', click: () => feeds.refresh() },
    { label: '데이터 폴더 열기', click: () => shell.openPath(app.getPath('userData')) },
    { type: 'separator' },
    { label: '종료', click: () => app.quit() },
  ]));
}

// ---------- 알림 ----------
function remindText(ev, m) {
  if (ev.allDay) {
    const days = Math.ceil(m / 1440);
    const when = m <= 0 ? '오늘' : days === 1 ? '내일' : `${days}일 후`;
    return `${when} 종일 일정${ev.location ? ` · ${ev.location}` : ''}`;
  }
  const d = new Date(ev.start);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const when = m === 0 ? '지금 시작' : m < 60 ? `${m}분 후 시작` : m < 1440 ? `${m / 60}시간 후 시작` : `${Math.round(m / 1440)}일 후`;
  return `${ev.allDay ? '종일' : hm} · ${when}${ev.location ? ` · ${ev.location}` : ''}`;
}
function checkReminders() {
  const now = Date.now();
  const from = Math.max(lastReminderCheck, now - 10 * 60_000); // 절전 복귀 시 너무 오래된 알림은 생략
  for (const ev of store.list()) {
    for (const m of ev.remind || []) {
      const at = ev.start - m * 60_000;
      if (at > from && at <= now) {
        const n = new Notification({ title: ev.title, body: remindText(ev, m), silent: false });
        n.on('click', () => { windowAction('show'); widget.webContents.send('select-date', ev.start); });
        n.show();
      }
    }
  }
  lastReminderCheck = now;
}

// ---------- AI 비서 ----------
// API 키는 Windows 보안 저장소(safeStorage)로 암호화해 keys.bin에 보관한다.
function loadKeys() {
  try { return JSON.parse(safeStorage.decryptString(fs.readFileSync(userFile('keys.bin')))); }
  catch { return {}; }
}
function saveKeys(keys) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('이 PC에서는 키를 암호화해 저장할 수 없습니다');
  fs.writeFileSync(userFile('keys.bin'), safeStorage.encryptString(JSON.stringify(keys)));
}
const aiFetch = (url, init) => net.fetch(url, init);
const aiOpts = (extra = {}) => ({
  fetch: aiFetch,
  keys: loadKeys(),
  provider: settings.ai.provider,
  geminiModel: settings.ai.geminiModel,
  claudeModel: settings.ai.claudeModel,
  about: settings.ai.about,
  ...extra,
});

/** 파일들을 하나씩 분석하고, 각 항목에 지난 날짜·중복·형식 오류 표시를 붙인다 */
async function analyzeFiles(paths, instruction, onProgress) {
  const results = [];
  for (const file of paths) {
    const fileName = path.basename(file);
    onProgress?.({ file, stage: '준비 중' });
    try {
      const r = await ai.analyzeFile(file, aiOpts({ instruction, onStage: (stage) => onProgress?.({ file, stage }) }));
      log('AI 분석 완료', fileName, r.provider, `${r.items.length}개`);
      results.push(r);
      onProgress?.({ file, stage: '완료', done: true });
    } catch (e) {
      log('AI 분석 실패', fileName, e.message);
      results.push({ file, fileName, error: e.message, items: [], undated: [], summary: '' });
      onProgress?.({ file, stage: e.message, error: true });
    }
  }
  const existing = store.list();
  const today = sod(Date.now());
  for (const r of results) {
    r.items = r.items.map((it) => {
      try {
        const ev = itemToEvent(it, { fileName: r.fileName });
        const dup = findDuplicate(ev, existing);
        return { ...it, fileName: r.fileName, past: (ev.end ?? ev.start) < today, duplicate: dup ? dup.title : '' };
      } catch (e) {
        return { ...it, fileName: r.fileName, invalid: e.message };
      }
    });
  }
  return results;
}

const eligible = (it) => !it.past && !it.duplicate && !it.invalid && (it.confidence ?? 1) >= settings.ai.minConfidence;

/** 항목들을 일정으로 추가하고 Windows 알림으로 알린다 */
function addItems(items, source = 'ai', who = 'AI 비서') {
  const added = [];
  for (const it of items) {
    const ev = itemToEvent(it, {
      color: source === 'ai' ? settings.ai.color : '',
      source,
      fileName: it.fileName || it.sourceNote || '',
    });
    const id = store.add(ev);
    added.push({ id, ...ev });
  }
  if (added.length) notifyAdded(added, who);
  return added;
}

function notifyAdded(added, who) {
  const fmt = (e) => { const d = new Date(e.start); return `${d.getMonth() + 1}/${d.getDate()} ${e.title}`; };
  const body = added.slice(0, 4).map(fmt).join('\n') + (added.length > 4 ? `\n외 ${added.length - 4}개` : '');
  const n = new Notification({ title: `${who}가 일정 ${added.length}개를 추가했습니다`, body });
  const first = Math.min(...added.map((e) => e.start));
  n.on('click', () => { windowAction('show'); widget.webContents.send('select-date', first); });
  n.show();
  if (widget && !widget.isDestroyed()) widget.webContents.send('select-date', first);
}

function openAssistant(paths = []) {
  const send = () => { if (paths.length) assistantWin.webContents.send('assistant-files', paths); };
  if (assistantWin && !assistantWin.isDestroyed()) {
    assistantWin.show();
    assistantWin.focus();
    return send();
  }
  assistantWin = new BrowserWindow({
    width: 820, height: 860, minWidth: 560, minHeight: 520,
    title: 'AI 비서', autoHideMenuBar: true, backgroundColor: '#18212c',
    icon: path.join(__dirname, 'assets', 'tray.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  assistantWin.loadFile(path.join(__dirname, 'src', 'assistant.html'));
  assistantWin.webContents.once('did-finish-load', send);
}

// ---------- Claude Code 연결 ----------
// tools/ 스크립트를 데이터 폴더로 복사해 두면(설치 위치·버전과 무관한 고정 경로) Claude Code가 node로 실행할 수 있다.
function installClaudeTools() {
  const dir = userFile('claude-code');
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (const f of ['client.js', 'mcp-server.js', 'cal.js']) {
      fs.writeFileSync(path.join(dir, f), fs.readFileSync(path.join(__dirname, 'tools', f)));
    }
  } catch (e) { log('Claude Code 도구 복사 실패', e); }
  return dir;
}

function claudeCodeInfo() {
  const dir = userFile('claude-code');
  const script = path.join(dir, 'mcp-server.js');
  const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  return {
    running: !!apiServer,
    port: apiServer?.port || null,
    dir,
    script,
    commandNode: `claude mcp add myscheduler --scope user -- node "${script}"`,
    commandExe: `claude mcp add myscheduler --scope user -e ELECTRON_RUN_AS_NODE=1 -- "${exe}" "${script}"`,
    cli: `node "${path.join(dir, 'cal.js')}" list`,
  };
}

async function startApi() {
  if (!settings.api.enabled) return;
  installClaudeTools();
  const keys = () => loadKeys();
  apiServer = await startApiServer({
    port: settings.api.port,
    file: userFile('api.json'),
    version: app.getVersion(),
    log,
    routes: {
      'GET /events': ({ query }) => {
        const from = parseYmd(query.from) ?? sod(Date.now());
        const toDay = parseYmd(query.to) ?? from + 30 * 86_400_000;
        const to = toDay + 86_400_000 - 1;
        const q = (query.query || '').trim();
        const all = [...store.list(), ...feeds.external]
          .filter((e) => (e.end ?? e.start) >= from && e.start <= to)
          .filter((e) => !q || `${e.title} ${e.memo || ''} ${e.location || ''}`.includes(q))
          .sort((a, b) => a.start - b.start)
          .map(eventToItem);
        const hol = feeds.holidays.filter((h) => { const t = parseYmd(h.date); return t >= from && t <= to; });
        return { count: all.length, events: all, holidays: hol };
      },
      'POST /events': ({ body }) => {
        const list = Array.isArray(body.events) ? body.events : [body];
        const items = list.map((it) => ({ ...it, sourceNote: it.sourceNote || body.sourceNote }));
        const added = addItems(items, 'claude-code', 'Claude Code');
        return { ok: true, added: added.map(eventToItem) };
      },
      'PATCH /events/:id': ({ id, body }) => {
        const cur = store.list().find((e) => e.id === id);
        if (!cur) throw new Error('일정을 찾을 수 없습니다 (외부 캘린더 일정은 수정할 수 없습니다)');
        const merged = { ...eventToItem(cur), ...body };
        if (!('remind' in body)) merged.remind = cur.remind;
        if (!('memo' in body)) merged.memo = cur.memo;
        if ('time' in body && !body.time) merged.allDay = true;
        else if (body.time) merged.allDay = false;
        // 시작만 옮기면 원래 길이를 유지한다 (15:00–16:00 → 시작 16:00이면 16:00–17:00)
        const keepLength = !('endTime' in body) && !('endDate' in body) && merged.allDay === !!cur.allDay;
        if (keepLength) { delete merged.endTime; delete merged.endDate; }
        const ev = itemToEvent(merged, { source: 'claude-code' });
        if (keepLength && cur.end != null) {
          ev.end = cur.allDay ? ev.start + (sod(cur.end) - sod(cur.start)) : ev.start + (cur.end - cur.start);
        }
        ev.color = body.color ?? cur.color;
        store.update(id, ev);
        return { ok: true, event: eventToItem({ ...cur, ...ev, id }) };
      },
      'DELETE /events/:id': ({ id }) => {
        const cur = store.list().find((e) => e.id === id);
        if (!cur) throw new Error('일정을 찾을 수 없습니다');
        store.remove(id);
        return { ok: true, deleted: eventToItem(cur) };
      },
      'POST /extract': ({ body }) => {
        const r = extractText(String(body.path || ''));
        if (!r) throw new Error('HWP·HWPX·DOCX·텍스트 파일만 추출할 수 있습니다 (PDF·사진은 직접 읽으세요)');
        return { text: r.text, truncated: r.truncated };
      },
      'POST /transcribe': async ({ body }) => {
        const text = await ai.transcribe(String(body.path || ''), { fetch: aiFetch, keys: keys(), geminiModel: settings.ai.geminiModel });
        return { text };
      },
      'POST /analyze': async ({ body }) => {
        const paths = (body.paths || []).map(String);
        if (!paths.length) throw new Error('paths가 비어 있습니다');
        const results = await analyzeFiles(paths, body.instruction || '');
        let added = [];
        if (body.add) {
          const ok = results.flatMap((r) => r.items.filter(eligible));
          added = addItems(ok, 'ai', 'AI 비서').map(eventToItem);
        }
        return { results: results.map(({ file, ...r }) => ({ file, ...r })), added };
      },
      'POST /notify': ({ body }) => {
        const n = new Notification({ title: String(body.title || 'MyScheduler'), body: String(body.message || '') });
        const t = parseYmd(body.date);
        n.on('click', () => { windowAction('show'); if (t != null) widget.webContents.send('select-date', t); });
        n.show();
        return { ok: true };
      },
    },
  });
}

// ---------- IPC ----------
ipcMain.handle('get-state', () => ({
  settings,
  events: store.list(),
  external: feeds.external,
  holidays: feeds.holidays,
  feedStatus: feeds.status,
  pinAvailable: pin.available(),
}));
ipcMain.handle('add-event', (_e, ev) => store.add(ev));
ipcMain.handle('update-event', (_e, id, ev) => store.update(id, ev));
ipcMain.handle('delete-event', (_e, id) => store.remove(id));
ipcMain.handle('get-fonts', async () => {
  try {
    const { getFonts } = require('font-list');
    const list = await getFonts({ disableQuoting: true });
    return [...new Set(list)].sort((a, b) => a.localeCompare(b, 'ko'));
  } catch {
    return ['Malgun Gothic', '맑은 고딕', 'Gulim', 'Dotum', 'Batang', 'Arial', 'Segoe UI'];
  }
});
ipcMain.handle('update-settings', (_e, patch) => updateSettings(patch));
ipcMain.handle('reset-settings', (_e, keys) => updateSettings(Object.fromEntries(keys.map((k) => [k, structuredClone(DEFAULTS[k])]))));
ipcMain.handle('open-settings', (_e, section) => openSettings(section));
ipcMain.handle('refresh-feeds', () => feeds.refresh());
ipcMain.handle('window-action', (_e, name) => windowAction(name));

ipcMain.handle('sync-status', () => sync.status());
ipcMain.handle('sync-login', async (_e, email, password) => {
  const r = await sync.login(String(email || ''), String(password || ''));
  return { ok: !!r.ok, error: r.error || '' };
});
ipcMain.handle('sync-logout', async () => {
  const r = await sync.logout();
  return { ok: !!r.ok, error: r.error || '' };
});

ipcMain.handle('open-assistant', (_e, paths) => openAssistant(Array.isArray(paths) ? paths : []));
ipcMain.handle('pick-files', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(win, {
    title: '분석할 파일 선택',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '지원하는 파일', extensions: ai.SUPPORTED.map((x) => x.slice(1)) },
      { name: '모든 파일', extensions: ['*'] },
    ],
  });
  return r.canceled ? [] : r.filePaths;
});
ipcMain.handle('ai-analyze', (e, { paths, instruction }) =>
  analyzeFiles(paths, instruction, (p) => { if (!e.sender.isDestroyed()) e.sender.send('ai-progress', p); }));
// 빠른 입력: 글·말 → AI 분석 → 겹치지 않는 일정만 바로 추가 (되돌리기는 ai-undo)
ipcMain.handle('ai-command', async (e, { text, audio }) => {
  const r = await ai.analyzeCommand({ text, audio }, aiOpts({ onStage: (stage) => { if (!e.sender.isDestroyed()) e.sender.send('ai-progress', { stage }); } }));
  const existing = store.list();
  const ok = [], skipped = [];
  for (const it of r.items) {
    try {
      const ev = itemToEvent(it, { color: settings.ai.color, source: 'ai' });
      const dup = findDuplicate(ev, existing);
      if (dup) skipped.push({ item: it, reason: '이미 있음' }); else ok.push(it);
    } catch (err) { skipped.push({ item: it, reason: err.message }); }
  }
  const added = ok.length ? addItems(ok, 'ai', 'AI 비서') : [];
  return { summary: r.summary, kind: r.kind, added: added.map((a, i) => ({ id: a.id, item: ok[i] })), skipped, undated: r.undated || [] };
});
ipcMain.handle('ai-add', (_e, items) => addItems(items, 'ai', 'AI 비서').map((x) => x.id));
ipcMain.handle('ai-undo', (_e, ids) => { for (const id of ids) store.remove(id); });
ipcMain.handle('ai-status', () => {
  const k = loadKeys();
  return { gemini: !!k.gemini, claude: !!k.claude, encryption: safeStorage.isEncryptionAvailable(), minConfidence: settings.ai.minConfidence };
});
ipcMain.handle('ai-set-key', (_e, provider, key) => {
  if (!['gemini', 'claude'].includes(provider)) throw new Error('알 수 없는 AI');
  const keys = loadKeys();
  if (key) keys[provider] = String(key).trim(); else delete keys[provider];
  saveKeys(keys);
  return true;
});
ipcMain.handle('ai-test', async (_e, provider) => {
  const key = loadKeys()[provider];
  if (!key) throw new Error('저장된 키가 없습니다');
  await ai.testKey(provider, { fetch: aiFetch, key, geminiModel: settings.ai.geminiModel, claudeModel: settings.ai.claudeModel });
  return true;
});
ipcMain.handle('claude-code-info', () => claudeCodeInfo());
ipcMain.handle('copy-text', (_e, text) => clipboard.writeText(String(text)));
ipcMain.handle('open-path', (_e, p) => shell.openPath(String(p)));

ipcMain.on('resize-start', (_e, edge) => { resizeState = { edge: String(edge), b: widget.getBounds() }; });
ipcMain.on('resize-move', (_e, dx, dy) => {
  if (!resizeState) return;
  const MIN_W = 320, MIN_H = 300;
  let { x, y, width, height } = resizeState.b;
  const E = resizeState.edge;
  if (E.includes('e')) width = Math.max(MIN_W, width + dx);
  if (E.includes('s')) height = Math.max(MIN_H, height + dy);
  if (E.includes('w')) { const w = Math.max(MIN_W, width - dx); x += width - w; width = w; }
  if (E.includes('n')) { const h = Math.max(MIN_H, height - dy); y += height - h; height = h; }
  widget.setBounds({ x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) });
});
ipcMain.on('resize-end', () => { resizeState = null; saveBounds(); });

// ---------- 시작 ----------
app.whenReady().then(() => {
  log('시작', app.getVersion(), process.platform, process.arch, 'packaged=' + app.isPackaged, 'safeLevel=' + safeLevel);
  app.setAppUserModelId('com.myscheduler.desktop');
  settings = loadSettings();
  log('단계1 설정 로드');

  store = new LocalStore(app.getPath('userData'));
  log('단계2 일정 저장소');
  store.on('change', (list) => broadcast('events', list));

  // 클라우드 동기화: 로그인하면 폰과 실시간으로 맞춘다 (로그인 전에는 이 PC에서만 동작)
  sync = new SyncManager({
    store, log,
    onState: (s) => {
      broadcast('sync-state', s);
      if (s.phase === 'signed-out' && !settings.syncPrompted) { // 처음 한 번만 로그인 안내
        settings.syncPrompted = true;
        saveSettings();
        setTimeout(() => openSettings('s-sync'), 1500);
      }
    },
  });
  sync.start();

  feeds = new Feeds(app.getPath('userData'), async (url) => {
    const res = await net.fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  });
  feeds.on('change', () => {
    broadcast('external', { external: feeds.external, holidays: feeds.holidays });
    broadcast('feed-status', feeds.status);
  });

  log('단계3 창 만들기 시작');
  createWidget();
  log('단계4 창 생성 완료');
  try { createTray(); } catch (e) { log('트레이 생성 실패', e); }
  log('단계5 트레이 완료');
  feeds.configure(settings);
  log('단계6 캘린더 연동 설정 완료');
  startApi().catch((e) => log('Claude Code 연결 창구 시작 실패', e));
  setInterval(checkReminders, 20_000);

  if (app.isPackaged) {
    const { autoUpdater } = require('electron-updater');
    let manual = false;
    const say = (body) => new Notification({ title: 'MyScheduler', body }).show();
    autoUpdater.on('error', (e) => {
      log('업데이트 확인 실패(무시):', (e && e.message) || e);
      if (manual) { manual = false; say('업데이트를 확인하지 못했습니다. 인터넷 연결(학교 망이면 GitHub 접속 허용 여부)을 확인하세요.'); }
    });
    autoUpdater.on('update-available', (info) => log('새 버전 발견', info.version));
    autoUpdater.on('update-not-available', () => { if (manual) { manual = false; say('최신 버전입니다.'); } });
    autoUpdater.on('update-downloaded', (info) => {
      manual = false;
      log('새 버전 내려받음', info.version);
      const n = new Notification({ title: `새 버전 ${info.version}을 받았습니다`, body: '눌러서 지금 다시 시작하면 바로 적용됩니다. 그냥 두면 앱을 끌 때 설치됩니다.' });
      n.on('click', () => autoUpdater.quitAndInstall(false, true));
      n.show();
    });
    checkUpdates = (isManual) => {
      manual = !!isManual;
      try { return autoUpdater.checkForUpdates().catch(() => {}); } catch (e) { log('업데이트 오류', e); return undefined; }
    };
    setTimeout(() => checkUpdates(false), 10_000);
    setInterval(() => checkUpdates(false), 3 * 3600_000); // 3시간마다
  }
});
app.on('second-instance', () => { log('두 번째 실행 → 기존 위젯 앞으로'); windowAction('show'); });
app.on('window-all-closed', () => { /* 트레이에 상주 */ });
app.on('will-quit', () => apiServer?.close());
