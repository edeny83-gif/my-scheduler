// 브리핑: Claude가 만들어 주는 "오늘 처리할 일" 글을 마이스케쥴에 보관한다.
// 일정 데이터 모델을 바꾸지 않는다 — 브리핑은 그 날짜의 종일 일정 "📋 브리핑 M/D"이고 글은 메모(memo)에 들어간다.
// (그래서 폰·다른 기기로도 기존 동기화 그대로 가고, 옛 버전에서도 그냥 일정으로 보인다.)
const PREFIX = '📋 브리핑';
const COLOR = '#d4b8ff';
const MAX_TEXT = 30000;

const isBriefing = (e) => !!e && !e.readOnly && !!e.allDay && typeof e.title === 'string' && e.title.startsWith(PREFIX);   // 종일 일정만(시간이 있는 일정은 브리핑이 아니다)

function briefingTitle(date) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(date || '').trim());
  return m ? `${PREFIX} ${Number(m[2])}/${Number(m[3])}` : PREFIX;
}

/** { date: 'YYYY-MM-DD', text, title? } → 일정 항목(itemToEvent에 넘길 형식) */
function briefingItem({ date, text, title }) {
  const body = String(text ?? '').trim();
  if (!body) throw new Error('브리핑 글(text)이 비어 있습니다');
  return {
    title: String(title || '').trim() || briefingTitle(date),
    date,
    allDay: true,
    memo: body.length > MAX_TEXT ? `${body.slice(0, MAX_TEXT)}\n…(너무 길어 잘렸습니다)` : body,
    remind: [],
    color: COLOR,
  };
}

/**
 * 같은 날짜의 브리핑이 있으면 글을 바꾸고, 없으면 새로 만든다(여러 번 돌려도 하나만 남는다).
 * store: list()/add()/update(), itemToEvent·sod: 일정 변환 도우미.
 */
function upsertBriefing(store, args, { itemToEvent, sod }) {
  const ev = itemToEvent(briefingItem(args), { source: 'claude-code' });
  const same = store.list().find((e) => isBriefing(e) && sod(e.start) === sod(ev.start));
  if (same) { store.update(same.id, ev); return { id: same.id, created: false, title: ev.title }; }
  return { id: store.add(ev), created: true, title: ev.title };
}

module.exports = { PREFIX, COLOR, MAX_TEXT, isBriefing, briefingTitle, briefingItem, upsertBriefing };
