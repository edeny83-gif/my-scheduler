// 숨은 창에서 실행되는 Firebase 연결부 (npm run bundle로 sync-window.bundle.js가 만들어진다)
import { initializeApp } from 'firebase/app';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import * as fs from 'firebase/firestore';
import { firebaseConfig } from './firebase-config.js';
import { listen, pushDocs, friendlyError } from '../sync-core.js';

const send = (msg) => window.bridge.send(msg);
const app = initializeApp(firebaseConfig);
const auth = getAuth(app); // 로그인 상태는 이 창의 IndexedDB에 저장 → 앱을 다시 켜도 로그인 유지(비밀번호는 저장하지 않음)

let db;
try {
  // 오프라인에서도 마지막 데이터를 보여 주고, 연결되면 이어서 동기화
  db = fs.initializeFirestore(app, { localCache: fs.persistentLocalCache({ tabManager: fs.persistentSingleTabManager({}) }) });
} catch (e) {
  db = fs.getFirestore(app);
}

let unsub = null;
let phase = 'signed-out';
function state(p, extra = {}) {
  phase = p;
  const u = auth.currentUser;
  send({ type: 'state', phase: p, email: u ? u.email || '' : '', uid: u ? u.uid : '', error: extra.error || '', code: extra.code || '' });
}
function detach() { if (unsub) { unsub(); unsub = null; } }

onAuthStateChanged(auth, (user) => {
  detach();
  if (!user) { state('signed-out'); return; }
  state('connecting');
  unsub = listen(fs, db, user.uid, {
    onSnapshot: (docs, meta) => {
      send({ type: 'snapshot', uid: user.uid, docs, fromCache: meta.fromCache });
      state(meta.fromCache ? (navigator.onLine ? 'connecting' : 'offline') : 'online');
    },
    onError: (err) => state('error', { error: friendlyError(err), code: err.code }),
  });
});
window.addEventListener('offline', () => { if (auth.currentUser) state('offline'); });
window.addEventListener('online', () => { if (auth.currentUser && phase === 'offline') state('connecting'); });

window.bridge.onCommand(async (msg) => {
  const reply = (r) => send({ type: 'reply', id: msg.id, ...r });
  try {
    if (msg.cmd === 'login') {
      await signInWithEmailAndPassword(auth, String(msg.email || '').trim(), String(msg.password || ''));
      reply({ ok: true });
    } else if (msg.cmd === 'logout') {
      await signOut(auth);
      reply({ ok: true });
    } else if (msg.cmd === 'push') {
      const u = auth.currentUser;
      if (!u) throw Object.assign(new Error('로그인이 필요합니다'), { code: 'signed-out' });
      await pushDocs(fs, db, u.uid, msg.docs);
      reply({ ok: true });
    } else reply({ ok: false, error: '알 수 없는 명령입니다' });
  } catch (e) {
    reply({ ok: false, code: e.code || '', error: friendlyError(e) });
  }
});
send({ type: 'ready' });
