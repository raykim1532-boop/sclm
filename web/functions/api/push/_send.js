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

/* 오늘에 걸친 일정을 뽑는다(종일 → 시간순).
   여러 날짜에 걸친 일정도 오늘이 그 사이면 포함한다(start <= 오늘 <= end).
   구글에서 읽기 전용으로 가져온 일정(roCal)도 같은 events 배열에 있으므로 함께 잡힌다.
   순수 함수 — 테스트에서 추출해 검증한다. */
export function pickTodayEvents(events, today) {
  const list = (Array.isArray(events) ? events : []).filter((e) => {
    const s = String((e && e.start) || '').slice(0, 10);
    if (!s) return false;
    const en = String((e.end || e.start) || '').slice(0, 10) || s;
    return s <= today && today <= en;
  });
  // 종일이 위, 그다음 시작시각 순. 구글 캘린더와 같은 배열이라 눈에 익다.
  const at = (e) => (e.allDay === false && e.startTime ? e.startTime : '');
  return list.sort((a, b) => {
    const x = at(a), y = at(b);
    if (!x !== !y) return x ? 1 : -1;
    if (x !== y) return x < y ? -1 : 1;
    return String(a.title || '').localeCompare(String(b.title || ''));
  });
}

// documents 'main' 에서 오늘 마감/지연 건수 + 오늘 일정 계산
export async function computeSummary(env) {
  const row = await env.DB.prepare("SELECT data FROM documents WHERE id = 'main'").first();
  let state = {};
  try { state = JSON.parse(row.data); } catch (e) {}
  const todos = Array.isArray(state.todos) ? state.todos : [];
  const today = todayStrKST();
  const eventList = pickTodayEvents(state.events, today);
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
    events: eventList.length,
    overdueList: overdue,
    todayList: dueToday,
    upcomingList: upcoming,
    eventList,
  };
}

// 모든 구독에 발송. 404/410(만료)이면 삭제.
// 403(VAPID 키 불일치)도 삭제한다 — 키 로테이션 이전에 등록된 구독은 현재 키로 영구히 발송 불가.
export async function sendToAll(env, payload) {
  const subs = (await env.DB.prepare("SELECT endpoint, p256dh, auth FROM push_subs").all()).results || [];
  let sent = 0, removed = 0;
  const errors = [];
  for (const s of subs) {
    try {
      const r = await sendPush(env, s, payload);
      if (r.status === 404 || r.status === 410 || r.status === 403) {
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
