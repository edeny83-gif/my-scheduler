// feeds.js / store.js 동작 확인 (electron 없이 node로 실행)
const assert = require('node:assert');
const os = require('node:os'); const fs = require('node:fs'); const path = require('node:path');
const { expandICS, parseHolidays, Feeds } = require('../feeds');
const { LocalStore } = require('../store');

const y = new Date().getFullYear();
const ics = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VTIMEZONE
TZID:Asia/Seoul
BEGIN:STANDARD
DTSTART:19700101T000000
TZOFFSETFROM:+0900
TZOFFSETTO:+0900
TZNAME:KST
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
UID:multi@test
DTSTART;VALUE=DATE:${y}1012
DTEND;VALUE=DATE:${y}1015
SUMMARY:수학여행
END:VEVENT
BEGIN:VEVENT
UID:weekly@test
DTSTART;TZID=Asia/Seoul:${y}1005T150000
DTEND;TZID=Asia/Seoul:${y}1005T160000
RRULE:FREQ=WEEKLY;COUNT=4
EXDATE;TZID=Asia/Seoul:${y}1012T150000
SUMMARY:학년 협의회
LOCATION:3층 회의실
END:VEVENT
BEGIN:VEVENT
UID:weekly@test
RECURRENCE-ID;TZID=Asia/Seoul:${y}1019T150000
DTSTART;TZID=Asia/Seoul:${y}1019T170000
DTEND;TZID=Asia/Seoul:${y}1019T180000
SUMMARY:학년 협의회(시간 변경)
END:VEVENT
BEGIN:VEVENT
UID:cancel@test
DTSTART;VALUE=DATE:${y}1020
SUMMARY:취소됨
STATUS:CANCELLED
END:VEVENT
END:VCALENDAR`;

process.env.TZ = 'Asia/Seoul';
const out = expandICS(ics);
const fmt = (ms) => new Date(ms).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
for (const o of out) console.log(o.title, '|', fmt(o.start), '→', o.end && fmt(o.end), o.allDay ? '(종일)' : '');
const trip = out.find((o) => o.title === '수학여행');
assert.ok(trip.allDay);
assert.strictEqual(new Date(trip.end).getDate(), 14, '종일 일정 종료일은 포함 마지막 날(14일)');
const weekly = out.filter((o) => o.title.startsWith('학년 협의회'));
assert.strictEqual(weekly.length, 3, 'COUNT=4 중 EXDATE 1개 제외');
assert.ok(weekly.some((o) => o.title.includes('변경') && new Date(o.start).getHours() === 17), '예외(시간 변경) 반영');
assert.ok(!out.some((o) => o.title === '취소됨'), '취소 일정 제외');

const hol = parseHolidays(`BEGIN:VCALENDAR
BEGIN:VEVENT
UID:h1
DTSTART;VALUE=DATE:${y}1003
DTEND;VALUE=DATE:${y}1004
SUMMARY:개천절
DESCRIPTION:공휴일
END:VEVENT
BEGIN:VEVENT
UID:h2
DTSTART;VALUE=DATE:${y}0508
DTEND;VALUE=DATE:${y}0509
SUMMARY:어버이날
DESCRIPTION:기념일\\n기념일을 숨기려면 설정으로 이동하세요.
END:VEVENT
END:VCALENDAR`);
console.log(hol);
assert.deepStrictEqual(hol.map((h) => [h.name, h.holiday]), [['개천절', true], ['어버이날', false]]);

// 설정 → 소스 목록
const srcs = Feeds.sourcesFrom({ holidays: { enabled: true }, google: { enabled: true, email: 'a@gmail.com', privateUrl: '' }, calendars: [{ id: 'x', name: '학교', url: 'webcal://ex.com/a.ics' }, { id: 'y', url: '' }] });
console.log(srcs.map((x) => x.id + ' ' + x.url));
assert.strictEqual(srcs.length, 3);
assert.ok(srcs[2].url.startsWith('https://'));

// 저장소
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-'));
const st = new LocalStore(dir);
const id = st.add({ title: ' 회의 ', start: 1000, end: 2000, remind: [30, '10', 30, -5000, -480] }); // 범위 밖(-5000)은 버리고 종일용 음수(-480)는 유지
assert.deepStrictEqual(st.list()[0].remind, [-480, 10, 30]);
st.update(id, { title: '회의2', start: 1000, end: 5000, allDay: false, remind: [] });
assert.strictEqual(new LocalStore(dir).list()[0].title, '회의2', '파일에 저장됨');
assert.throws(() => st.add({ title: 'x', start: 5, end: 1 }), /종료/);
st.remove(id);
assert.strictEqual(st.list().length, 0);
console.log('\n모든 테스트 통과');
