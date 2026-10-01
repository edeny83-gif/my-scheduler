const $ = (s) => document.querySelector(s);
const ICON = { pdf: '📄', text: '📝', image: '🖼', audio: '🎙', unknown: '❔' };
const EXT = {
  pdf: ['pdf'], text: ['hwp', 'hwpx', 'docx', 'txt', 'md', 'csv', 'tsv', 'json', 'html', 'htm', 'ics', 'log'],
  image: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic', 'heif'],
  audio: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'flac', 'webm', 'aiff', 'amr', '3gp'],
};
const kindOf = (p) => {
  const ext = p.split('.').pop().toLowerCase();
  return Object.keys(EXT).find((k) => EXT[k].includes(ext)) || 'unknown';
};
const base = (p) => p.split(/[\\/]/).pop();

let files = [];          // [{ path, stage, state: 'wait'|'busy'|'ok'|'bad' }]
let results = [];        // 분석 결과
let status = null;       // { gemini, claude, minConfidence }
let settings = null;
let busy = false;
let lastAdded = [];

// ---------------- 상태 표시 ----------------
async function refreshStatus() {
  status = await api.aiStatus();
  const st = await api.getState();
  settings = st.settings;
  const el = $('#status');
  const names = [status.gemini && 'Gemini', status.claude && 'Claude'].filter(Boolean);
  if (!names.length) {
    el.className = 'status bad';
    el.innerHTML = 'API 키가 없습니다 · <a id="goSettings">설정에서 입력</a>';
    $('#goSettings').onclick = () => api.openSettings();
  } else {
    el.className = 'status ok';
    const main = settings.ai.provider === 'claude' && status.claude ? 'Claude' : status.gemini ? 'Gemini' : 'Claude';
    el.textContent = `${main}로 분석${status.gemini ? '' : ' · 녹음 분석은 Gemini 키 필요'}${settings.ai.autoAdd ? ' · 자동 추가 켜짐' : ''}`;
  }
  updateRun();
}

// ---------------- 파일 목록 ----------------
function addFiles(paths) {
  for (const p of paths) if (!files.some((f) => f.path === p)) files.push({ path: p, stage: '', state: 'wait' });
  renderFiles();
}
function renderFiles() {
  const ul = $('#files');
  ul.replaceChildren();
  for (const f of files) {
    const li = document.createElement('li');
    const k = kindOf(f.path);
    const ico = document.createElement('span'); ico.className = 'ico'; ico.textContent = ICON[k];
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = base(f.path); nm.title = f.path;
    const st = document.createElement('span');
    st.className = `st ${f.state}`;
    st.textContent = k === 'unknown' ? '지원하지 않는 형식' : f.stage || (f.state === 'wait' ? '대기' : '');
    const rm = document.createElement('button');
    rm.className = 'rm'; rm.textContent = '✕'; rm.title = '목록에서 빼기'; rm.disabled = busy;
    rm.onclick = () => { files = files.filter((x) => x !== f); renderFiles(); };
    li.append(ico, nm, st, rm);
    ul.append(li);
  }
  updateRun();
}
function updateRun() {
  const any = files.some((f) => kindOf(f.path) !== 'unknown');
  $('#run').disabled = busy || !any || !(status?.gemini || status?.claude);
  $('#run').textContent = busy ? '분석 중…' : '분석하기';
}

$('#pick').onclick = async () => addFiles(await api.pickFiles());
const dz = $('#dropzone');
dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#pick').click(); } });
window.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) dz.classList.remove('over'); });
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dz.classList.remove('over');
  addFiles(api.pathsForFiles(e.dataTransfer.files));
});
api.on('assistant-files', (paths) => addFiles(paths));

api.on('ai-progress', ({ file, stage, done, error }) => {
  const f = files.find((x) => x.path === file);
  if (!f) return;
  f.stage = stage;
  f.state = error ? 'bad' : done ? 'ok' : 'busy';
  renderFiles();
});

// ---------------- 분석 ----------------
$('#instruction').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !$('#run').disabled) $('#run').click(); });
$('#run').onclick = async () => {
  const targets = files.filter((f) => kindOf(f.path) !== 'unknown');
  if (!targets.length) return;
  busy = true;
  lastAdded = [];
  targets.forEach((f) => { f.state = 'busy'; f.stage = '대기 중'; });
  renderFiles();
  $('#results').replaceChildren();
  $('#bar').hidden = true;
  try {
    results = await api.analyze({ paths: targets.map((f) => f.path), instruction: $('#instruction').value.trim() });
  } catch (e) {
    results = [];
    alert(`분석하지 못했습니다: ${e.message}`);
  }
  busy = false;
  renderFiles();
  for (const r of results) for (const it of r.items) it.checked = defaultChecked(it);
  renderResults();
  if (settings.ai.autoAdd) await addSelected(true);
};

const defaultChecked = (it) => !it.past && !it.duplicate && !it.invalid && (it.confidence ?? 1) >= (status?.minConfidence ?? 0.6);

// ---------------- 결과 ----------------
function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  Object.assign(e, props);
  e.append(...kids.filter((k) => k != null));
  return e;
}

function renderResults() {
  const box = $('#results');
  box.replaceChildren();
  for (const r of results) {
    const sec = el('section', { className: 'file-result' });
    const via = r.provider ? el('span', { className: 'via', textContent: r.provider === 'claude' ? 'Claude' : 'Gemini' }) : null;
    sec.append(el('h2', {}, `${ICON[r.kind || kindOf(r.file)] || ''} ${r.fileName}`, via));
    if (r.error) { sec.append(el('p', { className: 'err', textContent: r.error })); box.append(sec); continue; }
    if (r.summary) sec.append(el('p', { className: 'summary', textContent: r.summary }));
    if (r.note) sec.append(el('p', { className: 'note', textContent: r.note }));
    if (!r.items.length) sec.append(el('p', { className: 'none', textContent: '날짜가 있는 일정을 찾지 못했습니다.' }));
    for (const it of r.items) sec.append(itemRow(it));
    if (r.undated?.length) sec.append(undatedBlock(r));
    box.append(sec);
  }
  updateBar();
}

function itemRow(it) {
  const row = el('div', { className: 'item' + (it.checked || it.added ? '' : ' off') });
  const ck = el('input', { type: 'checkbox', className: 'ck', checked: !!it.checked, title: '추가할 항목' });
  ck.onchange = () => { it.checked = ck.checked; row.classList.toggle('off', !ck.checked); updateBar(); };
  const kind = el('span', { className: `kind ${String(it.kind || '일정').replace(/\s/g, '')}`, textContent: it.kind || '일정' });
  const t = el('input', { className: 't', value: it.title || '', title: '제목' });
  t.oninput = () => { it.title = t.value; };
  const d = el('input', { type: 'date', value: it.date || '', title: '날짜' });
  d.onchange = () => { it.date = d.value; };
  const tm = el('input', { type: 'time', value: it.time || '', title: '시각 (비우면 종일)' });
  tm.onchange = () => { it.time = tm.value; };
  const more = el('button', { className: 'more', textContent: '▾', title: '자세히' });
  row.append(ck, kind, t, d, tm, more);

  const flags = [];
  if (it.added) { ck.disabled = true; flags.push(['ok', '캘린더에 추가됨']); }
  if (it.invalid) flags.push(['red', it.invalid]);
  if (it.past) flags.push(['', '지난 날짜']);
  if (it.duplicate) flags.push(['', `비슷한 일정 있음: ${it.duplicate}`]);
  if ((it.confidence ?? 1) < (status?.minConfidence ?? 0.6)) flags.push(['', '확인 필요 (확신 낮음)']);
  if (it.endDate && it.endDate !== it.date) flags.push(['', `~ ${it.endDate}까지`]);
  if (flags.length) row.append(el('div', { className: 'flags' }, ...flags.map(([c, txt]) => el('span', { className: `flag ${c}`, textContent: txt }))));

  const endD = el('input', { type: 'date', value: it.endDate || '' });
  endD.onchange = () => { it.endDate = endD.value; };
  const endT = el('input', { type: 'time', value: it.endTime || '' });
  endT.onchange = () => { it.endTime = endT.value; };
  const loc = el('input', { value: it.location || '' });
  loc.oninput = () => { it.location = loc.value; };
  const memo = el('textarea', { value: it.memo || '', rows: 2 });
  memo.oninput = () => { it.memo = memo.value; };
  const detail = el('div', { className: 'detail', hidden: true },
    el('label', {}, '끝나는 날', endD),
    el('label', {}, '끝나는 시각', endT),
    el('label', { className: 'full' }, '장소', loc),
    el('label', { className: 'full' }, '메모', memo),
    it.evidence ? el('p', { className: 'ev', textContent: `근거: “${it.evidence}”` }) : null,
  );
  more.onclick = () => { detail.hidden = !detail.hidden; more.textContent = detail.hidden ? '▾' : '▴'; };
  row.append(detail);
  return row;
}

function undatedBlock(r) {
  const wrap = el('div', { className: 'undated' }, el('h3', { textContent: '날짜가 없는 할 일 — 날짜를 정하면 추가할 수 있어요' }));
  for (const u of r.undated) {
    const d = el('input', { type: 'date' });
    const btn = el('button', { textContent: '추가' });
    btn.onclick = async () => {
      if (!d.value) return d.focus();
      const ids = await api.addItems([{ title: u.title, date: d.value, kind: '할 일', memo: u.note || '', fileName: r.fileName }]);
      lastAdded.push(...ids);
      btn.textContent = '추가됨'; btn.disabled = true; d.disabled = true;
      showDone(ids.length);
    };
    wrap.append(el('div', { className: 'u' }, el('span', { textContent: u.title }), d, btn, u.note ? el('small', { textContent: u.note }) : null));
  }
  return wrap;
}

// ---------------- 추가 / 되돌리기 ----------------
const selected = () => results.flatMap((r) => r.items.filter((it) => it.checked && !it.added));

function updateBar() {
  const n = selected().length;
  const total = results.reduce((a, r) => a + r.items.length, 0);
  $('#bar').hidden = !total && !lastAdded.length;
  $('#barText').className = '';
  $('#barText').textContent = total ? `찾은 일정 ${total}개 중 ${n}개 선택` : '';
  $('#addSel').disabled = !n;
  $('#addSel').textContent = n ? `선택한 ${n}개 캘린더에 추가` : '추가할 항목을 선택하세요';
  $('#undo').hidden = !lastAdded.length;
}

async function addSelected(auto = false) {
  const items = selected();
  if (!items.length) return;
  try {
    const ids = await api.addItems(items.map(({ checked, past, duplicate, invalid, added, ...it }) => it));
    items.forEach((it) => { it.added = true; it.checked = false; });
    lastAdded.push(...ids);
    renderResults();
    showDone(ids.length, auto);
  } catch (e) {
    alert(`추가하지 못했습니다: ${e.message}`);
  }
}
function showDone(n, auto) {
  updateBar();
  $('#bar').hidden = false;
  $('#barText').className = 'done';
  $('#barText').textContent = `${auto ? '자동으로 ' : ''}${n}개를 캘린더에 추가했습니다.`;
}
$('#addSel').onclick = () => addSelected(false);
$('#undo').onclick = async () => {
  if (!lastAdded.length || !confirm(`방금 추가한 일정 ${lastAdded.length}개를 캘린더에서 지울까요?`)) return;
  await api.undoItems(lastAdded);
  lastAdded = [];
  results.forEach((r) => r.items.forEach((it) => { if (it.added) { it.added = false; it.checked = true; } }));
  renderResults();
  $('#barText').className = '';
  $('#barText').textContent = '되돌렸습니다.';
};

api.on('settings', () => refreshStatus());
window.addEventListener('focus', refreshStatus);
refreshStatus();
