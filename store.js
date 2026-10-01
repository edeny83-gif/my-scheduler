// 일정 저장소: 이 PC의 JSON 파일이 원본. 클라우드 동기화(sync-main.js)가 이 파일과 서버를 맞춘다.
// 로직은 PC·폰 공통(sync-core.js)이고, 여기서는 파일 저장만 맡는다.
const fs = require('node:fs');
const path = require('node:path');
const { LocalDocStore, clean } = require('./sync-core');

class LocalStore extends LocalDocStore {
  constructor(dir) {
    const file = path.join(dir, 'events.json');
    let data = null;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 처음 실행 */ }
    super({
      data,
      persist: (json) => {
        if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak'); // 직전 상태 백업
        const tmp = file + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(json, null, 2));
        fs.renameSync(tmp, file);
      },
    });
    this.file = file;
  }
}

module.exports = { LocalStore, clean };
