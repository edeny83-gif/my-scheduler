// 비서 창 미리보기용: mock-api.js 뒤에 로드
(() => {
  const listeners = window.__mock.listeners;
  Object.assign(window.api, {
    aiStatus: async () => ({ gemini: true, claude: false, encryption: true, minConfidence: 0.6 }),
    pickFiles: async () => [],
    pathsForFiles: () => [],
    openAssistant: async () => {},
    undoItems: async () => {},
    addItems: async (items) => items.map((_, i) => 'id' + i),
    analyze: async ({ paths }) => {
      for (const p of paths) { listeners['ai-progress']?.({ file: p, stage: '완료', done: true }); }
      return [
        { file: paths[0], fileName: '2026 10월 학사일정 안내.hwp', kind: 'text', provider: 'gemini',
          summary: '10월 학부모 상담 주간(13~17일)과 신청서 제출 마감(8일), 체육대회(9일) 일정을 안내하는 공문입니다. 상담 시간은 방과 후 15시~17시입니다.',
          items: [
            { title: '학부모 상담 신청서 제출 마감', kind: '마감', date: '2026-10-08', time: '', confidence: 0.95, evidence: '10월 8일(수)까지 담임에게 제출', memo: '가정통신문 회신서 취합' },
            { title: '학부모 상담 주간', kind: '일정', date: '2026-10-13', endDate: '2026-10-17', time: '15:00', endTime: '17:00', confidence: 0.92 },
            { title: '가을 체육대회', kind: '일정', date: '2026-10-09', time: '09:00', location: '운동장', confidence: 0.9, duplicate: '체육대회' },
            { title: '1학기 성적 정정 기간', kind: '할 일', date: '2026-09-15', confidence: 0.8, past: true },
            { title: '학년 협의회 (추정)', kind: '일정', date: '2026-10-21', confidence: 0.45 },
          ],
          undated: [{ title: '상담 일정표 학년 게시판 공지', note: '상담 주간 전까지' }] },
        { file: paths[1], fileName: '학년협의회 녹음.m4a', kind: 'audio', provider: 'gemini',
          summary: '현장체험학습 장소를 치악산으로 확정하고, 안전교육 자료는 김 선생님이 준비하기로 했습니다.',
          items: [{ title: '현장체험학습 안전교육 자료 제출', kind: '마감', date: '2026-10-16', confidence: 0.88, evidence: '다음 주 금요일까지 자료 올려 주세요' }],
          undated: [] },
        { file: paths[2], fileName: '알림장.heic', error: '음성 파일 분석에는 Gemini API 키가 필요합니다', items: [], undated: [], summary: '' },
      ];
    },
  });
})();
