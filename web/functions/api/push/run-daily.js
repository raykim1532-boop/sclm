// /api/push/run-daily — 매일 아침 요약 푸시. Cron 워커가 X-Cron-Secret 헤더로 호출.
// 앱 비밀번호(Bearer)로도 호출 가능(수동 트리거/디버그용).
import { authed } from '../_auth.js';
import { sendToAll, computeSummary } from './_send.js';

function allowed(context) {
  const secret = context.env.CRON_SECRET;
  const got = context.request.headers.get('X-Cron-Secret') || '';
  if (secret && got && got === secret) return true;
  return authed(context);
}

export async function onRequestPost(context) {
  const { env } = context;
  if (!allowed(context)) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });

  const s = await computeSummary(env);
  // 알릴 것이 없으면 발송하지 않음
  if (s.dueToday === 0 && s.overdue === 0) {
    return Response.json({ ok: true, skipped: 'nothing_due', summary: { dueToday: 0, overdue: 0 } });
  }
  const parts = [];
  if (s.dueToday) parts.push(`오늘 마감 ${s.dueToday}건`);
  if (s.overdue) parts.push(`지연 ${s.overdue}건`);
  const payload = {
    title: '📌 오늘의 할 일',
    body: parts.join(' · ') + ' — 확인해 보세요',
    tag: 'sclm-daily',
    url: '/'
  };
  const res = await sendToAll(env, payload);
  return Response.json({ ok: true, ...res, summary: { dueToday: s.dueToday, overdue: s.overdue } });
}
