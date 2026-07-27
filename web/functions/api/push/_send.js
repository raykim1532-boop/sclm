// 구독 전체에 푸시 발송 + 만료 구독 정리. 오늘/지연 요약 계산.
import { sendPush } from './_webpush.js';

function todayStrKST() {
  return new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
}
// 'YYYY-MM-DD' 기준 n일 뒤 날짜 문자열
function addDaysIso(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const isIso = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
// 임박 판정 기준: 오늘 이후 며칠까지를 '곧 마감'으로 볼지
const SOON_DAYS = 3;
function isDone(t) {
  const s = t.status || (t.done ? '완료' : '대기');
  return s === '완료' || s === '지연완료';
}

// documents 'main' 에서 오늘 마감/지연 건수 계산
export async function computeSummary(env) {
  const row = await env.DB.prepare("SELECT data FROM documents WHERE id = 'main'").first();
  let state = {};
  try { state = JSON.parse(row.data); } catch (e) {}
  const todos = Array.isArray(state.todos) ? state.todos : [];
  const today = todayStrKST();
  const soonLimit = addDaysIso(today, SOON_DAYS);
  const open = todos.filter((t) => !isDone(t) && isIso(t.dueDate));
  const overdue = open.filter((t) => t.dueDate < today);
  const dueToday = open.filter((t) => t.dueDate === today);
  // 임박: 오늘 이후 ~ SOON_DAYS 일 이내 (오늘/지연 제외)
  const upcoming = open
    .filter((t) => t.dueDate > today && t.dueDate <= soonLimit)
    .sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1));
  return {
    today,
    overdue: overdue.length,
    dueToday: dueToday.length,
    upcoming: upcoming.length,
    overdueList: overdue,
    todayList: dueToday,
    upcomingList: upcoming,
  };
}

// 모든 구독에 발송. 404/410(만료)이면 삭제.
export async function sendToAll(env, payload) {
  const subs = (await env.DB.prepare("SELECT endpoint, p256dh, auth FROM push_subs").all()).results || [];
  let sent = 0, removed = 0;
  const errors = [];
  for (const s of subs) {
    try {
      const r = await sendPush(env, s, payload);
      if (r.status === 404 || r.status === 410) {
        await env.DB.prepare("DELETE FROM push_subs WHERE endpoint = ?1").bind(s.endpoint).run();
        removed++;
      } else if (r.ok || r.status === 201) {
        sent++;
      } else {
        errors.push(r.status + ': ' + (await r.text()).slice(0, 80));
      }
    } catch (e) { errors.push(String(e.message || e).slice(0, 80)); }
  }
  return { subs: subs.length, sent, removed, errors: errors.slice(0, 5) };
}
