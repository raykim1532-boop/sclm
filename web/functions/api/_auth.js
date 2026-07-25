// 앱 비밀번호(Bearer) 인증 공용 헬퍼. 파일명이 _로 시작해 라우팅되지 않음.
export function getToken(request) {
  const h = request.headers.get('Authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

export function safeEqual(a, b) {
  a = String(a || ''); b = String(b || '');
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export function authed(context) {
  const expected = context.env.APP_PASSWORD;
  const got = getToken(context.request);
  return !!expected && !!got && safeEqual(got, expected);
}

export const unauthorized = () =>
  new Response(JSON.stringify({ error: 'unauthorized' }), {
    status: 401, headers: { 'Content-Type': 'application/json' }
  });
