// 실행 중인 MyScheduler 캘린더 앱에 접속하는 클라이언트 (외부 패키지 없음)
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function apiFile() {
  if (process.env.MYSCHEDULER_API_FILE) return process.env.MYSCHEDULER_API_FILE;
  const base = process.platform === 'win32'
    ? (process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'))
    : process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support')
      : (process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'));
  return path.join(base, 'my-scheduler-desktop', 'api.json');
}

// 파일 경로는 보내기 전에 전체 경로로 바꾼다 (캘린더 앱은 다른 폴더에서 실행 중이므로)
function absolutize(body) {
  if (!body || typeof body !== 'object') return body;
  const b = { ...body };
  if (typeof b.path === 'string') b.path = path.resolve(b.path);
  if (Array.isArray(b.paths)) b.paths = b.paths.map((p) => path.resolve(String(p)));
  return b;
}

async function call(method, route, body) {
  body = absolutize(body);
  let info;
  try { info = JSON.parse(fs.readFileSync(apiFile(), 'utf8')); }
  catch { throw new Error('MyScheduler 캘린더 앱이 실행 중이 아닙니다. 캘린더를 먼저 실행하세요.'); }
  let res;
  try {
    res = await fetch(info.url + route, {
      method,
      headers: { Authorization: `Bearer ${info.token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error('MyScheduler 캘린더 앱에 연결할 수 없습니다. 캘린더가 실행 중인지 확인하세요.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

module.exports = { call, apiFile };
