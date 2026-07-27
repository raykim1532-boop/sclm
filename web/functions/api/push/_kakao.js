// 카카오톡 '나에게 보내기'(메모) 발송 모듈.
// refresh token(장기)으로 매 호출 시 access token(6시간)을 재발급받아 memo/default/send 호출.
// 필요한 시크릿(Pages sclm): KAKAO_REST_API_KEY, KAKAO_REFRESH_TOKEN (선택: KAKAO_CLIENT_SECRET)
const TOKEN_URL = 'https://kauth.kakao.com/oauth/token';
const MEMO_URL = 'https://kapi.kakao.com/v2/api/talk/memo/default/send';
const APP_URL = 'https://sclm.pages.dev';

export function kakaoConfigured(env) {
  return !!(env.KAKAO_REST_API_KEY && env.KAKAO_REFRESH_TOKEN);
}

// refresh_token 으로 access_token 재발급. 카카오가 새 refresh_token을 함께 줄 수도 있음(만료 임박 시).
export async function getAccessToken(env) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: env.KAKAO_REST_API_KEY,
    refresh_token: env.KAKAO_REFRESH_TOKEN,
  });
  if (env.KAKAO_CLIENT_SECRET) body.set('client_secret', env.KAKAO_CLIENT_SECRET);
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body: body.toString(),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    throw new Error('kakao_token_refresh_failed(' + r.status + '): ' + JSON.stringify(j).slice(0, 200));
  }
  return j; // { access_token, expires_in, [refresh_token], ... }
}

// 텍스트 메모 발송. text 템플릿은 최대 200자.
export async function sendKakaoMemo(env, text, linkUrl = APP_URL) {
  const tok = await getAccessToken(env);
  const template = {
    object_type: 'text',
    text: String(text || '').slice(0, 200),
    link: { web_url: linkUrl, mobile_web_url: linkUrl },
    button_title: '앱 열기',
  };
  const body = new URLSearchParams({ template_object: JSON.stringify(template) });
  const r = await fetch(MEMO_URL, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + tok.access_token,
      'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
    },
    body: body.toString(),
  });
  const t = await r.text();
  return { ok: r.ok, status: r.status, body: t.slice(0, 200) };
}

// 요약(computeSummary 결과)으로 200자 이내 카카오 메시지 구성.
function stripTag(s) {
  return String(s || '').replace(/^\s*\[[^\]]*\]\s*/, '').trim();
}
function shortTitle(t, n = 16) {
  const s = stripTag(t.text);
  return s.length > n ? s.slice(0, n) + '…' : s;
}
function mmdd(iso) {
  return iso ? iso.slice(5).replace('-', '/') : '';
}
export function buildKakaoText(s) {
  const lines = [`📌 SCLM 할 일 (${mmdd(s.today)})`];
  if (s.overdueList && s.overdueList.length) {
    lines.push(`⏰지연 ${s.overdueList.length} · ` + s.overdueList.map((t) => shortTitle(t)).join(', '));
  }
  if (s.todayList && s.todayList.length) {
    lines.push(`📅오늘 ${s.todayList.length} · ` + s.todayList.map((t) => shortTitle(t)).join(', '));
  }
  if (s.upcomingList && s.upcomingList.length) {
    lines.push(
      `🔜임박 ${s.upcomingList.length} · ` +
        s.upcomingList.map((t) => `${shortTitle(t, 12)}(${mmdd(t.dueDate)})`).join(', ')
    );
  }
  let msg = lines.join('\n');
  if (msg.length > 200) msg = msg.slice(0, 199) + '…';
  return msg;
}
