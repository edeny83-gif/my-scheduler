// Firebase 웹 앱 설정값. 프로젝트를 구분하는 공개 값이라 코드에 들어 있어도 안전하다.
// 실제 보안은 Firestore 보안 규칙(firestore.rules: 로그인한 본인만 자기 데이터 접근)이 담당한다.
export const firebaseConfig = {
  apiKey: 'AIzaSyCKwmZKoKbQ-RNsUPkrYr_2fnjEOBjsXug',
  authDomain: 'my-scheduler-e7b5f.firebaseapp.com',
  projectId: 'my-scheduler-e7b5f',
  storageBucket: 'my-scheduler-e7b5f.firebasestorage.app',
  messagingSenderId: '768021571728',
  appId: '1:768021571728:web:8ccb2d0ebc7ab034fa9015',
};
