// 공휴일·구글 캘린더·외부 캘린더(iCal URL)를 받아와 읽기 전용 일정으로 만든다.
// 받은 원본은 디스크에 캐시해 인터넷이 없어도 마지막 데이터를 보여준다.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const ICAL = require('ical.js');

const HOLIDAY_URL =
  'https://calendar.google.com/calendar/ical/ko.south_korea%23holiday%40group.v.calendar.google.com/public/basic.ics';
const DAY = 86_400_000;

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (ms, n) => { const d = new Date(ms); d.setDate(d.getDate() + n); return d.getTime(); };

function normalizeUrl(u) {
  return String(u || '').trim().replace(/^webcal:\/\//i, 'https://');
}

function googlePublicUrl(email) {
  return `https://calendar.google.com/calendar/ical/${encodeURIComponent(email.trim())}/public/basic.ics`;
}

/** iCal 텍스트 → 발생 목록 [{uid, title, start, end, allDay, location, memo, description}] (반복 일정 펼침) */
function expandICS(text, rangeDays = 400) {
  const root = new ICAL.Component(ICAL.parse(text));
  for (const tz of root.getAllSubcomponents('vtimezone')) {
    try { ICAL.TimezoneService.register(tz); } catch { /* 이미 등록됨 */ }
  }

  const masters = new Map();
  const exceptions = [];
  for (const v of root.getAllSubcomponents('vevent')) {
    const ev = new ICAL.Event(v);
    if (ev.isRecurrenceException()) exceptions.push(ev);
    else masters.set(ev.uid, ev);
  }
  for (const ex of exceptions) {
    const m = masters.get(ex.uid);
    if (m) m.relateException(ex);
    else masters.set(`${ex.uid}#${ex.recurrenceId}`, ex);
  }

  const from = ICAL.Time.fromJSDate(new Date(Date.now() - rangeDays * DAY), false);
  const to = ICAL.Time.fromJSDate(new Date(Date.now() + rangeDays * DAY), false);
  const out = [];

  const push = (item, s, e) => {
    if (String(item.component.getFirstPropertyValue('status') || '').toUpperCase() === 'CANCELLED') return;
    const allDay = s.isDate;
    const start = s.toJSDate().getTime();
    let end = e ? e.toJSDate().getTime() : null;
    if (allDay) {
      // iCal 종일 일정의 종료일은 "다음 날"(미포함) → 마지막 날(포함)로 바꾼다
      end = end && end > start ? addDays(end, -1) : start;
    } else if (end != null && end < start) end = start;
    out.push({
      uid: item.uid,
      title: item.summary || '(제목 없음)',
      start, end, allDay,
      location: item.location || '',
      memo: item.description || '',
    });
  };

  for (const ev of masters.values()) {
    if (!ev.startDate) continue;
    if (ev.isRecurring()) {
      const it = ev.iterator();
      let t;
      let steps = 0;
      while ((t = it.next()) && steps++ < 20_000) {
        if (t.compare(to) > 0) break;
        const d = ev.getOccurrenceDetails(t);
        if (d.endDate && d.endDate.compare(from) < 0) continue;
        push(d.item, d.startDate, d.endDate);
      }
    } else {
      push(ev, ev.startDate, ev.endDate);
    }
  }
  return out;
}

/** 공휴일 iCal → [{date:'YYYY-MM-DD', name, holiday:boolean}] */
function parseHolidays(text) {
  const list = [];
  for (const o of expandICS(text, 800)) {
    const holiday = !/기념일|observance/i.test(o.memo || '');
    for (let t = o.start; t <= (o.end ?? o.start); t = addDays(t, 1)) {
      list.push({ date: ymd(new Date(t)), name: o.title, holiday });
    }
  }
  return list;
}

class Feeds extends EventEmitter {
  constructor(dir, fetcher) {
    super();
    this.dir = path.join(dir, 'feeds');
    fs.mkdirSync(this.dir, { recursive: true });
    this.fetcher = fetcher; // (url) => Promise<string>
    this.sources = [];
    this.external = [];
    this.holidays = [];
    this.status = {};
    this.timer = null;
  }

  static sourcesFrom(settings) {
    const s = [];
    if (settings.holidays?.enabled) s.push({ id: 'holidays', kind: 'holidays', name: '대한민국 공휴일', url: HOLIDAY_URL });
    const g = settings.google || {};
    if (g.enabled) {
      const url = normalizeUrl(g.privateUrl) || (g.email ? googlePublicUrl(g.email) : '');
      if (url) s.push({ id: 'google', kind: 'events', name: '구글 캘린더', url, color: g.color });
    }
    for (const c of settings.calendars || []) {
      if (c.enabled === false || !normalizeUrl(c.url)) continue;
      s.push({ id: `cal-${c.id}`, kind: 'events', name: c.name || '외부 캘린더', url: normalizeUrl(c.url), color: c.color });
    }
    return s;
  }

  cacheFile(src) {
    const h = crypto.createHash('sha1').update(src.url).digest('hex').slice(0, 10);
    return path.join(this.dir, `${src.id}-${h}.ics`);
  }

  configure(settings) {
    this.sources = Feeds.sourcesFrom(settings);
    for (const id of Object.keys(this.status)) {
      if (!this.sources.some((s) => s.id === id)) delete this.status[id];
    }
    this.build();
    this.refresh();
    clearInterval(this.timer);
    this.timer = setInterval(() => this.refresh(), 30 * 60_000); // 30분마다
  }

  build() {
    const external = [];
    let holidays = [];
    for (const src of this.sources) {
      let text;
      try { text = fs.readFileSync(this.cacheFile(src), 'utf8'); } catch { continue; }
      try {
        if (src.kind === 'holidays') holidays = parseHolidays(text);
        else {
          for (const o of expandICS(text)) {
            external.push({
              ...o,
              id: `${src.id}:${o.uid}:${o.start}`,
              color: src.color || '',
              readOnly: true,
              calendar: src.name,
            });
          }
        }
      } catch (e) {
        this.status[src.id] = { ...this.status[src.id], name: src.name, ok: false, error: `해석 실패: ${e.message}` };
      }
    }
    this.external = external.sort((a, b) => a.start - b.start);
    this.holidays = holidays;
    this.emit('change');
  }

  async refresh() {
    await Promise.all(this.sources.map(async (src) => {
      try {
        const text = await this.fetcher(src.url);
        if (!text.includes('BEGIN:VCALENDAR')) throw new Error('iCal 형식이 아닙니다. 주소를 확인하세요');
        fs.writeFileSync(this.cacheFile(src), text);
        this.status[src.id] = { name: src.name, ok: true, at: Date.now() };
      } catch (e) {
        let msg = e.message;
        if (src.id === 'google' && /404|403/.test(msg)) msg = '캘린더가 공개되어 있지 않습니다. "비공개 iCal 주소"를 입력하세요';
        this.status[src.id] = { ...this.status[src.id], name: src.name, ok: false, error: msg, failedAt: Date.now() };
      }
    }));
    this.build();
  }
}

module.exports = { Feeds, expandICS, parseHolidays, HOLIDAY_URL };
