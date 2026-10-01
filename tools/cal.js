#!/usr/bin/env node
// MyScheduler 명령줄 도구 (MCP를 쓰지 않을 때 Claude Code가 터미널에서 사용)
//   node cal.js list [--from 2026-10-01] [--to 2026-10-31] [--query 회의]
//   node cal.js add '{"events":[{"title":"협의회","date":"2026-10-05","time":"15:00"}]}'
//   node cal.js update <id> '{"time":"16:00"}'
//   node cal.js delete <id>
//   node cal.js extract <파일경로>        (HWP·HWPX·DOCX 글자 추출)
//   node cal.js transcribe <녹음파일>     (Gemini 키 필요)
//   node cal.js analyze <파일...> [--add] [--instruction "..."]
//   node cal.js notify "제목" "내용"
const { call } = require('./client');

const [cmd, ...args] = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const plain = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && args[i - 1] !== '--add'));

(async () => {
  let r;
  switch (cmd) {
    case 'list': r = await call('GET', `/events?${new URLSearchParams(Object.entries({ from: flag('from'), to: flag('to'), query: flag('query') }).filter(([, v]) => v))}`); break;
    case 'add': r = await call('POST', '/events', JSON.parse(plain[0])); break;
    case 'update': r = await call('PATCH', `/events/${encodeURIComponent(plain[0])}`, JSON.parse(plain[1] || '{}')); break;
    case 'delete': r = await call('DELETE', `/events/${encodeURIComponent(plain[0])}`); break;
    case 'extract': r = await call('POST', '/extract', { path: plain[0] }); break;
    case 'transcribe': r = await call('POST', '/transcribe', { path: plain[0] }); break;
    case 'analyze': r = await call('POST', '/analyze', { paths: plain, add: args.includes('--add'), instruction: flag('instruction') }); break;
    case 'notify': r = await call('POST', '/notify', { title: plain[0], message: plain[1] || '' }); break;
    default:
      console.error('명령: list | add | update | delete | extract | transcribe | analyze | notify');
      process.exit(1);
  }
  console.log(typeof r.text === 'string' ? r.text : JSON.stringify(r, null, 2));
})().catch((e) => { console.error(`오류: ${e.message}`); process.exit(1); });
