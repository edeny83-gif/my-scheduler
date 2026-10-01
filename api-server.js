// Claude Code(MCP 서버·CLI)가 캘린더에 접속하는 로컬 HTTP 창구.
// 127.0.0.1에서만 열리고, 실행할 때마다 새 토큰을 만들어 api.json에 적는다(같은 PC의 사용자 프로그램만 읽을 수 있음).
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');

function startApiServer({ port, file, routes, log, version }) {
  const token = crypto.randomBytes(24).toString('hex');

  const server = http.createServer(async (req, res) => {
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/health') return send(200, { ok: true, app: 'MyScheduler', version });
      const auth = req.headers.authorization || '';
      if (auth !== `Bearer ${token}`) return send(401, { error: '인증 토큰이 올바르지 않습니다' });

      let body = {};
      if (req.method === 'POST' || req.method === 'PATCH') {
        const chunks = [];
        let size = 0;
        for await (const c of req) {
          size += c.length;
          if (size > 2_000_000) return send(413, { error: '요청이 너무 큽니다' });
          chunks.push(c);
        }
        const text = Buffer.concat(chunks).toString('utf8');
        body = text ? JSON.parse(text) : {};
      }
      const withId = url.pathname.startsWith('/events/');
      const key = `${req.method} ${withId ? '/events/:id' : url.pathname}`;
      const handler = routes[key];
      if (!handler) return send(404, { error: `없는 기능입니다: ${req.method} ${url.pathname}` });
      const id = withId ? decodeURIComponent(url.pathname.slice('/events/'.length)) : undefined;
      const result = await handler({ query: Object.fromEntries(url.searchParams), body, id });
      send(200, result ?? { ok: true });
    } catch (e) {
      log?.('API 오류', e);
      send(400, { error: e.message || String(e) });
    }
  });

  return new Promise((resolve) => {
    let p = port;
    const tryListen = () => {
      server.once('error', (e) => {
        if (e.code === 'EADDRINUSE' && p < port + 10) { p++; tryListen(); }
        else { log?.('API 서버를 열지 못했습니다', e); resolve(null); }
      });
      server.listen(p, '127.0.0.1', () => {
        fs.writeFileSync(file, JSON.stringify({ url: `http://127.0.0.1:${p}`, token, pid: process.pid, version }, null, 2));
        log?.(`Claude Code 연결 창구 열림: 127.0.0.1:${p}`);
        resolve({ port: p, token, close: () => { server.close(); try { fs.unlinkSync(file); } catch {} } });
      });
    };
    tryListen();
  });
}

module.exports = { startApiServer };
