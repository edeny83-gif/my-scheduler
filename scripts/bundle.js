// 동기화 창 코드(+Firebase SDK)를 한 파일로 묶는다: src/sync-window.bundle.js
const path = require('node:path');
const esbuild = require('esbuild');
const root = path.join(__dirname, '..');
esbuild.buildSync({
  entryPoints: [path.join(root, 'src', 'sync-window.js')],
  bundle: true, minify: true, format: 'iife', platform: 'browser', target: 'chrome120',
  outfile: path.join(root, 'src', 'sync-window.bundle.js'), logLevel: 'info',
});
