// AI 비서·문서 추출·일정 변환·MCP 서버 시험 (실제 AI API 대신 가짜 응답 사용)
process.env.TZ = 'Asia/Seoul';
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { extractText } = require('../extract');
const { itemToEvent, eventToItem, findDuplicate } = require('../convert');
const ai = require('../ai');
const { startApiServer } = require('../api-server');

const fx = (f) => path.join(__dirname, 'fixtures', f);
const ok = (m) => console.log('  ✓', m);

(async () => {
  console.log('문서 글자 추출');
  const hwp = extractText(fx('sample.hwp')).text;
  assert.ok(hwp.includes('복수전공') && hwp.includes('신청서'), 'HWP 본문');
  assert.ok(hwp.includes('학과/전공'), 'HWP 표 안 글자');
  ok(`HWP ${hwp.length}자 (표 포함)`);
  const hwpx = extractText(fx('sample.hwpx')).text;
  assert.ok(hwpx.includes('수신') && hwpx.includes('기안자'), 'HWPX');
  ok(`HWPX ${hwpx.length}자`);
  const docx = extractText(fx('sample.docx')).text;
  assert.ok(docx.includes('10월 13일 ~ 10월 17일') && docx.includes('& 담임'), 'DOCX 문단·특수문자');
  ok('DOCX 문단 합치기·특수문자');
  assert.strictEqual(extractText(fx('sample.hwp').replace('.hwp', '.pdf')), null);
  ok('PDF는 추출 대상 아님(AI로 직접 전송)');

  console.log('AI 항목 → 일정 변환');
  const e1 = itemToEvent({ title: '협의회', date: '2026-10-05', time: '15:00', kind: '일정' });
  assert.strictEqual(new Date(e1.start).getHours(), 15);
  assert.strictEqual(e1.end - e1.start, 3600000);
  assert.deepStrictEqual(e1.remind, [30]);
  const e2 = itemToEvent({ title: '상담 주간', date: '2026-10-13', endDate: '2026-10-17', kind: '일정' }, { fileName: '안내.docx' });
  assert.ok(e2.allDay && new Date(e2.end).getDate() === 17 && e2.memo.includes('출처: 안내.docx'));
  assert.deepStrictEqual(e2.remind, [-480]);
  const e3 = itemToEvent({ title: '신청서 제출 마감', date: '2026-10-08', kind: '마감', evidence: '10월 8일까지' });
  assert.deepStrictEqual(e3.remind, [900]);
  assert.ok(e3.memo.includes('근거: "10월 8일까지"'));
  assert.throws(() => itemToEvent({ title: 'x', date: '10월 8일' }), /날짜 형식/);
  assert.throws(() => itemToEvent({ title: 'x', date: '2026-02-30' }), /날짜 형식/);
  const back = eventToItem({ id: 'a', ...e2 });
  assert.strictEqual(back.endDate, '2026-10-17');
  assert.ok(findDuplicate(itemToEvent({ title: '학년 협의회', date: '2026-10-05', time: '16:00' }), [{ ...e1, title: '협의회' }]));
  assert.ok(!findDuplicate(itemToEvent({ title: '협의회', date: '2026-10-06' }), [e1]));
  ok('시간·종일·여러 날·마감 알림 기본값·잘못된 날짜 거부·중복 판별');

  console.log('Gemini 요청 형태 (가짜 응답)');
  let captured;
  const fakeFetch = async (url, init) => {
    captured = { url, init, body: JSON.parse(init.body) };
    const out = { summary: '상담 주간 안내', items: [{ title: '상담 신청서 제출 마감', kind: '마감', date: '2026-10-08', confidence: 0.95 }], undated: [] };
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] } }] }) };
  };
  const r = await ai.analyzeFile(fx('sample.docx'), { fetch: fakeFetch, keys: { gemini: 'k' }, provider: 'gemini', geminiModel: 'gemini-x', about: '초등 교사' });
  assert.ok(captured.url.includes('/models/gemini-x:generateContent'));
  assert.strictEqual(captured.init.headers['x-goog-api-key'], 'k');
  assert.ok(captured.body.contents[0].parts[0].text.includes('10월 13일'), '문서 글자를 보냄');
  assert.ok(captured.body.contents[0].parts[1].text.includes('초등 교사'), '사용자 소개 포함');
  assert.strictEqual(captured.body.generationConfig.responseMimeType, 'application/json');
  assert.strictEqual(r.items[0].title, '상담 신청서 제출 마감');
  ok('문서 → 글자 추출 → JSON 스키마 요청 → 결과 해석');

  console.log('Claude 요청 형태 + 녹음은 Gemini로 전환');
  const png = path.join(os.tmpdir(), 't.png'); fs.writeFileSync(png, Buffer.from('89504e470d0a1a0a', 'hex'));
  const claudeFetch = async (url, init) => {
    captured = { url, init, body: JSON.parse(init.body) };
    return { ok: true, json: async () => ({ content: [{ type: 'text', text: '```json\n{"summary":"s","items":[],"undated":[{"title":"교실 정리"}]}\n```' }] }) };
  };
  const r2 = await ai.analyzeFile(png, { fetch: claudeFetch, keys: { claude: 'c' }, provider: 'claude', claudeModel: 'claude-x' });
  assert.strictEqual(captured.url, 'https://api.anthropic.com/v1/messages');
  assert.strictEqual(captured.init.headers['x-api-key'], 'c');
  assert.strictEqual(captured.body.messages[0].content[0].type, 'image');
  assert.strictEqual(r2.undated[0].title, '교실 정리');
  ok('사진 → Claude image 블록, 코드블록 감싼 JSON도 해석');
  const m4a = path.join(os.tmpdir(), 't.m4a'); fs.writeFileSync(m4a, 'x');
  await assert.rejects(ai.analyzeFile(m4a, { fetch: claudeFetch, keys: { claude: 'c' }, provider: 'claude' }), /Gemini API 키가 필요/);
  const r3 = await ai.analyzeFile(m4a, { fetch: fakeFetch, keys: { claude: 'c', gemini: 'g' }, provider: 'claude', geminiModel: 'gm' });
  assert.strictEqual(r3.provider, 'gemini');
  assert.strictEqual(captured.body.contents[0].parts[0].inline_data.mime_type, 'audio/mp4');
  ok('녹음: Gemini 키 없으면 안내, 있으면 Gemini로 자동 전환');

  console.log('큰 녹음 파일 → Gemini 파일 업로드 API');
  const big = path.join(os.tmpdir(), 'big.mp3'); fs.writeFileSync(big, Buffer.alloc(16 * 1024 * 1024));
  const calls = [];
  const uploadFetch = async (url, init = {}) => {
    calls.push(url);
    if (url.includes('/upload/v1beta/files')) return { ok: true, headers: { get: () => 'https://upload.example/abc' } };
    if (url === 'https://upload.example/abc') return { ok: true, json: async () => ({ file: { name: 'files/1', state: 'PROCESSING' } }) };
    if (url.endsWith('/v1beta/files/1')) return { ok: true, json: async () => ({ name: 'files/1', state: 'ACTIVE', uri: 'https://f/1', mimeType: 'audio/mp3' }) };
    captured = { body: JSON.parse(init.body) };
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"summary":"","items":[]}' }] } }] }) };
  };
  await ai.analyzeFile(big, { fetch: uploadFetch, keys: { gemini: 'g' }, provider: 'gemini', geminiModel: 'gm' });
  assert.strictEqual(captured.body.contents[0].parts[0].file_data.file_uri, 'https://f/1');
  ok(`업로드 시작 → 전송 → 처리 대기 → file_uri 사용 (${calls.length}번 호출)`);

  console.log('빠른 입력 (글·말)');
  await ai.analyzeCommand({ text: '다음 주 화요일 3시 학부모 상담' }, { fetch: fakeFetch, keys: { gemini: 'g' }, provider: 'gemini', geminiModel: 'gm', about: '3학년 담임' });
  assert.strictEqual(captured.body.contents[0].parts.length, 1);
  assert.ok(captured.body.contents[0].parts[0].text.includes('학부모 상담') && captured.body.contents[0].parts[0].text.includes('3학년 담임'));
  const rc = await ai.analyzeCommand({ text: '상담' }, { fetch: claudeFetch, keys: { claude: 'c' }, provider: 'claude', claudeModel: 'cm' });
  assert.ok(captured.url.includes('anthropic') && rc.kind === 'prompt');
  const rv = await ai.analyzeCommand({ audio: { data: 'AAAA', mime: 'audio/webm;codecs=opus' } }, { fetch: fakeFetch, keys: { gemini: 'g', claude: 'c' }, provider: 'claude', geminiModel: 'gm' });
  assert.strictEqual(captured.body.contents[0].parts[0].inline_data.mime_type, 'audio/webm');
  assert.ok(captured.body.contents[0].parts[1].text.includes('직접 말한') && rv.kind === 'voice' && rv.provider === 'gemini');
  await assert.rejects(ai.analyzeCommand({ audio: { data: 'A' } }, { fetch: fakeFetch, keys: { claude: 'c' } }), /Gemini API 키/);
  await assert.rejects(ai.analyzeCommand({ text: '  ' }, { fetch: fakeFetch, keys: { gemini: 'g' } }), /내용을 입력/);
  ok('글→Gemini/Claude, 말→Gemini(webm, 키 없으면 안내), 빈 입력 거부');
  ai.RETRY.ms = [0, 0];
  let n = 0;
  const busy = (times) => async (url, init) => {
    if (url.includes('generativelanguage') && n++ < times) return { ok: false, status: 503, text: async () => '{"error":{"message":"This model is currently experiencing high demand."}}' };
    return url.includes('anthropic') ? claudeFetch(url, init) : fakeFetch(url, init);
  };
  n = 0; const rb = await ai.analyzeCommand({ text: '상담' }, { fetch: busy(2), keys: { gemini: 'g' }, provider: 'gemini', geminiModel: 'gm' });
  assert.ok(rb.items.length === 1 && n === 3);
  n = 0; await assert.rejects(ai.analyzeCommand({ text: '상담' }, { fetch: busy(9), keys: { gemini: 'g' }, provider: 'gemini', geminiModel: 'gm' }), /붐빕니다/);
  n = 0; const rf = await ai.analyzeCommand({ text: '상담' }, { fetch: busy(9), keys: { gemini: 'g', claude: 'c' }, provider: 'gemini', geminiModel: 'gm', claudeModel: 'cm' });
  assert.strictEqual(rf.provider, 'claude');
  ok('AI 서버가 붐비면(503) 두 번 다시 시도 → 그래도 안 되면 Claude로 대신, 없으면 쉬운 안내');

  console.log('MCP 서버 ↔ 캘린더 연결 창구');
  const apiFile = path.join(os.tmpdir(), 'api-test.json');
  const store = [];
  const srv = await startApiServer({
    port: 17990, file: apiFile, version: 't',
    routes: {
      'GET /events': () => ({ count: store.length, events: store }),
      'POST /events': ({ body }) => { const added = body.events.map((e, i) => ({ id: String(i), ...e })); store.push(...added); return { ok: true, added }; },
      'POST /extract': ({ body }) => ({ text: extractText(body.path).text.slice(0, 20) }),
    },
  });
  const mcp = spawn(process.execPath, [path.join(__dirname, '..', 'tools', 'mcp-server.js')], { env: { ...process.env, MYSCHEDULER_API_FILE: apiFile } });
  let out = '';
  mcp.stdout.on('data', (d) => { out += d; });
  const rpc = (id, method, params) => mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  const waitFor = async (id) => {
    for (let i = 0; i < 100; i++) {
      const line = out.split('\n').find((l) => l.includes(`"id":${id},`) || l.includes(`"id":${id}}`));
      if (line) return JSON.parse(line);
      await new Promise((r) => setTimeout(r, 30));
    }
    throw new Error('MCP 응답 없음 ' + id);
  };
  rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test' } });
  const init = await waitFor(1);
  assert.strictEqual(init.result.serverInfo.name, 'myscheduler');
  assert.ok(init.result.instructions.includes('calendar_add_events'));
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  rpc(2, 'tools/list', {});
  const tools = (await waitFor(2)).result.tools.map((t) => t.name);
  assert.deepStrictEqual(tools, ['calendar_list_events', 'calendar_add_events', 'calendar_update_event', 'calendar_delete_event', 'document_extract_text', 'audio_transcribe', 'files_analyze_with_app_ai', 'calendar_notify']);
  rpc(3, 'tools/call', { name: 'calendar_add_events', arguments: { events: [{ title: '체육대회', date: '2026-10-09' }] } });
  const add = await waitFor(3);
  assert.ok(add.result.content[0].text.includes('체육대회') && !add.result.isError);
  rpc(4, 'tools/call', { name: 'document_extract_text', arguments: { path: fx('sample.hwp') } });
  assert.ok((await waitFor(4)).result.content[0].text.includes('신청서'));
  srv.close();
  rpc(5, 'tools/call', { name: 'calendar_list_events', arguments: {} });
  const down = await waitFor(5);
  assert.ok(down.result.isError && down.result.content[0].text.includes('실행 중이 아닙니다'));
  mcp.kill();
  ok('초기화·도구 8개·일정 추가·HWP 추출·앱이 꺼졌을 때 안내');

  console.log('\n모든 비서 테스트 통과');
})().catch((e) => { console.error('\n실패:', e); process.exit(1); });
