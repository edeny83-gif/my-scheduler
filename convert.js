// AI·Claude Code가 주는 "사람이 읽는 형식"(날짜 문자열) ↔ 저장 형식(ms) 변환, 중복 판별
const pad = (n) => String(n).padStart(2, '0');
const { fixItemTimes } = require('./timeText');

function parseYmd(s) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(s ?? '').trim());
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getMonth() === Number(m[2]) - 1 ? d.getTime() : null;
}
function parseHm(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? '').trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return [Number(m[1]), Number(m[2])];
}
const at = (dayMs, [h, mi]) => { const d = new Date(dayMs); d.setHours(h, mi, 0, 0); return d.getTime(); };
const ymd = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const hm = (ms) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const sod = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };

/** 알림 기본값(분). 종일 일정은 00:00 기준: -480 = 당일 오전 8시, 900 = 전날 오전 9시 */
function defaultRemind(kind, allDay) {
  if (allDay) return kind === '마감' ? [900] : [-480];
  return kind === '마감' ? [60] : [30];
}

/** {title, date, endDate?, time?, endTime?, allDay?, location?, memo?, evidence?, kind?, remind?, color?} → 저장용 일정 */
function itemToEvent(it, { color = '', source = 'ai', fileName = '' } = {}) {
  // "오후 3시"·"14:00~15:00"처럼 오거나 시각이 제목에 섞여 있으면 바로잡는다(안 그러면 종일 일정이 된다)
  if (it.allDay !== true && !parseHm(it.time)) it = fixItemTimes(it);
  const title = String(it.title ?? '').trim();
  if (!title) throw new Error('제목이 없습니다');
  const d = parseYmd(it.date);
  if (d == null) throw new Error(`날짜 형식이 올바르지 않습니다: "${it.date}" (YYYY-MM-DD)`);
  let ed = parseYmd(it.endDate);
  if (ed == null || ed < d) ed = d;
  const t = parseHm(it.time);
  const et = parseHm(it.endTime);
  const allDay = it.allDay != null ? !!it.allDay : t == null;

  let start, end;
  if (allDay) { start = d; end = ed; }
  else {
    start = at(d, t || [9, 0]);
    if (et) end = at(ed, et);
    else if (ed > d) end = at(ed, t || [9, 0]);
    else end = start + 3_600_000;
    if (end < start) end = start + 3_600_000;
  }
  const memo = [
    String(it.memo ?? '').trim(),
    it.evidence ? `근거: "${String(it.evidence).trim()}"` : '',
    fileName ? `출처: ${fileName}` : '',
  ].filter(Boolean).join('\n');
  const remind = Array.isArray(it.remind) ? it.remind.map(Number).filter(Number.isInteger) : defaultRemind(it.kind, allDay);
  return {
    title, start, end, allDay,
    location: String(it.location ?? '').trim(),
    memo,
    color: it.color ?? color,
    remind,
    source,
  };
}

/** 저장 형식 → 사람이 읽는 형식 (Claude Code 응답용) */
function eventToItem(e) {
  const multi = e.end != null && sod(e.end) > sod(e.start);
  return {
    id: e.id,
    title: e.title,
    date: ymd(e.start),
    endDate: multi ? ymd(e.end) : '',
    time: e.allDay ? '' : hm(e.start),
    endTime: e.allDay || e.end == null ? '' : hm(e.end),
    allDay: !!e.allDay,
    location: e.location || '',
    memo: e.memo || '',
    remind: e.remind || [],
    color: e.color || '',
    source: e.source || '',
    ...(e.readOnly ? { readOnly: true, calendar: e.calendar } : {}),
  };
}

const norm = (s) => String(s || '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
/** 같은 날(첫날)에 제목이 같거나 한쪽이 다른 쪽을 포함하면 중복으로 본다 */
function findDuplicate(ev, events) {
  const a = norm(ev.title);
  if (a.length < 2) return null;
  return events.find((x) => {
    if (sod(x.start) !== sod(ev.start)) return false;
    const b = norm(x.title);
    return b.length >= 2 && (a === b || a.includes(b) || b.includes(a));
  }) || null;
}

module.exports = { itemToEvent, eventToItem, findDuplicate, parseYmd, parseHm, defaultRemind, ymd, hm, sod };
