# MyScheduler 데스크탑 — Claude Code 작업 지침

Windows 바탕화면 캘린더 위젯(Electron). 일정의 원본은 이 PC의 JSON 파일이고, 로그인하면 Firebase(Firestore)로 폰 앱과 실시간 동기화한다. 사용자는 교사이며 요청·답변·커밋 메시지는 한국어.

## 파일 구조
| 파일 | 역할 |
|---|---|
| `main.js` | 창(투명·프레임 없음), 트레이 메뉴, 알림, IPC, 설정 저장 |
| `store.js` | 일정 저장소 `LocalStore` — 파일 저장만 담당하고 로직은 `sync-core.js`의 `LocalDocStore` |
| `sync-core.js` | **PC·폰 공통(두 프로젝트에서 내용이 같아야 함)**: 저장소 로직, 최신 우선 합치기, SyncEngine, Firestore 구독/올리기, 오류 문구 |
| `sync-main.js` | 숨은 창(Firebase)과 저장소를 SyncEngine으로 연결. 로그인·로그아웃 요청 중계 |
| `src/sync-window.js` | 숨은 창에서 실행되는 Firebase 코드. `npm run bundle`이 `src/sync-window.bundle.js`로 묶음(esbuild) |
| `src/firebase-config.js` | Firebase 웹 설정(공개 값) |
| `firestore.rules` | 보안 규칙: users/{uid} 아래는 본인만 |
| `feeds.js` | 공휴일·구글·외부 캘린더 iCal 받아오기/해석(ical.js), 디스크 캐시, 30분 주기 갱신 |
| `pin.js` | "다른 창 뒤에 깔기"(koffi로 SetWindowPos HWND_BOTTOM). 기본 꺼짐. 소유자=Progman 방식은 창이 안 보이는 문제가 있어 폐기 |
| `preload.js` | 화면에 노출하는 `window.api` |
| `ai.js` | AI 비서: 파일 → 일정 후보(JSON). Gemini(문서·사진·PDF·음성, 15MB 넘으면 파일 업로드 API) / Claude(문서·사진·PDF). 프롬프트는 `buildPrompt` |
| `extract.js` | HWP 5.x(OLE+레코드 파싱)·HWPX·DOCX·텍스트 글자 추출. AI가 직접 못 읽는 형식 담당 |
| `convert.js` | AI·Claude Code의 날짜 문자열 항목 ↔ 저장 형식 변환, 알림 기본값, 중복 판별 |
| `timeText.js` | 사람이 쓴 시각 글자 해석("오후 2시 반", "2시~3시", "14:00-15:30")과 AI 항목 시각 바로잡기(제목에 섞인 시각을 time·endTime으로). **폰의 `src/core/timeText.js`와 내용이 똑같아야 함** |
| `api-server.js` | Claude Code용 로컬 HTTP 창구(127.0.0.1, 실행마다 새 토큰 → `api.json`) |
| `tools/mcp-server.js` | Claude Code MCP 서버(외부 패키지 없음). 시작 시 데이터 폴더 `claude-code/`로 복사됨 |
| `tools/cal.js` | 같은 기능의 명령줄 도구 |
| `src/assistant.*` | AI 비서 창 (파일 올리기 → 결과 확인·수정 → 추가/되돌리기) |
| `src/index.html·widget.css·widget.js` | 달력 위젯 화면. 맨 아래 빠른 입력 칸(글·🎤 말 → IPC `ai-command` → `ai.analyzeCommand`, 설정 `showQuick`) |
| `src/settings.*` | 설정 창(⚙) |
| `test/` | `npm test`(iCal·저장·추출·AI 요청 형태·MCP 시험), `mock-api.js`·`mock-assistant.js`(브라우저 미리보기용 가짜 api), `fixtures/`(샘플 HWP·HWPX·DOCX) |

## 클라우드 동기화
- 서버 경로 `users/{uid}/events/{id}`. 필드: title,start,end,allDay,location,memo,color,remind,source,createdAt,updatedAt,deleted (모두 숫자 ms·기본 타입).
- **updatedAt이 큰 쪽이 이긴다.** 삭제는 `deleted:true`(묘비)로 남겨 전달. 이 기기에서 바꾼 뒤 못 올린 일정은 `events.json`의 `dirty`에 기록, 서버 첫 응답 후 올린다.
- 인터넷 연결은 **숨은 BrowserWindow(Chromium)** 가 맡는다 → 학교 망의 프록시·인증서 검사에서도 시스템 설정을 따른다. Node(gRPC)로 옮기지 말 것. 로그인 상태는 이 창의 IndexedDB에 보관(비밀번호 저장 안 함).
- 필드를 추가·변경하면 `sync-core.js`(FIELDS·clean·fromRemote)를 고치고 **폰 프로젝트의 `src/core/sync-core.js`에 똑같이 복사**, `test/sync.test.js`도 같이 유지한다.
- 시험: `npm test`의 sync.test.js가 가짜 Firestore로 두 기기·오프라인 충돌을 확인한다.

## 데이터 모델 (`%APPDATA%/my-scheduler-desktop/events.json`)
`{ version:1, owner:"uid", dirty:{id:updatedAt}, events:[...] }` — events에는 삭제 표시(deleted:true)도 포함. 화면·API에는 `store.list()`(삭제 제외)만 쓴다.
```
{ id, title, start(ms), end(ms|null), allDay, location, memo,
  color("#rrggbb" 또는 ""=기본색), remind(시작 몇 분 전, number[]),
  source(""=직접 입력 | "ai"=비서 창 | "claude-code"), createdAt, updatedAt }
```
- **종일 일정의 end = 마지막 날 00:00 (포함)**. 예: 10/12~10/14 → start=10/12 00:00, end=10/14 00:00.
  iCal의 DTEND(다음 날, 미포함)는 feeds.js에서 하루 빼서 맞춘다.
- 여러 날 일정 = 마지막 날 > 첫날. 달력에서 ←── 제목 ──→ 로 이어서 그린다.
- 외부 일정은 `readOnly:true, calendar:이름` 이 붙고 수정 불가.
- **알림 remind**: 시간 일정은 시작 전 분. 종일 일정은 00:00 기준이라 음수 허용: -480 = 당일 오전 8시, 900 = 전날 오전 9시.
  AI 항목 기본값(convert.js `defaultRemind`): 시간 일정 30분 전(마감 60분), 종일 일정 당일 8시(마감 전날 9시).
- API 키는 `keys.bin`(safeStorage 암호화). 설정·로그·소스에 키를 남기지 말 것.
- 설정은 같은 폴더 `settings.json` (기본값은 main.js의 `DEFAULTS`). 새 설정 키를 추가하면 DEFAULTS에 기본값을 꼭 넣는다.

## 화면 규칙 (사용자 요구사항)
- 오늘: 칸 전체를 연한 흰색 바탕(`--today`)으로만 표시. 동그라미·노란색 금지.
- 일정: 배경 블록 없이 **글자색만** 다르게. 여러 날 일정은 양쪽 화살표(↔)로 기간 전체를 잇는다.
- 달력 칸 안 하루 일정은 시간 없이 "· 제목"(가운데 점으로 구분). 시간은 아래 목록과 말풍선(툴팁)에.
- 투명도는 창(`setOpacity`)이 아니라 배경색 알파(`--bg`)로 조절 → 글자는 선명하게 유지.
- 투명 창은 `resizable:false` 유지(true면 Windows에서 투명이 깨질 수 있음). 크기 조절은 `.rz` 손잡이 + IPC `resize-*`.

## 비서 모드 (Claude Code에서 파일로 일정 넣기)
캘린더 앱이 실행 중이면 MCP 도구 `myscheduler`(이 폴더의 `.mcp.json`, 또는 사용자 범위 등록)를 쓸 수 있다.
1. 사진·PDF는 직접 읽는다. HWP·HWPX·DOCX는 `document_extract_text`, 녹음은 `audio_transcribe`(앱에 Gemini 키 필요).
2. 오늘 날짜 기준으로 상대 날짜를 절대 날짜로 바꾸고 요일을 검산한다. 모호한 날짜는 묻는다.
3. `calendar_list_events`로 기간을 조회해 중복을 피한다.
4. 추가할 목록을 표로 보여주고 확인받은 뒤 `calendar_add_events` 한 번에 추가(사용자가 "바로 넣어"라고 하면 생략). 출처 파일명은 `sourceNote`.
5. 회의 녹음이면 결정 사항·할 일 요약도 함께 보고한다.
MCP가 없으면 같은 기능을 `node tools/cal.js …`(사용법은 파일 머리말)로 쓴다.

## 문제 진단
- **화면 처리기 크래시(종료 코드 -1073741515 = DLL 못 찾음)** 가 일부 Windows PC에서 발생했다(0.2.0/0.2.1). main.js의 "안전 모드"가 크래시를 감지하면 `safe-mode.json`의 단계를 올려(1: 샌드박스 끔, 2: +GPU 합성 끔, 3: +GPU 프로세스 통합) 자동 재시작한다. 시험: `MS_TEST_CRASH=2 npm start`.
- 시작·오류는 `%APPDATA%/my-scheduler-desktop/startup.log`에 기록되고, 치명적 오류는 대화상자로 표시된다.
- 위젯이 안 보인다는 보고가 오면 먼저 startup.log를 요청한다.

## 확인 방법
1. `node --check <파일>` 문법 검사, `npm test`.
2. 화면 변경은 `test/mock-api.js`(+비서 창은 `mock-assistant.js`)로 브라우저에서 미리 볼 수 있다(Playwright 스크린샷).
3. `npm start`로 실제 실행.
4. exe: `npm run dist` (Windows) → `dist/MyScheduler-Setup-x.y.z.exe`, `dist/MyScheduler-Portable-x.y.z.exe`.

## 배포 (자동)
- `main`에 병합(push)되면 `.github/workflows/desktop-release.yml`이 테스트 → 설치 파일 빌드 → GitHub Releases 게시까지 자동으로 한다.
  버전은 `package.json`의 "주.부"에 실행 번호가 붙어 자동 증가(예: 0.4.17)하므로 version을 직접 올리지 않는다. (주·부를 바꾸고 싶을 때만 고친다.)
- 설치된 앱은 켠 뒤 10초 후와 3시간마다 새 버전을 확인하고, 받으면 Windows 알림을 띄운다(눌러서 바로 재시작 / 그냥 두면 앱을 끌 때 설치). 트레이 메뉴 "업데이트 확인"으로 수동 확인.
- 자동 업데이트는 **설치형(Setup)** 에서만 동작한다. 포터블은 안 된다. 업데이트가 이 저장소(edeny83-gif/my-scheduler)의 공개 Releases를 보므로 저장소·Releases가 공개여야 한다.

## 클라우드(폰) 세션에서 수정을 요청받았을 때
사용자는 교사이며, 폰의 Claude 앱 → Code 탭으로 "불편한 점"을 말로 요청한다. 다음을 지킨다.
1. 이 CLAUDE.md와 관련 파일을 읽고, 이해한 요청을 한두 줄로 다시 말한다. 정말 애매할 때만 한 번 질문한다.
2. 수정 후 `npm test`를 반드시 돌린다. 이 환경에서는 Windows 앱을 직접 실행해 볼 수 없으므로 화면 변경은 `test/mock-api.js` + Playwright 캡처로 확인하고, **확인하지 못한 것은 솔직히 적는다.**
3. `main`에 직접 push하지 않는다. 작업 브랜치로 PR을 만든다. PR 설명에 ① 무엇이 바뀌는지 ② 병합하면 어느 기기에 언제 반영되는지(PC: 앱 재시작 시) ③ 확인하지 못한 위험 을 쉬운 말로 적는다. 병합은 사용자가 직접 하거나, 사용자가 "병합해 줘"처럼 분명히 요청했을 때만 Claude가 한다(먼저 병합하지 않는다). Claude가 병합할 때는 직전에 시험(CI) 통과·충돌 없음을 확인하고, 병합 뒤 배포(무선 업데이트·설치 파일)가 성공했는지 확인해 알린다.
4. 일정 저장·동기화 형식을 바꿀 때: 기존 필드는 이름·의미를 바꾸지 말고 **새 필드만 추가**한다(기기마다 버전이 다른 동안에도 일정이 깨지면 안 된다). `sync-core.js`를 고치면 폰 저장소(my-scheduler-mobile)의 `src/core/sync-core.js`도 똑같이 고쳐 PR을 만든다. 두 저장소가 함께 열린 세션이 아니면 사용자에게 알린다.
5. 비밀값(API 키·비밀번호·토큰)을 코드·PR·커밋 메시지에 쓰지 않는다.
6. 병합 뒤 문제가 생겨 "되돌려줘"라고 하면, 해당 PR을 되돌리는(revert) PR을 만든다.

## 다음 단계 후보
- (완료) Firebase 동기화. 남은 것: 서버의 오래된 삭제 표시 정리, 구글 캘린더 쓰기 연동.
- Firebase 실시간 동기화: `store.js`를 Firestore 구현으로 교체(오프라인 캐시 유지), 로그인 창 추가.
- 구글 캘린더 양방향(쓰기): OAuth 필요. 지금은 iCal 주소로 읽기 전용.
- 스캔 PDF·배포용 HWP: 배포용 HWP는 미리보기 텍스트만 읽힌다 → PDF로 인쇄해 올리도록 안내.
- 반복 일정 입력(매주/매월) — 외부 캘린더의 반복 일정 표시는 이미 지원.
- 안드로이드 앱: 같은 데이터 모델, 같은 화면 규칙.
