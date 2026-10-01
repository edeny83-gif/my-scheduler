const $ = (s) => document.querySelector(s);
let s;
let feedStatus = {};

const debounce = (fn, ms = 500) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const save = (patch) => api.updateSettings(patch).then((ns) => { s = ns; });

function fill() {
  $('#fontFamily').value = s.fontFamily;
  for (const k of ['titleSize', 'dateSize', 'eventSize', 'maxLanes']) $(`#${k}`).value = s[k];
  $('#bgOpacity').value = Math.round(s.bgOpacity * 100);
  $('#todayOpacity').value = Math.round(s.todayOpacity * 100);
  $('#bgColor').value = s.bgColor;
  $('#todayColor').value = s.todayColor;
  for (const el of document.querySelectorAll('[data-color]')) el.value = s.colors[el.dataset.color];
  for (const k of ['showList', 'showQuick', 'border', 'pinToDesktop', 'locked', 'openAtLogin']) $(`#${k}`).checked = !!s[k];
  $('#holEnabled').checked = s.holidays.enabled;
  $('#holObs').checked = s.holidays.observances;
  $('#gEnabled').checked = s.google.enabled;
  $('#gEmail').value = s.google.email || '';
  $('#gUrl').value = s.google.privateUrl || '';
  $('#gColor').value = s.google.color;
  $('#gBox').hidden = !s.google.enabled;
  renderCals();
  outputs();
}

function outputs() {
  const fmt = { titleSize: 'px', dateSize: 'px', eventSize: 'px', bgOpacity: '%', todayOpacity: '%', maxLanes: '줄', aiMin: '%' };
  for (const o of document.querySelectorAll('output[data-for]')) o.textContent = $(`#${o.dataset.for}`).value + fmt[o.dataset.for];
  const p = $('#preview').style;
  p.fontFamily = `"${$('#fontFamily').value}", "Malgun Gothic", sans-serif`;
  p.color = s.colors.date;
  p.background = `color-mix(in srgb, ${s.bgColor} ${Math.max(35, s.bgOpacity * 100)}%, #3b4a5e)`;
}

// ---- 기본 항목 연결 ----
function bind(id, key, conv = (el) => el.value, evt = 'input') {
  $(`#${id}`).addEventListener(evt, () => { outputs(); save({ [key]: conv($(`#${id}`)) }); });
}
bind('fontFamily', 'fontFamily', undefined, 'change');
for (const k of ['titleSize', 'dateSize', 'eventSize', 'maxLanes']) bind(k, k, (el) => Number(el.value));
bind('bgOpacity', 'bgOpacity', (el) => Number(el.value) / 100);
bind('todayOpacity', 'todayOpacity', (el) => Number(el.value) / 100);
bind('bgColor', 'bgColor');
bind('todayColor', 'todayColor');
for (const k of ['showList', 'showQuick', 'border', 'pinToDesktop', 'locked', 'openAtLogin']) bind(k, k, (el) => el.checked, 'change');
for (const el of document.querySelectorAll('[data-color]')) {
  el.addEventListener('input', () => { s.colors = { ...s.colors, [el.dataset.color]: el.value }; outputs(); save({ colors: s.colors }); });
}
$('#resetColors').onclick = async () => {
  s = await api.resetSettings(['colors', 'bgColor', 'bgOpacity', 'todayColor', 'todayOpacity', 'titleSize', 'dateSize', 'eventSize', 'border']);
  fill();
};
for (const b of document.querySelectorAll('[data-win]')) b.onclick = () => api.windowAction(b.dataset.win);

// ---- 공휴일 ----
$('#holEnabled').onchange = () => save({ holidays: { ...s.holidays, enabled: $('#holEnabled').checked } });
$('#holObs').onchange = () => save({ holidays: { ...s.holidays, observances: $('#holObs').checked } });

// ---- 구글 ----
const saveGoogle = () => save({
  google: {
    enabled: $('#gEnabled').checked,
    email: $('#gEmail').value.trim(),
    privateUrl: $('#gUrl').value.trim(),
    color: $('#gColor').value,
  },
});
$('#gEnabled').onchange = () => { $('#gBox').hidden = !$('#gEnabled').checked; saveGoogle(); };
$('#gEmail').addEventListener('input', debounce(saveGoogle, 900));
$('#gUrl').addEventListener('input', debounce(saveGoogle, 900));
$('#gColor').addEventListener('input', debounce(saveGoogle, 300));

// ---- 외부 캘린더 ----
const COLORS = ['#c9a8ff', '#a8f0b8', '#ffb877', '#ff9e9e', '#ffd28a'];
function renderCals() {
  const box = $('#cals');
  box.replaceChildren();
  s.calendars.forEach((c, i) => {
    const row = document.createElement('div');
    row.className = 'cal';
    row.innerHTML = `
      <input type="text" class="name" placeholder="이름 (예: 학교 행사)">
      <input type="color" class="color" title="표시 색">
      <label class="onoff"><input type="checkbox" class="on"> 표시</label>
      <button type="button" class="del" title="삭제">삭제</button>
      <input type="url" class="url" placeholder="https://... .ics 또는 webcal://...">
      <p class="status" data-status="cal-${c.id}"></p>`;
    row.querySelector('.name').value = c.name || '';
    row.querySelector('.url').value = c.url || '';
    row.querySelector('.color').value = c.color || COLORS[i % COLORS.length];
    row.querySelector('.on').checked = c.enabled !== false;
    const update = () => {
      const list = [...s.calendars];
      list[i] = {
        ...c,
        name: row.querySelector('.name').value.trim(),
        url: row.querySelector('.url').value.trim(),
        color: row.querySelector('.color').value,
        enabled: row.querySelector('.on').checked,
      };
      save({ calendars: list });
    };
    row.querySelector('.name').addEventListener('input', debounce(update, 800));
    row.querySelector('.url').addEventListener('input', debounce(update, 900));
    row.querySelector('.color').addEventListener('input', debounce(update, 300));
    row.querySelector('.on').onchange = update;
    row.querySelector('.del').onclick = async () => {
      if (!confirm(`"${c.name || '이 캘린더'}"를 목록에서 삭제할까요?`)) return;
      await save({ calendars: s.calendars.filter((x) => x.id !== c.id) });
      renderCals();
    };
    box.append(row);
  });
  showStatus();
}
$('#addCal').onclick = async () => {
  const id = Math.random().toString(36).slice(2, 10);
  await save({ calendars: [...s.calendars, { id, name: '', url: '', color: COLORS[s.calendars.length % COLORS.length], enabled: true }] });
  renderCals();
  $('#cals .cal:last-child .name').focus();
};
$('#refresh').onclick = async () => {
  $('#refresh').textContent = '새로고침 중…';
  await api.refreshFeeds();
  $('#refresh').textContent = '지금 새로고침';
};

function showStatus() {
  for (const p of document.querySelectorAll('[data-status]')) {
    const st = feedStatus[p.dataset.status];
    p.className = 'status';
    if (!st) { p.textContent = ''; continue; }
    if (st.ok) {
      p.classList.add('ok');
      p.textContent = `불러옴 · ${new Date(st.at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}`;
    } else {
      p.classList.add('bad');
      p.textContent = `불러오지 못함: ${st.error}`;
    }
  }
}

// ---- 시작 ----
(async () => {
  const st = await api.getState();
  s = st.settings;
  feedStatus = st.feedStatus || {};
  if (!st.pinAvailable) {
    $('#pinToDesktop').disabled = true;
    $('#pinNote').textContent = '이 환경에서는 사용할 수 없습니다';
  }
  const fonts = await api.getFonts();
  const sel = $('#fontFamily');
  for (const f of fonts.includes(s.fontFamily) ? fonts : [s.fontFamily, ...fonts]) {
    const o = document.createElement('option');
    o.value = f; o.textContent = f;
    sel.append(o);
  }
  fill();
})();
api.on('feed-status', (st) => { feedStatus = st; showStatus(); });
api.on('settings', (ns) => {
  s = ns;
  for (const k of ['locked', 'pinToDesktop']) $(`#${k}`).checked = !!s[k]; // 트레이에서 바꾼 값 반영
});

// ---------------- AI 비서 ----------------
async function fillAi() {
  const st = await api.aiStatus();
  const show = (id, has) => {
    const p = $(id);
    p.className = 'status ' + (has ? 'ok' : '');
    p.textContent = has ? '키 저장됨 (암호화)' : '키 없음';
  };
  show('#stGemini', st.gemini);
  show('#stClaude', st.claude);
  if (!st.encryption) { $('#stGemini').className = 'status bad'; $('#stGemini').textContent = '이 PC에서는 키를 암호화해 저장할 수 없습니다'; }
  $('#aiProvider').value = s.ai.provider;
  $('#aiColor').value = s.ai.color || '#ffd28a';
  $('#aiAbout').value = s.ai.about || '';
  $('#aiAuto').checked = !!s.ai.autoAdd;
  $('#aiMin').value = Math.round((s.ai.minConfidence ?? 0.6) * 100);
  $('#aiGeminiModel').value = s.ai.geminiModel;
  $('#aiClaudeModel').value = s.ai.claudeModel;
  outputs();
  $('output[data-for=aiMin]').textContent = `${$('#aiMin').value}%`;
}
const saveAi = (patch) => save({ ai: { ...s.ai, ...patch } });
$('#aiProvider').onchange = () => saveAi({ provider: $('#aiProvider').value });
$('#aiColor').addEventListener('input', debounce(() => saveAi({ color: $('#aiColor').value }), 300));
$('#aiAbout').addEventListener('input', debounce(() => saveAi({ about: $('#aiAbout').value.trim() }), 800));
$('#aiAuto').onchange = () => saveAi({ autoAdd: $('#aiAuto').checked });
$('#aiMin').addEventListener('input', () => {
  $('output[data-for=aiMin]').textContent = `${$('#aiMin').value}%`;
  saveAi({ minConfidence: Number($('#aiMin').value) / 100 });
});
$('#aiGeminiModel').addEventListener('input', debounce(() => saveAi({ geminiModel: $('#aiGeminiModel').value.trim() || 'gemini-2.5-flash' }), 800));
$('#aiClaudeModel').addEventListener('input', debounce(() => saveAi({ claudeModel: $('#aiClaudeModel').value.trim() || 'claude-sonnet-5-5' }), 800));

for (const b of document.querySelectorAll('[data-save]')) {
  b.onclick = async () => {
    const provider = b.dataset.save;
    const input = provider === 'gemini' ? $('#kGemini') : $('#kClaude');
    const p = provider === 'gemini' ? $('#stGemini') : $('#stClaude');
    try {
      await api.setKey(provider, input.value.trim());
      input.value = '';
      await fillAi();
      if (!p.textContent.includes('없음')) p.textContent = '키 저장됨 (암호화) · "연결 확인"으로 시험해 보세요';
    } catch (e) { p.className = 'status bad'; p.textContent = e.message; }
  };
}
for (const b of document.querySelectorAll('[data-test]')) {
  b.onclick = async () => {
    const provider = b.dataset.test;
    const p = provider === 'gemini' ? $('#stGemini') : $('#stClaude');
    p.className = 'status'; p.textContent = '확인 중…';
    try { await api.testKey(provider); p.className = 'status ok'; p.textContent = '연결 성공 · 분석할 준비가 됐습니다'; }
    catch (e) { p.className = 'status bad'; p.textContent = '연결 실패: ' + e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''); }
  };
}

// ---------------- Claude Code ----------------
async function fillClaudeCode() {
  const info = await api.claudeCodeInfo();
  $('#ccState').className = 'status ' + (info.running ? 'ok' : 'bad');
  $('#ccState').textContent = info.running ? `연결 창구 열림 (이 PC 안에서만, 포트 ${info.port})` : '연결 창구가 꺼져 있습니다';
  $('#ccNode').textContent = info.commandNode;
  $('#ccExe').textContent = info.commandExe;
  $('#ccFolder').onclick = () => api.openPath(info.dir);
}
for (const b of document.querySelectorAll('[data-copy]')) {
  b.onclick = async () => {
    await api.copyText($(`#${b.dataset.copy}`).textContent);
    b.textContent = '복사됨';
    setTimeout(() => { b.textContent = '복사'; }, 1500);
  };
}
(async () => {
  while (!s) await new Promise((r) => setTimeout(r, 50));
  fillAi();
  fillClaudeCode();
})();

// ---------------- 클라우드 동기화 ----------------
const PHASE = { starting: '준비 중…', 'signed-out': '로그인하지 않음 — 이 PC에서만 저장됩니다', connecting: '연결 중…', online: '동기화됨', offline: '오프라인 — 연결되면 자동으로 맞춥니다', error: '오류' };
function renderSync(st) {
  if (!st) return;
  const out = st.phase === 'signed-out' || st.phase === 'starting' || (st.phase === 'error' && !st.email);
  $('#syncForm').hidden = !out;
  $('#syncAccount').hidden = out;
  $('#syncWho').textContent = st.email || '';
  const p = $('#syncState');
  p.className = 'status ' + (st.phase === 'online' ? 'ok' : st.phase === 'error' ? 'bad' : '');
  p.textContent = (PHASE[st.phase] || st.phase) + (st.error ? ` — ${st.error}` : '');
}
api.syncStatus().then(renderSync);
api.on('sync-state', renderSync);
$('#syncLogin').onclick = async () => {
  const email = $('#syncEmail').value.trim(), pw = $('#syncPw').value;
  const p = $('#syncState');
  if (!email || !pw) { p.className = 'status bad'; p.textContent = '이메일과 비밀번호를 입력하세요.'; return; }
  $('#syncLogin').disabled = true; p.className = 'status'; p.textContent = '로그인 중…';
  const r = await api.syncLogin(email, pw);
  $('#syncLogin').disabled = false;
  if (r.ok) { $('#syncPw').value = ''; } else { p.className = 'status bad'; p.textContent = r.error || '로그인하지 못했습니다.'; }
};
$('#syncPw').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#syncLogin').click(); });
$('#syncLogout').onclick = async () => { if (confirm('로그아웃할까요? 이 PC의 일정은 그대로 남고, 동기화만 멈춥니다.')) await api.syncLogout(); };
