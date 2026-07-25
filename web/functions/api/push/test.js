// /api/push/test — 지금 즉시 테스트 푸시 발송. 앱 비밀번호 보호.
import { authed, unauthorized } from '../_auth.js';
import { sendToAll, computeSummary } from './_send.js';

export async function onRequestPost(context) {
  const { env } = context;
  if (!authed(context)) return unauthorized();
  const s = await computeSummary(env);
  const payload = {
    title: '🔔 SCLM 테스트 알림',
    body: `오늘 마감 ${s.dueToday}건 · 지연 ${s.overdue}건 (테스트)`,
    tag: 'sclm-test',
    url: '/'
  };
  const res = await sendToAll(env, payload);
  return Response.json({ ok: true, ...res, summary: { dueToday: s.dueToday, overdue: s.overdue } });
}
