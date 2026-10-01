#!/usr/bin/env node
// MyScheduler MCP 서버 — Claude Code에서 바탕화면 캘린더를 조회·수정하고 파일을 분석한다.
// 등록(한 번만): 캘린더 설정 → "Claude Code 연결"에 나오는 명령을 터미널에 붙여 넣기
//   claude mcp add myscheduler --scope user -- node "<이 파일 경로>"
// 외부 패키지 없이 동작 (MCP stdio: 줄 단위 JSON-RPC)
const { call } = require('./client');

const VERSION = '1.0.0';

const INSTRUCTIONS = `MyScheduler는 사용자의 Windows 바탕화면 캘린더입니다. 날짜는 YYYY-MM-DD, 시각은 HH:mm(24시간, 이 PC 현지 시간)으로 주고받습니다.

사용자가 파일(사진·문서·녹음)을 주며 일정에 넣어 달라고 하면:
1. 내용 확보: 사진·PDF는 직접 읽는다. HWP·HWPX·DOCX는 document_extract_text, 음성 파일은 audio_transcribe를 쓴다.
   (직접 분석하기 번거로우면 files_analyze_with_app_ai로 캘린더 앱의 AI에게 맡길 수 있다.)
2. 오늘 날짜를 기준으로 "다음 주 화요일" 같은 표현을 절대 날짜로 바꾸고 요일을 검산한다. 날짜가 불분명하면 추측하지 말고 묻는다.
3. calendar_list_events로 해당 기간을 조회해 이미 있는 일정과 겹치지 않게 한다.
4. 추가할 목록(날짜·시간·제목·장소·알림·근거)을 표로 보여주고 확인을 받은 뒤 calendar_add_events로 한 번에 넣는다.
   사용자가 "확인 없이 바로 넣어"라고 했다면 확인을 생략한다.
5. 제목은 20자 이내로 구체적으로, 준비물·대상·제출처 같은 세부는 memo에. 원문 근거는 evidence에.
6. 넣은 뒤 무엇을 추가했는지 짧게 보고한다. 캘린더 앱이 Windows 알림으로도 알려준다.

알림(remind, 분 단위 배열): 시간이 있는 일정은 시작 전 분(예: [30]).
종일 일정은 그날 00:00 기준이라 -480 = 당일 오전 8시, 900 = 전날 오전 9시. 생략하면 적절한 기본값이 들어간다.`;

const itemSchema = {
  type: 'object',
  properties: {
    title: { type: 'string', description: '일정 제목 (20자 이내 권장)' },
    date: { type: 'string', description: '시작 날짜 YYYY-MM-DD' },
    endDate: { type: 'string', description: '여러 날 일정의 마지막 날 YYYY-MM-DD (선택)' },
    time: { type: 'string', description: '시작 시각 HH:mm. 비우면 종일 일정' },
    endTime: { type: 'string', description: '끝 시각 HH:mm (선택)' },
    location: { type: 'string' },
    memo: { type: 'string' },
    evidence: { type: 'string', description: '근거가 된 원문 (선택, 메모에 함께 저장)' },
    kind: { type: 'string', enum: ['일정', '할 일', '마감'], description: '알림 기본값 결정에 사용' },
    remind: { type: 'array', items: { type: 'integer' }, description: '알림 (시작 몇 분 전). 종일: -480=당일 8시, 900=전날 9시' },
    color: { type: 'string', description: '글자색 #rrggbb (선택)' },
  },
  required: ['title', 'date'],
};

const TOOLS = [
  {
    name: 'calendar_list_events',
    description: '캘린더 일정을 조회합니다(직접 입력한 일정 + 구글·외부 캘린더·공휴일 포함). 기본: 오늘부터 30일.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'YYYY-MM-DD' },
        to: { type: 'string', description: 'YYYY-MM-DD' },
        query: { type: 'string', description: '제목·메모·장소 검색어' },
      },
    },
    run: (a) => call('GET', `/events?${new URLSearchParams(Object.entries(a).filter(([, v]) => v))}`),
  },
  {
    name: 'calendar_add_events',
    description: '일정을 한 번에 여러 개 추가합니다. 추가되면 바탕화면 캘린더에 즉시 보이고 Windows 알림이 뜹니다.',
    inputSchema: {
      type: 'object',
      properties: {
        events: { type: 'array', items: itemSchema },
        sourceNote: { type: 'string', description: '출처 파일 이름 등 (메모에 "출처:"로 붙음)' },
      },
      required: ['events'],
    },
    run: (a) => call('POST', '/events', a),
  },
  {
    name: 'calendar_update_event',
    description: '일정 하나를 수정합니다. 바꿀 항목만 주면 됩니다(id는 calendar_list_events 결과에서). 외부 캘린더 일정은 수정할 수 없습니다.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, ...itemSchema.properties }, required: ['id'] },
    run: ({ id, ...rest }) => call('PATCH', `/events/${encodeURIComponent(id)}`, rest),
  },
  {
    name: 'calendar_delete_event',
    description: '일정 하나를 삭제합니다. 삭제 전 사용자에게 확인하세요.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    run: ({ id }) => call('DELETE', `/events/${encodeURIComponent(id)}`),
  },
  {
    name: 'document_extract_text',
    description: 'HWP·HWPX·DOCX·TXT 문서에서 글자를 추출합니다(표 안 글자 포함). PDF와 사진은 직접 읽으세요.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: '파일의 전체 경로' } }, required: ['path'] },
    run: (a) => call('POST', '/extract', a),
  },
  {
    name: 'audio_transcribe',
    description: '녹음 파일(mp3, m4a, wav 등)을 한국어로 받아씁니다. 캘린더 앱에 Gemini API 키가 설정되어 있어야 합니다. 긴 녹음은 몇 분 걸릴 수 있습니다.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    run: (a) => call('POST', '/transcribe', a),
  },
  {
    name: 'files_analyze_with_app_ai',
    description: '캘린더 앱의 AI 비서(설정된 Gemini/Claude API 키)로 파일들을 분석해 일정 후보를 받습니다. add=true면 확실한 항목(지난 날짜·중복·확신 낮음 제외)을 바로 추가합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' } },
        instruction: { type: 'string', description: '추가 요청 (예: 3학년 관련만)' },
        add: { type: 'boolean' },
      },
      required: ['paths'],
    },
    run: (a) => call('POST', '/analyze', a),
  },
  {
    name: 'calendar_notify',
    description: '사용자 PC에 Windows 알림을 띄웁니다. date를 주면 알림을 눌렀을 때 그 날짜로 이동합니다.',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string' }, message: { type: 'string' }, date: { type: 'string' } },
      required: ['title'],
    },
    run: (a) => call('POST', '/notify', a),
  },
];

// ---------------- JSON-RPC (stdio) ----------------
const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const reply = (id, result) => write({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // 알림(notifications/*)은 응답하지 않음
  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'myscheduler', version: VERSION },
        instructions: INSTRUCTIONS,
      });
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, { tools: TOOLS.map(({ run, ...t }) => t) });
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return fail(id, -32602, `알 수 없는 도구: ${params?.name}`);
      try {
        const result = await tool.run(params.arguments || {});
        const text = typeof result.text === 'string' && Object.keys(result).length <= 2 ? result.text : JSON.stringify(result, null, 2);
        return reply(id, { content: [{ type: 'text', text }] });
      } catch (e) {
        return reply(id, { content: [{ type: 'text', text: `오류: ${e.message}` }], isError: true });
      }
    }
    default:
      return fail(id, -32601, `지원하지 않는 요청: ${method}`);
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { fail(null, -32700, 'JSON 해석 실패'); continue; }
    handle(msg).catch((e) => { if (msg.id !== undefined) fail(msg.id, -32603, e.message); });
  }
});
process.stdin.on('end', () => process.exit(0));
