// AI가 보낸 답글에서 일정 결과(JSON)를 너그럽게 찾아낸다.
// 코드블록(```json)·앞뒤에 붙은 설명·배열만 온 경우·일정 하나만 온 경우·끝이 잘린 경우·끝에 쉼표가 남은 경우를 모두 받아 준다.
// 정말 못 찾으면 AI가 무슨 말을 했는지(앞부분)를 오류 문구에 담아 원인을 알 수 있게 한다.
// (폰 src/core/jsonReply.js · PC jsonReply.js 공통: 두 파일 내용이 똑같아야 한다)

const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const looksLikeItem = (o) => isObj(o) && typeof o.title === 'string' && (o.date != null || o.time != null || o.start != null);
const KNOWN = ['summary', 'items', 'undated', 'deletes', 'events', 'schedule', 'schedules', '일정'];

/** 오류 문구에 보여 줄 앞부분 (한 줄로) */
function snippet(s, n = 70) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** code: 'EMPTY'(빈 답) | 'NO_JSON'(결과 형식이 아님) — 호출하는 쪽이 같은 AI에게 다시 묻거나 다른 AI로 넘길 때 쓴다 */
function replyError(code, raw = '') {
  const sn = snippet(raw);
  const e = new Error(code === 'EMPTY'
    ? 'AI가 아무 답도 보내지 않았습니다. 다시 한 번 눌러 보세요'
    : `AI의 답을 일정으로 읽지 못했습니다. 다시 한 번 눌러 보세요${sn ? ` (AI가 보낸 말: “${sn}”)` : ''}`);
  e.code = code;
  e.snippet = sn;
  return e;
}

/** i에서 시작하는 { 또는 [ 의 짝이 되는 닫는 괄호 위치(문자열 안의 괄호는 무시). 없으면 -1 */
function matchEnd(t, i) {
  const stack = [];
  let inStr = false, esc = false;
  for (let k = i; k < t.length; k++) {
    const ch = t[k];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') {
      const open = stack.pop();
      if ((open === '{') !== (ch === '}')) return -1;
      if (!stack.length) return k;
    }
  }
  return -1;
}

/** 끝이 잘린 JSON(글자 수 제한 등)을 닫아 준다 */
function closeOpen(s) {
  const stack = [];
  let inStr = false, esc = false;
  for (const ch of s) {
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }
  let out = s;
  if (inStr) out += '"';
  out = out.replace(/[,:\s]+$/, '');              // 끝의 쉼표·콜론
  out = out.replace(/,\s*"[^"]*"\s*$/, '');       // 값 없이 키만 남은 끝부분
  return out + stack.reverse().map((c) => (c === '{' ? '}' : ']')).join('');
}

/** 글자 안에 줄바꿈·탭이 그대로 들어간 경우(JSON에서는 \n \t로 써야 함) 바로잡는다 */
function escapeControls(s) {
  let out = '', inStr = false, esc = false;
  for (const ch of s) {
    if (inStr) {
      if (esc) { esc = false; out += ch; continue; }
      if (ch === '\\') { esc = true; out += ch; continue; }
      if (ch === '"') { inStr = false; out += ch; continue; }
      out += ch === '\n' ? '\\n' : ch === '\r' ? '\\r' : ch === '\t' ? '\\t' : ch;
    } else { if (ch === '"') inStr = true; out += ch; }
  }
  return out;
}

function tryParse(c) {
  const noComma = c.replace(/,\s*([}\]])/g, '$1'); // 끝에 남은 쉼표 제거
  for (const s of [c, noComma, escapeControls(noComma)]) {
    try { return { ok: true, value: JSON.parse(s) }; } catch { /* 다음 방법 */ }
  }
  return { ok: false };
}

function make({ summary, items, undated, deletes } = {}, { repaired = false } = {}) {
  let list = Array.isArray(items) ? items.filter(isObj) : [];
  if (repaired) list = list.filter((it) => typeof it.date === 'string' && it.date); // 잘린 끝부분의 덜 쓴 항목은 버린다
  return {
    summary: String(summary ?? ''),
    items: list,
    undated: Array.isArray(undated) ? undated.filter(isObj) : [],
    deletes: Array.isArray(deletes) ? deletes.map(String) : [],
  };
}

/** 파싱된 값 → 결과 모양. 결과로 볼 수 없으면 null. single=true면 일정 "하나"만 온 것 */
function shape(v, opts) {
  if (Array.isArray(v)) {
    if (!v.length) return { r: make({}, opts), single: false };
    return v.every(looksLikeItem) ? { r: make({ items: v }, opts), single: false } : null;
  }
  if (!isObj(v)) return null;
  const arr = [v.items, v.events, v.schedule, v.schedules, v['일정']].find(Array.isArray);
  if (arr || KNOWN.some((k) => k in v)) return { r: make({ summary: v.summary ?? v.message, items: arr, undated: v.undated, deletes: v.deletes }, opts), single: false };
  if (looksLikeItem(v)) return { r: make({ items: [v] }, opts), single: true };
  return null;
}

/**
 * AI 답글 → { summary, items[], undated[], deletes[] }
 * 못 찾으면 code가 'EMPTY' 또는 'NO_JSON'인 오류(앞부분을 담은 쉬운 문구)를 던진다.
 */
function parseReply(text) {
  const raw = String(text ?? '');
  const t = raw.replace(/```[A-Za-z]*/g, ' ').trim();
  if (!t) throw replyError('EMPTY');
  const whole = tryParse(t);
  const found = [];            // 결과로 볼 수 있는 덩어리들 (앞→뒤 순서)
  const singles = [];          // 일정 하나씩만 온 것들(바깥 덩어리가 깨진 경우의 안쪽 항목)
  if (whole.ok) { const s = shape(whole.value, {}); if (s) found.push(s.r); }
  if (!found.length) {
    for (let i = 0, n = 0; i < t.length && n < 60; i++) {
      if (t[i] !== '{' && t[i] !== '[') continue;
      n++;
      const e = matchEnd(t, i);
      let parsed, repaired = false;
      if (e >= 0) parsed = tryParse(t.slice(i, e + 1));
      else { parsed = tryParse(closeOpen(t.slice(i))); repaired = parsed.ok; } // 끝이 잘림
      if (!parsed.ok) continue;                       // 깨진 덩어리: 안쪽 덩어리를 계속 찾는다
      const s = shape(parsed.value, { repaired });
      if (!s) continue;
      if (s.single) singles.push(...s.r.items); else found.push(s.r);
      i = e >= 0 ? e : t.length;                      // 성공한 덩어리 안쪽은 건너뜀
    }
  }
  if (!found.length && singles.length) found.push(make({ items: singles }));
  if (!found.length) throw replyError('NO_JSON', raw);
  // 여러 덩어리면 내용이 있는 마지막 것(앞쪽은 예시를 따라 쓴 것일 수 있다)
  const useful = found.filter((r) => r.items.length || r.deletes.length || r.undated.length);
  return (useful.length ? useful : found).slice(-1)[0];
}

module.exports = { parseReply, replyError, snippet };
