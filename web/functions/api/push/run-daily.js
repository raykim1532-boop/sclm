// /api/push/run-daily — 매일 아침 요약 알림. Cron 워커가 X-Cron-Secret 헤더로 호출.
// 앱 비밀번호(Bearer)로도 호출 가능(수동 트리거/디버그용).
// 웹푸시 + 카카오톡('나에게 보내기')을 함께 발송한다(각각 설정돼 있을 때만).
import { authed } from '../_auth.js';
import { sendToAll, computeSummary } from './_send.js';
import { kakaoConfigured, sendKakaoMessages, buildKakaoMessages } from './_kakao.js';
import { ensureDailySnapshot } from '../snapshots.js';
import { sendBriefMail, sendWeeklyMail } from './_mail.js';
import { computeWeekly } from './_send.js';

// 'cron' | 'auth' | false — 호출 주체 구분(크론 재시도 중복 방지에 사용)
function allowed(context) {
  const secret = context.env.CRON_SECRET;
  const got = context.request.headers.get('X-Cron-Secret') || '';
  if (secret && got && got === secret) return 'cron';
  return authed(context) ? 'auth' : false;
}

const todayKST = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

// 어느 스케줄러가 호출했는지 (gh-actions / cf-cron / cf-manual / unknown).
// GitHub Actions와 Cloudflare 크론을 함께 두고 있어서, 어느 쪽이 실제로 발사됐는지
// 나중에 D1의 'daily' 문서만 보면 알 수 있게 기록한다.
function callerSource(context) {
  const raw = context.request.headers.get('X-Cron-Source') || '';
  return raw.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 20) || 'unknown';
}

// 크론이 08:00·08:10 이중 발사(미발사 대비)되므로, 같은 날 이미 보냈으면 크론 호출은 건너뛴다.
// 수동(Bearer) 호출은 항상 발송한다(테스트·디버그용).
async function readDaily(env) {
  try {
    const row = await env.DB.prepare("SELECT data FROM documents WHERE id = 'daily'").first();
    if (row && row.data) return JSON.parse(row.data);
  } catch (e) {}
  return {};
}

// 호출 이력을 남긴다. action: 'sent' | 'skipped' | 'nothing_due'
// 발송(sent)일 때만 lastSentDay 를 갱신한다(중복 방지 가드의 기준).
// ⚠️ lastWeeklyDay 는 여기서 건드리지 않고 **그대로 물려준다** — 통짜로 새 객체를 쓰므로
//    빠뜨리면 주간 리포트 중복 가드가 매 호출마다 지워진다.
async function recordAttempt(env, source, action) {
  const prev = await readDaily(env);
  const today = todayKST();
  const sameDay = prev.lastSentDay === today || (prev.attempts || []).some((a) => a.day === today);
  const kept = (sameDay && Array.isArray(prev.attempts) ? prev.attempts : []).slice(-9);
  kept.push({ day: today, at: Date.now(), source, action });
  const data = {
    lastSentDay: action === 'sent' ? today : (prev.lastSentDay || ''),
    at: action === 'sent' ? Date.now() : (prev.at || 0),
    lastWeeklyDay: prev.lastWeeklyDay || '',
    attempts: kept
  };
  await env.DB
    .prepare("INSERT INTO documents (id, data, updated_at) VALUES ('daily', ?1, ?2) ON CONFLICT(id) DO UPDATE SET data = ?1, updated_at = ?2")
    .bind(JSON.stringify(data), Date.now())
    .run();
}

// 주간 리포트 발송일만 기록한다(다른 키는 그대로 둔다).
async function markWeeklySent(env) {
  const prev = await readDaily(env);
  const data = Object.assign({}, prev, { lastWeeklyDay: todayKST() });
  await env.DB
    .prepare("INSERT INTO documents (id, data, updated_at) VALUES ('daily', ?1, ?2) ON CONFLICT(id) DO UPDATE SET data = ?1, updated_at = ?2")
    .bind(JSON.stringify(data), Date.now())
    .run();
}

const isFridayKST = () => new Date(Date.now() + 9 * 3600e3).getUTCDay() === 5;

/* 금요일 주간 리포트 — **아침 브리핑과 독립적으로** 판정한다.
   ⚠️ 알릴 게 없는 날(nothing_due)에도 보내야 한다. 주간 리포트가 답하는 건 "오늘 뭘 하나"가
      아니라 "이번 주에 뭘 했나"라서, 한가한 금요일에 빠지면 정작 여유가 있어 돌아볼 만한
      주에 안 오게 된다. 그래서 nothing_due 조기 반환보다 앞에서 이 함수를 부른다.
   그 경로는 lastSentDay 를 세우지 않아 08:10 재시도가 또 들어온다. 중복은 브리핑 가드가
   아니라 **별도 키(lastWeeklyDay)** 로 막는다. */
async function maybeSendWeekly(env, todayIso) {
  if (!isFridayKST()) return { skipped: 'not_friday' };
  const daily = await readDaily(env);
  if (daily.lastWeeklyDay === todayKST()) return { skipped: 'already_sent_today' };
  let out;
  try { out = await sendWeeklyMail(env, await computeWeekly(env, todayIso)); }
  catch (e) { return { ok: false, error: String((e && e.message) || e).slice(0, 200) }; }
  if (out && out.ok) { try { await markWeeklySent(env); } catch (e) {} }
  return out;
}

export async function onRequestPost(context) {
  const { env } = context;
  const caller = allowed(context);
  if (!caller) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  const source = caller === 'auth' ? 'manual' : callerSource(context);

  // 하루 1회 백업 — **아래 조기 반환들보다 먼저** 한다.
  // 알릴 게 없는 날(nothing_due)도, 08:10 재시도(skipped)로 끝나는 날도 백업은 남아야 한다.
  // 실패해도 알림 발송을 막지 않는다(백업은 부수 작업이다).
  let backup = null;
  try { backup = await ensureDailySnapshot(env, 'daily-cron'); }
  catch (e) { backup = { ok: false, error: String((e && e.message) || e).slice(0, 120) }; }

  if (caller === 'cron') {
    const daily = await readDaily(env);
    if (daily.lastSentDay === todayKST()) {
      // 건너뛴 호출도 기록한다 — "크론이 발사는 됐는데 중복이라 넘어간 것"과
      // "아예 발사되지 않은 것"을 구분하기 위한 유일한 증거다.
      try { await recordAttempt(env, source, 'skipped'); } catch (e) {}
      return Response.json({ ok: true, skipped: 'already_sent_today', source, backup });
    }
  }

  // 시트 동기화는 2026-07-28 종료(앱이 원천). 알림 전 선동기화 단계도 함께 제거했다.
  const s = await computeSummary(env);

  // 알릴 것이 없으면(지연·오늘·임박·일정 모두 0) 발송하지 않음.
  // ⚠️ 일정도 조건에 넣어야 한다 — 할 일이 없어도 오늘 회의가 있으면 알려야 하므로.
  if (s.overdue === 0 && s.dueToday === 0 && s.upcoming === 0 && s.events === 0) {
    // 브리핑은 건너뛰되 **금요일 주간 리포트는 나간다**(maybeSendWeekly 주석 참고).
    const weekly = await maybeSendWeekly(env, s.today);
    try { await recordAttempt(env, source, 'nothing_due'); } catch (e) {}
    return Response.json({ ok: true, skipped: 'nothing_due', source, summary: summaryCounts(s), backup, weekly });
  }

  // 1) 웹푸시
  const payload = { title: '📌 오늘의 할 일과 일정', body: buildPushBody(s), tag: 'sclm-daily', url: '/' };
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

  // 3) 이메일 (설정돼 있을 때만). 푸시·카카오와 독립이라 실패해도 나머지는 그대로 간다.
  //    길이 제한이 없으므로 전체 목록을 담는다 — 메일로 받는 이유가 그것이다.
  let mail = { skipped: 'not_configured' };
  try { mail = await sendBriefMail(env, s); }
  catch (e) { mail = { ok: false, error: String((e && e.message) || e).slice(0, 200) }; }

  // 4) 금요일이면 주간 리포트도 함께 (메일이 설정된 경우에만).
  //    중복은 lastWeeklyDay 가 막는다 — 수동(Bearer) 호출로 브리핑을 다시 보내도
  //    주간 리포트까지 두 번 가지는 않는다.
  const weekly = await maybeSendWeekly(env, s.today);

  // 오늘 발송 완료 기록(크론 2차 발사가 중복 발송하지 않도록)
  try { await recordAttempt(env, source, 'sent'); } catch (e) {}

  return Response.json({ ok: true, push, kakao, mail, weekly, source, parts: messages.length, summary: summaryCounts(s), backup });
}

/* 웹푸시 본문 만들기 — 순수 함수(테스트에서 직접 부른다).
   각 구분마다 최대 3건까지 항목명을 보여 주고, 나머지는 "외 N건"으로 접는다.
   ⚠️ 길이 제한은 줄 단위로 처리한다 — 그냥 slice 하면 글자 중간에서 잘려
   "마리오아울…" 같은 토막 줄이 남는다. 덜어낸 만큼 "외 N건"이 자동으로 늘어난다. */
export function buildPushBody(s, limit = 320) {
  const parts = [];
  if (s.overdue) parts.push(`지연 ${s.overdue}`);
  if (s.dueToday) parts.push(`오늘 ${s.dueToday}`);
  if (s.upcoming) parts.push(`임박 ${s.upcoming}`);
  if (s.events) parts.push(`일정 ${s.events}`);
  const short = (t) => { const x = String(t.text || '').replace(/^\s*\[[^\]]*\]\s*/, '').trim(); return x.length > 24 ? x.slice(0, 24) + '…' : x; };
  const md = (iso) => (iso ? iso.slice(5).replace('-', '/') : '');
  const evAt = (e) => (e.allDay === false && e.startTime ? String(e.startTime).slice(0, 5) : '종일');
  const lines = [];
  (s.overdueList || []).slice(0, 3).forEach((t) => lines.push(`⏰ ${short(t)} (${md(t.dueDate)} 지연)`));
  (s.todayList || []).slice(0, 3).forEach((t) => lines.push(`📅 ${short(t)} 오늘 마감`));
  (s.upcomingList || []).slice(0, 3).forEach((t) => lines.push(`🔜 ${short(t)} (${md(t.dueDate)})`));
  (s.eventList || []).slice(0, 3).forEach((e) => lines.push(`🗓 ${evAt(e)} ${short({ text: e.title })}`));

  const total = (s.overdue || 0) + (s.dueToday || 0) + (s.upcoming || 0) + (s.events || 0);
  const head = parts.join(' · ') + '건';
  const compose = (ls) => {
    const more = total - ls.length;
    return head + (ls.length ? '\n' + ls.join('\n') : '') + (more > 0 ? `\n외 ${more}건` : '');
  };
  const shown = lines.slice();
  let body = compose(shown);
  while (body.length > limit && shown.length) { shown.pop(); body = compose(shown); }
  return body.slice(0, limit);
}

function summaryCounts(s) {
  return { overdue: s.overdue, dueToday: s.dueToday, upcoming: s.upcoming, events: s.events };
}
