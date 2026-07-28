// /api/push/run-daily — 매일 아침 요약 알림. Cron 워커가 X-Cron-Secret 헤더로 호출.
// 앱 비밀번호(Bearer)로도 호출 가능(수동 트리거/디버그용).
// 웹푸시 + 카카오톡('나에게 보내기')을 함께 발송한다(각각 설정돼 있을 때만).
import { authed } from '../_auth.js';
import { sendToAll, computeSummary } from './_send.js';
import { kakaoConfigured, sendKakaoMessages, buildKakaoMessages } from './_kakao.js';
import { runSheetSync } from '../google/sheet-sync.js';

// 'cron' | 'auth' | false — 호출 주체 구분(크론 재시도 중복 방지에 사용)
function allowed(context) {
  const secret = context.env.CRON_SECRET;
  const got = context.request.headers.get('X-Cron-Secret') || '';
  if (secret && got && got === secret) return 'cron';
  return authed(context) ? 'auth' : false;
}

const todayKST = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

// 크론이 08:00·08:10 이중 발사(미발사 대비)되므로, 같은 날 이미 보냈으면 크론 호출은 건너뛴다.
// 수동(Bearer) 호출은 항상 발송한다(테스트·디버그용).
async function readDaily(env) {
  try {
    const row = await env.DB.prepare("SELECT data FROM documents WHERE id = 'daily'").first();
    if (row && row.data) return JSON.parse(row.data);
  } catch (e) {}
  return {};
}
async function markSent(env) {
  await env.DB
    .prepare("INSERT INTO documents (id, data, updated_at) VALUES ('daily', ?1, ?2) ON CONFLICT(id) DO UPDATE SET data = ?1, updated_at = ?2")
    .bind(JSON.stringify({ lastSentDay: todayKST(), at: Date.now() }), Date.now())
    .run();
}

export async function onRequestPost(context) {
  const { env } = context;
  const caller = allowed(context);
  if (!caller) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });

  if (caller === 'cron') {
    const daily = await readDaily(env);
    if (daily.lastSentDay === todayKST()) {
      return Response.json({ ok: true, skipped: 'already_sent_today' });
    }
  }

  // 0) 구글 시트가 연결돼 있으면 알림 전에 먼저 동기화(앱을 안 켜도 최신 시트 기준으로 알림)
  let sheet = { skipped: 'not_run' };
  try { sheet = await runSheetSync(env); } catch (e) { sheet = { error: String((e && e.message) || e).slice(0, 200) }; }

  const s = await computeSummary(env);

  // 알릴 것이 없으면(지연·오늘·임박 모두 0) 발송하지 않음
  if (s.overdue === 0 && s.dueToday === 0 && s.upcoming === 0) {
    return Response.json({ ok: true, skipped: 'nothing_due', sheet, summary: summaryCounts(s) });
  }

  // 1) 웹푸시 (지연/오늘/임박 — 항목명까지 나열)
  const parts = [];
  if (s.overdue) parts.push(`지연 ${s.overdue}`);
  if (s.dueToday) parts.push(`오늘 ${s.dueToday}`);
  if (s.upcoming) parts.push(`임박 ${s.upcoming}`);
  const short = (t) => { const x = String(t.text || '').replace(/^\s*\[[^\]]*\]\s*/, '').trim(); return x.length > 24 ? x.slice(0, 24) + '…' : x; };
  const md = (iso) => (iso ? iso.slice(5).replace('-', '/') : '');
  const lines = [];
  (s.overdueList || []).slice(0, 3).forEach((t) => lines.push(`⏰ ${short(t)} (${md(t.dueDate)} 지연)`));
  (s.todayList || []).slice(0, 3).forEach((t) => lines.push(`📅 ${short(t)} 오늘 마감`));
  (s.upcomingList || []).slice(0, 3).forEach((t) => lines.push(`🔜 ${short(t)} (${md(t.dueDate)})`));
  const shown = lines.length;
  const more = (s.overdue + s.dueToday + s.upcoming) - shown;
  const body = (parts.join(' · ') + '건') + (lines.length ? '\n' + lines.join('\n') : '') + (more > 0 ? `\n외 ${more}건` : '');
  const payload = { title: '📌 오늘의 할 일', body: body.slice(0, 320), tag: 'sclm-daily', url: '/' };
  const push = await sendToAll(env, payload);

  // 2) 카카오톡 메모 (설정돼 있을 때만; 길면 자동 분할 발송. 실패해도 푸시 결과는 유지)
  const messages = buildKakaoMessages(s);
  let kakao = { skipped: 'not_configured' };
  if (kakaoConfigured(env)) {
    try {
      kakao = await sendKakaoMessages(env, messages);
    } catch (e) {
      kakao = { ok: false, error: String((e && e.message) || e).slice(0, 200) };
    }
    // 카카오가 실패하면 조용히 끊기지 않도록 웹푸시로 알린다(토큰 만료 등).
    if (!kakao.ok) {
      try {
        await sendToAll(env, {
          title: '⚠️ 카카오 알림 실패',
          body: '카카오톡 발송이 실패했어요. 설정에서 카카오 연결을 확인해주세요.',
          tag: 'sclm-kakao-fail',
          url: '/',
        });
      } catch (e2) {}
    }
  }

  // 오늘 발송 완료 기록(크론 2차 발사가 중복 발송하지 않도록)
  try { await markSent(env); } catch (e) {}

  return Response.json({ ok: true, push, kakao, sheet, parts: messages.length, summary: summaryCounts(s) });
}

function summaryCounts(s) {
  return { overdue: s.overdue, dueToday: s.dueToday, upcoming: s.upcoming };
}
