const $ = (s) => document.querySelector(s);
const DOW = ['일', '월', '화', '수', '목', '금', '토'];
const PALETTE = ['#ffffff', '#ffd28a', '#ff9e9e', '#a8e0ff', '#a8f0b8', '#d4b8ff', '#ffb877'];
const REMIND = [[0, '정시'], [5, '5분'], [10, '10분'], [30, '30분'], [60, '1시간'], [1440, '하루']];
// 종일 일정은 00:00 기준: -480 = 당일 오전 8시, 900 = 전날 오전 9시, 2340 = 이틀 전 오전 9시
const REMIND_ALLDAY = [[-480, '당일 오전 8시'], [900, '전날 오전 9시'], [2340, '이틀 전 오전 9시']];

const pad = (n) => String(n).padStart(2, '0');
const ymd = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const hm = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const sod = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
const addDays = (ms, n) => { const d = new Date(ms); d.setDate(d.getDate() + n); return d.getTime(); };
const dayDiff = (a, b) => Math.round((sod(b) - sod(a)) / 86_400_000);
const fromYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };

let settings = {};
let events = [];
let external = [];
let holidays = new Map();
let view = sod(Date.now()); { const d = new Date(view); d.setDate(1); view = d.getTime(); }
let selected = sod(Date.now());
let editing = null;
let formColor = '';
let formRemind = new Set();

// ---------------- 설정 적용 ----------------
function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
function applySettings(s) {
  settings = s;
  const r = document.documentElement.style;
  r.setProperty('--font', `"${s.fontFamily}", "Malgun Gothic", sans-serif`);
  r.setProperty('--title-size', `${s.titleSize}px`);
  r.setProperty('--date-size', `${s.dateSize}px`);
  r.setProperty('--ev-size', `${s.eventSize}px`);
  for (const [k, v] of Object.entries(s.colors)) r.setProperty(`--c-${k === 'weekday' ? 'weekday' : k === 'sunday' ? 'sun' : k === 'saturday' ? 'sat' : k === 'event' ? 'event' : k}`, v);
  r.setProperty('--bg', rgba(s.bgColor, s.bgOpacity));
  r.setProperty('--today', rgba(s.todayColor, s.todayOpacity));
  $('#panel').classList.toggle('bordered', !!s.border);
  $('#list').hidden = !s.showList;
  $('#quick').hidden = s.showQuick === false;
  document.body.classList.toggle('locked', !!s.locked);
  render();
}

// ---------------- 데이터 ----------------
function setHolidays(list) {
  holidays = new Map();
  for (const h of list) {
    if (!h.holiday && !settings.holidays?.observances) continue;
    if (!holidays.has(h.date)) holidays.set(h.date, []);
    holidays.get(h.date).push(h);
  }
}

function allItems() {
  const items = [...events.map((e) => ({ ...e, readOnly: false })), ...external];
  return items.map((e) => {
    const first = sod(e.start);
    const lastRaw = e.allDay ? sod(e.end ?? e.start) : sod(e.end && e.end > e.start ? e.end - 1 : e.start);
    const last = Math.max(first, lastRaw);
    return { ...e, first, last, multi: last > first };
  });
}

const colorOf = (e) => e.color || (e.readOnly ? settings.google?.color : '') || settings.colors.event;
const byTime = (a, b) => (b.allDay - a.allDay) || (a.start - b.start) || a.title.localeCompare(b.title);

// ---------------- 달력 ----------------
function render() {
  if (!settings.colors) return;
  const first = new Date(view);
  $('#month').textContent = first.getMonth() + 1;
  $('#year').textContent = first.getFullYear();

  const dow = $('#dow');
  if (!dow.children.length) {
    DOW.forEach((d, i) => {
      const s = document.createElement('span');
      s.textContent = d;
      if (i === 0) s.className = 'sun';
      if (i === 6) s.className = 'sat';
      dow.append(s);
    });
  }

  const offset = first.getDay();
  const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const weeks = Math.ceil((offset + daysInMonth) / 7);
  const gridStart = addDays(view, -offset);
  const items = allItems();
  const todayKey = ymd(Date.now());
  const maxLanes = Math.max(0, settings.maxLanes ?? 3);

  const grid = $('#grid');
  grid.replaceChildren();
  grid.style.gridTemplateRows = `repeat(${weeks}, minmax(0, 1fr))`;

  for (let w = 0; w < weeks; w++) {
    const weekStart = addDays(gridStart, w * 7);
    const days = [...Array(7)].map((_, i) => addDays(weekStart, i));
    const weekEnd = days[6];

    // 여러 날 일정 → 줄(lane) 배정
    const multis = items
      .filter((e) => e.multi && e.first <= weekEnd && e.last >= weekStart)
      .sort((a, b) => a.first - b.first || (b.last - b.first) - (a.last - a.first));
    const laneEnd = [];
    const hiddenCount = Array(7).fill(0);
    const segs = [];
    for (const e of multis) {
      const a = Math.max(0, dayDiff(weekStart, e.first));
      const b = Math.min(6, dayDiff(weekStart, e.last));
      let lane = laneEnd.findIndex((end) => end < a);
      if (lane < 0) { lane = laneEnd.length; laneEnd.push(b); } else laneEnd[lane] = b;
      if (lane < maxLanes) segs.push({ e, a, b, lane });
      else for (let i = a; i <= b; i++) hiddenCount[i]++;
    }
    const lanes = Math.min(laneEnd.length, maxLanes);

    const week = document.createElement('div');
    week.className = 'week';
    week.style.gridTemplateRows = `auto ${lanes ? `repeat(${lanes}, auto) ` : ''}minmax(0, 1fr)`;

    days.forEach((day, i) => {
      const key = ymd(day);
      const other = new Date(day).getMonth() !== first.getMonth();

      const cell = document.createElement('div');
      cell.className = 'cell';
      if (key === todayKey) cell.classList.add('today');
      if (day === selected) cell.classList.add('selected');
      cell.style.gridColumn = String(i + 1);
      cell.onclick = () => selectDay(day);
      cell.ondblclick = () => openForm(null, day);
      week.append(cell);

      const head = document.createElement('div');
      head.className = 'head';
      if (other) head.classList.add('other');
      if (i === 0) head.classList.add('sun');
      if (i === 6) head.classList.add('sat');
      head.style.gridColumn = String(i + 1);
      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = new Date(day).getDate();
      head.append(num);
      const hol = holidays.get(key);
      if (hol) {
        if (hol.some((h) => h.holiday)) head.classList.add('hol');
        const hn = document.createElement('span');
        hn.className = 'hname' + (hol.some((h) => h.holiday) ? '' : ' obs');
        hn.textContent = hol.map((h) => h.name).join(', ');
        head.append(hn);
      }
      week.append(head);

      const box = document.createElement('div');
      box.className = 'items';
      if (other) box.classList.add('other');
      box.style.gridColumn = String(i + 1);
      box.style.gridRow = String(lanes + 2);
      box.dataset.hidden = hiddenCount[i];
      for (const e of items.filter((x) => !x.multi && x.first === day).sort(byTime)) {
        const d = document.createElement('div');
        d.className = 'ev';
        d.dataset.title = e.title;
        d.style.color = colorOf(e);
        // 칸 안에서는 시간 없이 "· 제목" (하루 여러 일정을 점으로 구분, 시간은 아래 목록·말풍선에)
        const dot = document.createElement('span');
        dot.className = 'dot';
        dot.textContent = '·';
        d.append(dot, document.createTextNode(e.title));
        d.title = tooltip(e);
        d.onclick = (ev) => { ev.stopPropagation(); selectDay(day); openForm(e); };
        box.append(d);
      }
      week.append(box);
    });

    for (const { e, a, b, lane } of segs) {
      const s = document.createElement('div');
      s.className = 'span';
      if (e.last < view || e.first > addDays(view, daysInMonth - 1)) s.classList.add('out');
      s.style.gridColumn = `${a + 1} / ${b + 2}`;
      s.style.gridRow = String(lane + 2);
      s.style.color = colorOf(e);
      s.title = tooltip(e);
      const l = document.createElement('i'); l.className = 'ln l';
      const t = document.createElement('span'); t.className = 'st'; t.textContent = e.title;
      const r = document.createElement('i'); r.className = 'ln r';
      s.append(l, t, r);
      s.onclick = (ev) => { ev.stopPropagation(); openForm(e); };
      week.append(s);
    }
    grid.append(week);
  }
  requestAnimationFrame(fitAll);
  renderList();
}

function tooltip(e) {
  const when = e.allDay
    ? (e.multi ? `${ymd(e.first)} ~ ${ymd(e.last)} 종일` : '종일')
    : `${hm(e.start)}${e.end ? ` ~ ${e.multi ? ymd(e.end) + ' ' : ''}${hm(e.end)}` : ''}`;
  return [e.title, when, e.location, e.calendar ? `[${e.calendar}]` : ''].filter(Boolean).join('\n');
}

// 칸에 다 안 들어가는 일정은 숨기고 "+n" 표시
function fitAll() {
  for (const box of document.querySelectorAll('.items')) {
    box.querySelector('.more')?.remove();
    const evs = [...box.querySelectorAll('.ev')];
    evs.forEach((x) => { x.hidden = false; });
    let hidden = Number(box.dataset.hidden || 0);
    let k = evs.length - 1;
    const overflow = () => box.scrollHeight > box.clientHeight + 1;
    while (overflow() && k >= 0) { evs[k--].hidden = true; hidden++; }
    if (hidden > 0) {
      const more = document.createElement('div');
      more.className = 'more';
      box.append(more);
      const update = () => { more.textContent = `+${hidden}개 더`; };
      update();
      while (overflow() && k >= 0) { evs[k--].hidden = true; hidden++; update(); }
      // 한 줄밖에 없으면 "첫 일정 외 n개"로 합쳐 보여준다
      if (evs.length && evs.every((x) => x.hidden)) {
        const mt = document.createElement('span');
        mt.className = 'mt';
        mt.textContent = evs[0].dataset.title;
        const mc = document.createElement('span');
        mc.className = 'mc';
        mc.textContent = ` 외 ${hidden - 1}`;
        more.replaceChildren(mt, mc);
        more.classList.add('merged');
        more.style.color = evs[0].style.color;
        more.style.opacity = '1';
        if (hidden - 1 === 0) { more.remove(); evs[0].hidden = false; }
      }
      const day = [...box.parentElement.querySelectorAll('.cell')][Number(box.style.gridColumn) - 1];
      more.onclick = (ev) => { ev.stopPropagation(); day?.click(); };
    }
  }
}

// ---------------- 선택한 날 목록 ----------------
function selectDay(day) {
  selected = sod(day);
  document.querySelectorAll('.cell.selected').forEach((c) => c.classList.remove('selected'));
  render();
}

function renderList() {
  if (!settings.showList) return;
  const d = new Date(selected);
  const hol = holidays.get(ymd(selected));
  $('#listTitle').textContent = `${d.getMonth() + 1}월 ${d.getDate()}일 (${DOW[d.getDay()]})${hol ? `  ${hol.map((h) => h.name).join(', ')}` : ''}`;
  const ul = $('#listItems');
  ul.replaceChildren();
  const list = allItems().filter((e) => e.first <= selected && e.last >= selected).sort(byTime);
  if (!list.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '일정이 없습니다. 날짜를 두 번 클릭하거나 ＋를 눌러 추가하세요.';
    ul.append(li);
    return;
  }
  for (const e of list) {
    const li = document.createElement('li');
    const lt = document.createElement('span');
    lt.className = 'lt';
    lt.style.color = colorOf(e);
    lt.textContent = e.allDay ? (e.multi ? `종일 (${dayDiff(e.first, selected) + 1}/${dayDiff(e.first, e.last) + 1}일)` : '종일')
      : `${hm(e.start)}${e.end ? `–${hm(e.end)}` : ''}`;
    const lx = document.createElement('span');
    lx.className = 'lx';
    lx.textContent = e.title + (e.location ? ` · ${e.location}` : '');
    if (e.source === 'ai' || e.source === 'claude-code') {
      const a = document.createElement('span');
      a.className = 'ai';
      a.textContent = e.source === 'ai' ? '✦ AI' : '✦ Claude Code';
      lx.append(a);
    }
    if (e.calendar) {
      const lc = document.createElement('span');
      lc.className = 'lc';
      lc.textContent = e.calendar;
      lx.append(lc);
    }
    li.append(lt, lx);
    li.onclick = () => openForm(e);
    ul.append(li);
  }
}

// ---------------- 입력 창 ----------------
function buildFormControls() {
  const sw = $('#swatches');
  const def = document.createElement('button');
  def.type = 'button'; def.className = 'sw def'; def.dataset.c = ''; def.title = '기본색'; def.textContent = '기본';
  sw.append(def);
  for (const c of PALETTE) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'sw'; b.dataset.c = c; b.style.background = c; b.title = c;
    sw.append(b);
  }
  const custom = document.createElement('label');
  custom.className = 'sw custom'; custom.title = '직접 고르기';
  const ci = document.createElement('input'); ci.type = 'color'; ci.id = 'customColor';
  custom.append(ci);
  sw.append(custom);
  sw.addEventListener('click', (e) => {
    const b = e.target.closest('button.sw');
    if (b) { formColor = b.dataset.c; syncSwatches(); }
  });
  ci.addEventListener('input', () => { formColor = ci.value; syncSwatches(); });

  renderChips(false);
}
function renderChips(allDay) {
  const rm = $('#remind');
  rm.replaceChildren();
  for (const [m, label] of allDay ? REMIND_ALLDAY : REMIND) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'chip'; b.dataset.m = m; b.textContent = label;
    b.onclick = () => { formRemind.has(m) ? formRemind.delete(m) : formRemind.add(m); syncChips(); };
    rm.append(b);
  }
  syncChips();
}
function syncSwatches() {
  let matched = false;
  for (const b of document.querySelectorAll('#swatches button.sw')) {
    const on = b.dataset.c.toLowerCase() === formColor.toLowerCase();
    b.classList.toggle('on', on);
    matched ||= on;
  }
  const custom = document.querySelector('.sw.custom');
  custom.classList.toggle('on', !matched && !!formColor);
  if (!matched && formColor) custom.style.boxShadow = `0 0 0 3px ${formColor} inset`; else custom.style.boxShadow = '';
  $('#t').style.color = formColor || settings.colors.event;
}
function syncChips() {
  for (const b of document.querySelectorAll('#remind .chip')) b.classList.toggle('on', formRemind.has(Number(b.dataset.m)));
}
function syncAllDay() { $('.when').classList.toggle('allday', $('#ad').checked); renderChips($('#ad').checked); }

function openForm(item, day) {
  editing = item;
  const ro = !!item?.readOnly;
  $('#f').classList.toggle('readonly', ro);
  $('#ftitle').textContent = ro ? '일정 보기' : item ? '일정 수정' : '일정 추가';
  $('#fsource').textContent = ro ? `${item.calendar} · 보기 전용` : '';
  $('#ferr').textContent = '';

  let s, e;
  if (item) { s = item.start; e = item.end ?? item.start; }
  else {
    const base = sod(day ?? selected);
    const now = new Date();
    const h = base === sod(Date.now()) ? Math.min(23, now.getHours() + 1) : 9;
    s = base + h * 3_600_000;
    e = s + 3_600_000;
  }
  $('#t').value = item?.title || '';
  $('#ad').checked = !!item?.allDay;
  $('#sd').value = ymd(s);
  $('#st').value = item?.allDay ? '09:00' : hm(s);
  $('#ed').value = ymd(e);
  $('#et').value = item?.allDay ? '10:00' : hm(e);
  $('#loc').value = item?.location || '';
  $('#memo').value = item?.memo || '';
  formColor = item?.color || '';
  formRemind = new Set(item ? item.remind || [] : [10]);
  syncSwatches(); syncAllDay();

  for (const el of $('#f').querySelectorAll('input, textarea')) el.disabled = ro;
  for (const el of $('#f').querySelectorAll('.sw, .chip')) el.disabled = ro;
  $('#save').hidden = ro;
  $('#del').hidden = ro || !item;
  $('#form').showModal();
  if (!ro) $('#t').focus();
}

$('#ad').onchange = () => {
  // 종일↔시간 전환 시 알림 기준이 달라지므로 기본값으로 바꾼다
  formRemind = new Set($('#ad').checked ? [-480] : [10]);
  syncAllDay();
};
$('#sd').addEventListener('change', () => { if ($('#ed').value < $('#sd').value) $('#ed').value = $('#sd').value; });
$('#cancel').onclick = () => $('#form').close();
$('#del').onclick = async () => {
  if (!editing || !confirm(`"${editing.title}" 일정을 삭제할까요?`)) return;
  await api.deleteEvent(editing.id);
  $('#form').close();
};
$('#f').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (editing?.readOnly) return;
  const err = (m) => { $('#ferr').textContent = m; };
  const title = $('#t').value.trim();
  if (!title) return err('제목을 입력하세요.');
  if (!$('#sd').value || !$('#ed').value) return err('날짜를 입력하세요.');
  const allDay = $('#ad').checked;
  const sd = fromYmd($('#sd').value), ed = fromYmd($('#ed').value);
  if (ed < sd) return err('종료일이 시작일보다 빠릅니다.');
  const at = (base, t) => { const [h, m] = (t || '00:00').split(':').map(Number); return base + (h * 60 + m) * 60_000; };
  const start = allDay ? sd : at(sd, $('#st').value);
  const end = allDay ? ed : at(ed, $('#et').value);
  if (end < start) return err('종료 시각이 시작 시각보다 빠릅니다.');
  const data = {
    title, start, end, allDay,
    location: $('#loc').value.trim(),
    memo: $('#memo').value.trim(),
    color: formColor,
    remind: [...formRemind],
  };
  try {
    if (editing) await api.updateEvent(editing.id, data);
    else await api.addEvent(data);
    selected = sod(start);
    $('#form').close();
  } catch (e) {
    err(`저장하지 못했습니다: ${e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`);
  }
});

// ---------------- 크기 조절 ----------------
for (const h of document.querySelectorAll('.rz')) {
  h.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    h.setPointerCapture(e.pointerId);
    const sx = e.screenX, sy = e.screenY;
    document.body.classList.add('resizing');
    document.body.style.cursor = getComputedStyle(h).cursor;
    api.resizeStart(h.dataset.edge);
    const move = (ev) => api.resizeMove(ev.screenX - sx, ev.screenY - sy);
    const up = () => {
      h.removeEventListener('pointermove', move);
      h.removeEventListener('pointerup', up);
      document.body.classList.remove('resizing');
      document.body.style.cursor = '';
      api.resizeEnd();
    };
    h.addEventListener('pointermove', move);
    h.addEventListener('pointerup', up);
  });
}
new ResizeObserver(() => requestAnimationFrame(fitAll)).observe($('#grid'));

// ---------------- 이동 ----------------
function changeMonth(delta) {
  const d = new Date(view);
  if (delta === 0) {
    const t = new Date(); t.setDate(1); t.setHours(0, 0, 0, 0);
    view = t.getTime();
    selected = sod(Date.now());
  } else {
    d.setMonth(d.getMonth() + delta);
    view = d.getTime();
  }
  render();
}
$('#prev').onclick = () => changeMonth(-1);
$('#next').onclick = () => changeMonth(1);
$('#today').onclick = () => changeMonth(0);
$('#add').onclick = () => openForm(null);
$('#listAdd').onclick = () => openForm(null, selected);
$('#gear').onclick = () => api.openSettings();
$('#assist').onclick = () => api.openAssistant([]);

// 파일을 위젯에 끌어놓으면 AI 비서로 보낸다
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  const paths = api.pathsForFiles(e.dataTransfer.files);
  if (paths.length) api.openAssistant(paths);
});
let wheelLock = 0;
$('#grid').addEventListener('wheel', (e) => {
  if (Date.now() < wheelLock || Math.abs(e.deltaY) < 20) return;
  wheelLock = Date.now() + 350;
  changeMonth(e.deltaY > 0 ? 1 : -1);
}, { passive: true });

// ---------------- 연결 ----------------
buildFormControls();
api.on('events', (list) => { events = list; render(); });
api.on('external', (d) => { external = d.external; setHolidays(d.holidays); render(); rawHolidays = d.holidays; });
api.on('settings', (s) => { applySettings(s); setHolidays(rawHolidays); render(); });
api.on('select-date', (ms) => {
  selected = sod(ms);
  const d = new Date(ms); d.setDate(1); d.setHours(0, 0, 0, 0);
  view = d.getTime();
  render();
});
api.on('open-add', () => openForm(null));

let rawHolidays = [];
api.getState().then((st) => {
  events = st.events;
  external = st.external;
  rawHolidays = st.holidays;
  applySettings(st.settings);
  setHolidays(rawHolidays);
  render();
});

// 자정이 지나면 오늘 표시 갱신
let lastDay = ymd(Date.now());
setInterval(() => { if (ymd(Date.now()) !== lastDay) { lastDay = ymd(Date.now()); render(); } }, 60_000);

// 동기화 상태 점 (눌러서 설정의 동기화 구역으로)
const SYNC_TIP = { online: ['ok', '동기화됨'], connecting: ['warn', '연결 중'], offline: ['warn', '오프라인 — 연결되면 자동으로 맞춥니다'], error: ['err', '동기화 오류'], 'signed-out': ['', '로그인하면 폰과 동기화됩니다'], starting: ['', ''] };
function showSync(st) {
  if (!st) return;
  const [cls, tip] = SYNC_TIP[st.phase] || ['', ''];
  const el = $('#sync');
  el.className = `sync ${cls}`;
  el.title = [tip, st.error, st.email].filter(Boolean).join(' · ');
}
$('#sync').onclick = () => api.openSettings('s-sync');
api.syncStatus().then(showSync);
api.on('sync-state', showSync);

// ---------------- 빠른 입력: 글이나 말로 적으면 AI가 알아듣고 바로 일정에 넣는다 ----------------
const Q = { busy: false, rec: null, chunks: [], startAt: 0, timer: 0, last: [], removed: [] };
const evLabel = (e) => { const d = new Date(e.start); return `${d.getMonth() + 1}/${d.getDate()}(${DOW[d.getDay()]})${e.allDay ? '' : ` ${hm(e.start)}`} ${e.title}`; };
const qLabel = (it) => {
  const d = fromYmd(it.date);
  return `${new Date(d).getMonth() + 1}/${new Date(d).getDate()}(${DOW[new Date(d).getDay()]})${it.time ? ` ${it.time}${it.endTime ? `~${it.endTime}` : ''}` : ''} ${it.title}`;
};
function qShow(rows, acts = true) {
  const box = $('#qres');
  box.replaceChildren();
  for (const [cls, text, onclick] of rows) {
    const d = document.createElement('div');
    d.className = cls; d.textContent = text; d.title = text;
    if (onclick) d.onclick = onclick;
    box.append(d);
  }
  if (acts) {
    const a = document.createElement('div'); a.className = 'acts';
    if (Q.last.length || Q.removed.length) {
      const u = document.createElement('button'); u.textContent = '되돌리기';
      u.onclick = async () => {
        const n = Q.last.length + Q.removed.length;
        if (Q.last.length) await api.undoItems(Q.last);
        if (Q.removed.length) await api.restoreItems(Q.removed); // 지운 일정 되살리기
        Q.last = []; Q.removed = [];
        qShow([['muted', `${n}개를 되돌렸습니다.`]]);
      };
      a.append(u);
    }
    const c = document.createElement('button'); c.className = 'close'; c.textContent = '닫기';
    c.onclick = () => { box.hidden = true; };
    a.append(c);
    box.append(a);
  }
  box.hidden = false;
}
function qBusy(on, stage = '분석 중') {
  Q.busy = on;
  $('#qtext').disabled = on; $('#qsend').disabled = on; $('#qmic').disabled = on && !Q.rec;
  $('#qtext').placeholder = on ? `${stage}…` : '✦ 예: 내일 3시 상담 / 7일 연극 지워 줘';
}
async function qRun(req) {
  qBusy(true); Q.last = []; Q.removed = [];
  try {
    const r = await api.aiCommand(req);
    Q.last = r.added.map((a) => a.id);
    Q.removed = r.removed || [];
    const rows = [];
    if (r.kind === 'voice' && r.summary) rows.push(['muted', `🎤 “${r.summary}”`]);
    for (const a of r.added) rows.push(['ok', `✓ ${qLabel(a.item)}`, () => selectFromQuick(a.item.date)]);
    for (const e of Q.removed) rows.push(['err', `🗑 지움: ${evLabel(e)}`, () => selectFromQuick(ymd(e.start))]);
    for (const s of r.skipped) rows.push(['muted', `– ${s.item.date ? qLabel(s.item) : s.item.title} — ${s.reason}`]);
    for (const u of r.undated) rows.push(['warn', `? 날짜를 몰라 넣지 못함: ${u.title}`]);
    if (!rows.length || (rows.length === 1 && r.kind === 'voice')) rows.push(['muted', `넣을 일정을 찾지 못했습니다.${r.summary && r.kind !== 'voice' ? ` (${r.summary})` : ''}`]);
    qShow(rows);
    if (req.text) $('#qtext').value = '';
  } catch (e) {
    const msg = String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    qShow([['err', msg, /API 키/.test(msg) ? () => api.openSettings('s-ai') : null]]);
  }
  qBusy(false);
}
function selectFromQuick(date) {
  const ms = fromYmd(date);
  selected = ms;
  const d = new Date(ms); d.setDate(1); view = d.getTime();
  render();
}
$('#qform').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('#qtext').value.trim();
  if (text && !Q.busy) qRun({ text });
});
$('#qmic').onclick = async () => {
  if (Q.rec) { Q.rec.stop(); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const rec = new MediaRecorder(stream);
    Q.rec = rec; Q.chunks = []; Q.startAt = Date.now();
    rec.ondataavailable = (e) => { if (e.data.size) Q.chunks.push(e.data); };
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      clearInterval(Q.timer); Q.rec = null;
      $('#qmic').classList.remove('rec'); $('#qmic').textContent = '🎤';
      if (Date.now() - Q.startAt < 700) { qShow([['err', '너무 짧습니다. 🎤를 누르고 말한 뒤 다시 누르세요']]); qBusy(false); return; }
      const blob = new Blob(Q.chunks, { type: rec.mimeType || 'audio/webm' });
      const data = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.onerror = rej; fr.readAsDataURL(blob); });
      qRun({ audio: { data, mime: blob.type } });
    };
    rec.start();
    $('#qmic').classList.add('rec'); $('#qmic').textContent = '■';
    $('#qres').hidden = true;
    $('#qtext').disabled = true; $('#qsend').disabled = true;
    const tick = () => { $('#qtext').placeholder = `듣는 중… ${Math.floor((Date.now() - Q.startAt) / 1000)}초 (■를 누르면 끝)`; };
    tick(); Q.timer = setInterval(tick, 500);
  } catch (e) {
    qShow([['err', `마이크를 쓸 수 없습니다: ${e.message}. Windows 설정 → 개인 정보 → 마이크에서 데스크톱 앱 허용을 확인하세요`]]);
  }
};
api.on('ai-progress', (p) => { if (Q.busy && p?.stage) $('#qtext').placeholder = `${p.stage}…`; });
