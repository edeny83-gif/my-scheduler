// 사람이 쓴 시각 글자 해석 — "오후 2시 반", "14:00~15:30", "2~3시", "2시부터 3시까지", "3pm"
// (폰 src/core/timeText.js · PC timeText.js 공통: 두 파일 내용이 똑같아야 한다)
// AI가 시각을 time 칸 대신 제목에 섞어 넣거나 "오후 3시"처럼 주면 종일 일정이 되던 것을 바로잡는다.
const pad = (n) => String(n).padStart(2, '0');
const MER = '오전|오후|아침|점심|저녁|밤|새벽|낮';
const isPm = (mark) => /^(오후|점심|저녁|밤|낮|p)$/i.test(mark);
const DASH = '~|∼|〜|-|–|—';

// 시각 하나: [오전/오후] 숫자 + ( :분 | 시 [n분|반] ) [am/pm]
//  · "3시간" "시험" "시작" 같은 말의 '시'는 시각이 아니다
//  · "2~3시"의 앞 숫자처럼 뒤에 범위가 이어지면 '시' 없이도 시각으로 본다
const TOKEN = new RegExp(
  `(?:(${MER})\\s*)?(\\d{1,2})` +
  `(?:\\s*:\\s*(\\d{2})(?::\\d{2})?` +
  `|\\s*시(?![간험작청장각즌리절설행대])(?:\\s*(\\d{1,2})\\s*분|\\s*(반))?` +
  `|(?=\\s*(?:${DASH})\\s*(?:(?:${MER})\\s*)?\\d{1,2}\\s*(?:시|:))` +
  `|(?=\\s*[AaPp]\\.?\\s*[Mm](?![A-Za-z])))` +
  `(?:\\s*([AaPp])\\.?\\s*[Mm]\\.?(?![A-Za-z]))?`,
  'g',
);
const SEP = new RegExp(`^\\s*(?:${DASH}|부터|에서)\\s*$`);

function tokens(s) {
  const out = [];
  TOKEN.lastIndex = 0;
  let m;
  while ((m = TOKEN.exec(s))) {
    if (!m[0]) { TOKEN.lastIndex++; continue; }
    const from = m.index, to = m.index + m[0].length;
    if (from > 0 && /[0-9:./]/.test(s[from - 1])) continue; // 2026.10.15, 10/15, 12:30의 뒷부분
    if (m[3] != null && /\d/.test(s[to] || '')) continue;
    const h = Number(m[2]);
    const mi = m[3] != null ? Number(m[3]) : m[4] != null ? Number(m[4]) : m[5] ? 30 : 0;
    if (h > 23 || mi > 59) continue;
    const bare = m[3] == null && !/시/.test(m[0]) && !m[6]; // "2~3시"의 2처럼 범위 앞에서만 쓰는 숫자
    out.push({ from, to, mark: m[6] || m[1] || '', h, mi, two: m[2].length === 2, bare });
  }
  return out;
}

/** [시, 분]. 오전·오후가 없고 한 자리인 1~6시는 학교 일과 기준으로 오후 */
function clock(t, inherit = '') {
  let h = t.h;
  const mark = t.mark || (t.two ? '' : inherit);
  if (mark) { if (isPm(mark)) { if (h < 12) h += 12; } else if (h === 12) h = 0; }
  else if (!t.two && h >= 1 && h <= 6) h += 12;
  return [h, t.mi];
}

/** 글 속 시각들: [{ start:[h,m], end:[h,m]|null, from, to }] (from~to = 글에서 차지한 자리) */
function findTimes(text) {
  const s = String(text ?? '');
  const tk = tokens(s);
  const res = [];
  for (let i = 0; i < tk.length; i++) {
    const a = tk[i], b = tk[i + 1];
    if (b && SEP.test(s.slice(a.to, b.from))) {
      const start = clock(a);
      let end = clock(b, a.mark);
      if (end[0] * 60 + end[1] <= start[0] * 60 + start[1]) end = end[0] + 12 <= 23 ? [end[0] + 12, end[1]] : null;
      const tail = /^\s*까지/.exec(s.slice(b.to));
      res.push({ start, end, from: a.from, to: b.to + (tail ? tail[0].length : 0) });
      i++;
      continue;
    }
    if (!a.bare) res.push({ start: clock(a), end: null, from: a.from, to: a.to });
  }
  return res;
}

const fmt = ([h, m]) => `${pad(h)}:${pad(m)}`;

/** 글에서 시각 부분(과 바로 붙은 '에·부터·까지·쯤')을 빼고 다듬는다 */
function stripTime(text, f) {
  const s = String(text);
  let to = f.to;
  const after = /^(에서|에|부터|까지|쯤|경)(?=\s|$|[,.)\]])/.exec(s.slice(to));
  if (after) to += after[0].length;
  return (s.slice(0, f.from) + ' ' + s.slice(to))
    .replace(/\(\s*\)|\[\s*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,·:~∼〜\-–—]+|[\s,·:~∼〜\-–—]+$/g, '')
    .trim();
}

/** time·endTime 칸 값 → { start, end } (이미 "HH:mm"이면 그대로 믿는다) */
function readField(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const m = /^(\d{2}):(\d{2})$/.exec(s);
  if (m) return Number(m[1]) <= 23 && Number(m[2]) <= 59 ? { start: [Number(m[1]), Number(m[2])], end: null } : null;
  return findTimes(s)[0] || null;
}

/**
 * AI 항목의 시각을 바로잡는다.
 *  - time·endTime이 "오후 3시", "14:00~15:00"처럼 와도 "HH:mm"으로
 *  - time이 비었는데 제목에 시각이 있으면 가져오고, 제목에서는 시각을 뺀다
 *  - sourceText(사용자가 쓴 요청)에 시각이 하나뿐이면 빠진 시작·끝 시각을 채운다
 * allDay:true로 분명히 정한 항목은 건드리지 않는다.
 */
function fixItemTimes(it, sourceText = '') {
  if (!it || it.allDay === true) return it;
  const x = { ...it };
  const t = readField(x.time), e = readField(x.endTime);
  x.time = t ? fmt(t.start) : '';
  x.endTime = e ? fmt(e.start) : t && t.end ? fmt(t.end) : '';
  const title = String(x.title ?? '');
  const ft = findTimes(title)[0];
  if (ft) {
    if (!x.time) { x.time = fmt(ft.start); if (ft.end && !x.endTime) x.endTime = fmt(ft.end); }
    if (x.time === fmt(ft.start)) { const c = stripTime(title, ft); if (c) x.title = c; }
  }
  if (sourceText) {
    const fs = findTimes(sourceText);
    if (fs.length === 1) {
      if (!x.time) x.time = fmt(fs[0].start);
      if (x.time === fmt(fs[0].start) && fs[0].end && !x.endTime) x.endTime = fmt(fs[0].end);
    }
  }
  if (x.endTime && x.endTime <= x.time && !x.endDate) x.endTime = '';
  return x;
}

module.exports = { findTimes, stripTime, fixItemTimes };
