// /api/push/kakao-test — 카카오 '나에게 보내기' 즉시 테스트. 앱 비밀번호(Bearer) 보호.
// 설정 확인용: 실제 할 일 요약을 카카오로 1회 발송한다.
import { authed, unauthorized } from '../_auth.js';
import { computeSummary } from './_send.js';
import { kakaoConfigured, sendKakaoMemo, buildKakaoText } from './_kakao.js';

export async function onRequestPost(context) {
  const { env } = context;
  if (!authed(context)) return unauthorized();

  const s = await computeSummary(env);
  const text = buildKakaoText(s) + '\n(테스트)';

  if (!kakaoConfigured(env)) {
    return Response.json({ ok: false, error: 'kakao_not_configured', preview: text }, { status: 400 });
  }
  try {
    const kakao = await sendKakaoMemo(env, text);
    return Response.json({ ok: kakao.ok, kakao, preview: text });
  } catch (e) {
    return Response.json({ ok: false, error: String((e && e.message) || e).slice(0, 200), preview: text }, { status: 500 });
  }
}
