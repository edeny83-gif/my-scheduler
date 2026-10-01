// 브라우저 미리보기용 가짜 api (Electron 없이 화면 확인)
(() => {
  const today = new Date(); today.setHours(0,0,0,0);
  const d = (n, h = 0, m = 0) => { const x = new Date(today); x.setDate(x.getDate() + n); x.setHours(h, m); return x.getTime(); };
  const settings = {
    fontFamily: 'Noto Sans CJK KR', titleSize: 34, dateSize: 13, eventSize: 12,
    colors: { title: '#ffffff', weekday: '#d5dde8', date: '#f4f7fb', sunday: '#ff8f8f', saturday: '#90b8ff', event: '#a8e0ff', list: '#f4f7fb' },
    bgColor: '#16202c', bgOpacity: 0.35, todayColor: '#ffffff', todayOpacity: 0.16, border: true, showList: true, showQuick: true, maxLanes: 3,
    locked: false, pinToDesktop: true, holidays: { enabled: true, observances: false }, google: { enabled: true, color: '#ffd28a' }, calendars: [],
  };
  let events = [
    { id: '1', title: '학년 협의회', start: d(0, 15), end: d(0, 16), allDay: false, color: '', remind: [10], location: '3층 회의실', memo: '' },
    { id: '2', title: '수학여행', start: d(2), end: d(5), allDay: true, color: '#ffd28a', remind: [] },
    { id: '3', title: '교육청 연수 (원주)', start: d(-3), end: d(-1), allDay: true, color: '#a8f0b8', remind: [] },
    { id: '4', title: '학부모 상담 주간', start: d(7), end: d(11), allDay: true, color: '#d4b8ff', remind: [] },
    { id: '5', title: '독서 행사 준비', start: d(1, 9, 30), end: d(1, 10, 30), allDay: false, color: '', remind: [] },
    { id: '6', title: '과학실 점검', start: d(1, 13), end: d(1, 14), allDay: false, color: '#ff9e9e', remind: [] },
    { id: '7', title: '방과후 회의', start: d(1, 16), end: d(1, 17), allDay: false, color: '', remind: [] },
    { id: '8', title: '생활기록부 마감', start: d(1, 17), end: d(1, 18), allDay: false, color: '#ffb877', remind: [] },
    { id: '9', title: '체육대회', start: d(9), end: d(9), allDay: true, color: '', remind: [] },
  ];
  const external = [
    { id: 'g1', title: '치과 예약', start: d(3, 11), end: d(3, 12), allDay: false, readOnly: true, calendar: '구글 캘린더', color: '#ffd28a' },
  ];
  const ymd = (ms) => { const x = new Date(ms); return `${x.getFullYear()}-${String(x.getMonth()+1).padStart(2,'0')}-${String(x.getDate()).padStart(2,'0')}`; };
  const holidays = [{ date: ymd(d(4)), name: '개천절', holiday: true }, { date: ymd(d(13)), name: '한글날', holiday: true }];
  const listeners = {};
  window.__mock = { settings, listeners };
  window.api = {
    getState: async () => ({ settings, events, external, holidays, feedStatus: { holidays: { ok: true, at: Date.now() } }, pinAvailable: true }),
    addEvent: async (e) => { events.push({ ...e, id: String(Math.random()) }); listeners.events?.(events); },
    updateEvent: async (id, e) => { events = events.map((x) => x.id === id ? { ...x, ...e } : x); listeners.events?.(events); },
    deleteEvent: async (id) => { events = events.filter((x) => x.id !== id); listeners.events?.(events); },
    getFonts: async () => ['Malgun Gothic', 'Noto Sans CJK KR', 'Nanum Gothic'],
    updateSettings: async (p) => { Object.assign(settings, p); listeners.settings?.(settings); return settings; },
    resetSettings: async () => settings, openSettings: async () => {}, refreshFeeds: async () => {}, windowAction: async () => {},
    resizeStart() {}, resizeMove() {}, resizeEnd() {},
    syncStatus: async () => ({ phase: 'online', email: 'teacher@example.com' }),
    // 빠른 입력: "상담"이 들어가면 내일 15시 일정 하나를 넣는 가짜 AI
    aiCommand: async ({ text }) => {
      await new Promise((r) => setTimeout(r, 300));
      const date = ymd(d(1));
      const item = { title: '학부모 상담', kind: '일정', date, time: '15:00' };
      const dup = events.some((e) => e.title === item.title && ymd(e.start) === date);
      if (dup) return { kind: 'prompt', summary: '', added: [], skipped: [{ item, reason: '이미 있음' }], undated: [] };
      const id = String(Math.random());
      events.push({ id, title: item.title, start: d(1, 15), end: d(1, 16), allDay: false, color: '#ffd28a', remind: [30], source: 'ai' });
      listeners.events?.(events);
      return { kind: 'prompt', summary: text, added: [{ id, item }], skipped: [], undated: [{ title: '체육대회 준비' }] };
    },
    undoItems: async (ids) => { events = events.filter((x) => !ids.includes(x.id)); listeners.events?.(events); },
    on: (ch, cb) => { listeners[ch] = cb; },
  };
})();
