// push/_kakao.js — 토큰 회전 저장 + 메시지 200자 분할
// 회귀 방지: 카카오 refresh_token은 60일 만료. 회전분을 저장하지 않으면 알림이 조용히 끊긴다.
import { API, check, section, mockDB, mockFetch } from './_helpers.mjs';

const kakao = await import(API + 'push/_kakao.js');

section('refresh_token 회전 저장');
{
  const docs = {};
  const env = { KAKAO_REST_API_KEY: 'KEY', KAKAO_REFRESH_TOKEN: 'ENV_REFRESH', DB: mockDB(docs) };
  const calls = mockFetch([{ match: 'oauth/token', reply: { access_token: 'AT1', expires_in: 21600, refresh_token: 'ROTATED' } }]);

  await kakao.getAccessToken(env);
  const sent1 = new URLSearchParams(calls[0].opts.body).get('refresh_token');
  check('최초엔 시크릿의 refresh 사용', sent1 === 'ENV_REFRESH');
  check('회전된 refresh_token을 D1에 저장', JSON.parse(docs.kakao).refresh_token === 'ROTATED');
  check('성공 시각 기록', !!JSON.parse(docs.kakao).lastOkAt);

  await kakao.getAccessToken(env);
  const sent2 = new URLSearchParams(calls[1].opts.body).get('refresh_token');
  check('이후엔 D1의 회전 토큰 사용', sent2 === 'ROTATED');
}

section('실패 처리');
{
  const docs = { kakao: JSON.stringify({ refresh_token: 'KEEP' }) };
  const env = { KAKAO_REST_API_KEY: 'KEY', DB: mockDB(docs) };
  mockFetch([{ match: 'oauth/token', status: 401, reply: { error: 'invalid_grant' } }]);
  let threw = false;
  try { await kakao.getAccessToken(env); } catch (e) { threw = true; }
  check('실패 시 예외', threw);
  check('실패 원인 기록', !!JSON.parse(docs.kakao).lastError);
  check('실패해도 refresh_token 유지', JSON.parse(docs.kakao).refresh_token === 'KEEP');
}
{
  const env = { KAKAO_REST_API_KEY: 'KEY', DB: mockDB({}) }; // 토큰이 어디에도 없음
  let msg = '';
  try { await kakao.getAccessToken(env); } catch (e) { msg = e.message; }
  check('refresh_token 없으면 명확한 오류', msg.includes('kakao_no_refresh_token'));
}

section('메시지 200자 분할');
{
  const mk = (n, txt) => Array.from({ length: n }, (_, i) => ({ text: txt + (i + 1), dueDate: '2026-07-30' }));
  const small = kakao.buildKakaoMessages({ today: '2026-07-28', overdue: 1, dueToday: 1, upcoming: 0, overdueList: mk(1, '지연업무'), todayList: mk(1, '오늘업무'), upcomingList: [] });
  check('짧으면 1건', small.length === 1);
  check('1건도 200자 이내', small.every((m) => m.length <= 200));

  const big = kakao.buildKakaoMessages({ today: '2026-07-28', overdue: 12, dueToday: 12, upcoming: 12, overdueList: mk(12, '지연된업무제목입니다'), todayList: mk(12, '오늘마감업무제목'), upcomingList: mk(12, '임박업무제목') });
  check('길면 여러 건으로 분할', big.length > 1);
  check('모든 조각이 200자 이내', big.every((m) => m.length <= 200));
  check('분할 시 (k/N) 표기', big[0].includes('(1/' + big.length + ')'));
}

section('설정 감지');
{
  check('REST 키 없으면 미설정', kakao.kakaoConfigured({}) === false);
  check('REST 키 있으면 설정됨', kakao.kakaoConfigured({ KAKAO_REST_API_KEY: 'K' }) === true);
}
