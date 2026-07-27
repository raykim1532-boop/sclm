// /api/push/kakao-test — 카카오 '나에게 보내기' 즉시 테스트. 앱 비밀번호(Bearer) 보호.
// 실제 할 일 요약을 카카오로 발송(길면 자동 분할).
import { authed, unauthorized } from '../_auth.js';
import { computeSummary } from './_send.js';
import { kakaoConfigured, sendKakaoMessages, buildKakaoMessages } from './_kakao.js';

export async function onRequestPost(context) {
  const { env } = context;
  if (!authed(context)) return unauthorized();

  const s = await computeSummary(env);
  const messages = buildKakaoMessages(s);

  if (!kakaoConfigured(env)) {
    return Response.json({ ok: false, error: 'kakao_not_configured', parts: messages.length, preview: messages }, { status: 400 });
  }
  try {
    const kakao = await sendKakaoMessages(env, messages);
    return Response.json({ ok: kakao.ok, kakao, parts: messages.length, preview: messages });
  } catch (e) {
    return Response.json({ ok: false, error: String((e && e.message) || e).slice(0, 200), preview: messages }, { status: 500 });
  }
}
