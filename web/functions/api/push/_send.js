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
/* 보류 = "지금은 안 한다"고 결정한 것. 마감일이 지나도 지연으로 세지 않는다.
   ⚠️ 앱(src/app.js 의 todoIsHeld/todoIsLive)과 같은 규칙이어야 한다 —
      화면 숫자와 아침 브리핑 숫자가 어긋나면 둘 다 못 믿게 된다. */
function isHeld(t) { return (t.status || '') === '보류'; }
function isLive(t) { return !isDone(t) && !isHeld(t); }

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

/* 그 주의 월~일 범위. 앱의 weekRange 와 같은 규칙(월요일 시작). */
export function weekRangeKST(baseIso, offset) {
  const d = new Date(baseIso + 'T00:00:00Z');
  const dow = (d.getUTCDay() + 6) % 7;                 // 월=0
  d.setUTCDate(d.getUTCDate() - dow + (offset || 0) * 7);
  const start = d.toISOString().slice(0, 10);
  const e = new Date(d); e.setUTCDate(e.getUTCDate() + 6);
  return { start: start, end: e.toISOString().slice(0, 10) };
}

/* 금요일에 보낼 주간 요약 — 이번 주 완료 / 다음 주 마감 / 아직 지연.
   앱의 주간 리포트와 같은 구간을 쓴다(이번 주 월~일, 다음 주 월~일). */
export async function computeWeekly(env, todayIso) {
  const row = await env.DB.prepare("SELECT data FROM documents WHERE id = 'main'").first();
  let state = {};
  try { state = JSON.parse(row.data); } catch (e) {}
  const todos = Array.isArray(state.todos) ? state.todos : [];
  const today = todayIso || todayStrKST();
  const tw = weekRangeKST(today, 0);
  const nw = weekRangeKST(today, 1);

  const done = todos.filter((t) => isDone(t) && t.completedDate && t.completedDate >= tw.start && t.completedDate <= tw.end)
    .sort((a, b) => (a.completedDate < b.completedDate ? -1 : 1));
  const next = todos.filter((t) => isLive(t) && isIso(t.dueDate) && t.dueDate >= nw.start && t.dueDate <= nw.end)
    .sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1));
  const stillLate = todos.filter((t) => isLive(t) && isIso(t.dueDate) && t.dueDate < today)
    .sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1));

  return { today, week: tw, nextWeek: nw, doneList: done, nextList: next, lateList: stillLate,
    done: done.length, next: next.length, late: stillLate.length };
}

/* 어떤 달의 1일~말일. offset -1 이면 지난달. key 는 'YYYY-MM'. */
export function monthRangeKST(baseIso, offset) {
  const y = +String(baseIso).slice(0, 4);
  const m = +String(baseIso).slice(5, 7);
  const s = new Date(Date.UTC(y, m - 1 + (offset || 0), 1));
  const e = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + 1, 0));
  const start = s.toISOString().slice(0, 10);
  return { start, end: e.toISOString().slice(0, 10), key: start.slice(0, 7) };
}

/* 지난달 결산 — 매월 1일 아침에 보낸다.
   주간이 "이번 주에 뭘 했나"라면 월간은 "지난달을 어떻게 보냈나"다:
   실적(완료·기한 준수) + 넘어온 짐(아직 미완료) + 어디에 몰렸나(분류별).
   ⚠️ 지표 규칙은 앱의 `computeWorkStats` 와 같아야 한다 — 화면과 메일이 다른 숫자를
      말하면 둘 다 못 믿게 된다. 특히 등록일 필드는 `registeredDate` 다. */
export async function computeMonthly(env, todayIso) {
  const row = await env.DB.prepare("SELECT data FROM documents WHERE id = 'main'").first();
  let state = {};
  try { state = JSON.parse(row.data); } catch (e) {}
  const todos = Array.isArray(state.todos) ? state.todos : [];
  const projects = Array.isArray(state.projects) ? state.projects : [];
  const today = todayIso || todayStrKST();
  const mo = monthRangeKST(today, -1);
  const inMonth = (d) => isIso(d) && d >= mo.start && d <= mo.end;
  const days = (from, to) => Math.round((new Date(to + 'T00:00:00Z') - new Date(from + 'T00:00:00Z')) / 864e5);

  const done = todos.filter((t) => isDone(t) && inMonth(t.completedDate))
    .sort((a, b) => (a.completedDate < b.completedDate ? -1 : 1));
  // 지난달 말까지가 마감인데 아직 안 끝난 것 = 이번 달로 넘어온 짐
  const carried = todos.filter((t) => isLive(t) && isIso(t.dueDate) && t.dueDate <= mo.end)
    .sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1));

  const judged = done.filter((t) => isIso(t.dueDate));
  const onTime = judged.filter((t) => t.completedDate <= t.dueDate).length;
  // 소요일: 등록일·완료일이 모두 있고 순서가 뒤집히지 않은 건만(유입 데이터에 역전 사례가 있다)
  const lead = done.filter((t) => isIso(t.registeredDate) && t.completedDate >= t.registeredDate)
    .map((t) => days(t.registeredDate, t.completedDate));

  // 분류별 — 그 달에 완료한 건이 어디에 몰렸나
  const by = (pick) => {
    const map = new Map();
    done.forEach((t) => {
      const name = (pick(t) || '').trim() || '(미지정)';
      map.set(name, (map.get(name) || 0) + 1);
    });
    return [...map.entries()].map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1));
  };
  const pname = (id) => (projects.find((p) => p && p.id === id) || {}).name || '';

  return {
    today, month: mo,
    done: done.length, doneList: done,
    carried: carried.length, carriedList: carried,
    onTimeRate: judged.length ? Math.round(onTime / judged.length * 100) : null,
    onTimeBase: judged.length,
    avgLead: lead.length ? +(lead.reduce((a, b) => a + b, 0) / lead.length).toFixed(1) : null,
    byProject: by((t) => pname(t.projectId)).slice(0, 8),
    byChannel: by((t) => t.channel).slice(0, 8),
  };
}

/* 같은 분류에서 **반복해서** 밀리는 것을 찾는다 — 한 건씩 보면 안 보이는 경향이다.
   앱의 `computeStuckTaxo` 와 같은 규칙을 쓴다:
     · 표본 3건 이상 + 지연 2건 이상만 (1~2건짜리는 하나만 늦어도 '전부 지연'이 돼 소음이 된다)
     · '기타'는 분류가 아니라 잡동사니라 제외
     · 정렬은 지연 건수 → 평균 지연일
   ⚠️ 규칙을 바꾸면 app.js 의 computeStuckTaxo 도 같이 고칠 것 — 화면과 메일이 다른 말을 하면 안 된다.
   메일에서는 **중분류(거래처)** 축만 본다. 거기가 가장 행동으로 이어지는 축이다. */
export function computeStuckChannels(todos, today, minItems, limit) {
  const SKIP = ['기타'];
  const min = minItems || 3;
  const days = (from, to) => Math.round((new Date(to + 'T00:00:00Z') - new Date(from + 'T00:00:00Z')) / 864e5);
  const map = new Map();
  (Array.isArray(todos) ? todos : []).forEach((t) => {
    const name = ((t && t.channel) || '').trim();
    if (!name || SKIP.indexOf(name) > -1) return;
    let e = map.get(name);
    if (!e) { e = { name: name, total: 0, overdue: 0, lateSum: 0 }; map.set(name, e); }
    e.total++;
    if (isDone(t) || isHeld(t)) return;
    if (t.dueDate && t.dueDate < today) { e.overdue++; e.lateSum += days(t.dueDate, today); }
  });
  const out = [];
  map.forEach((e) => {
    if (e.total < min || e.overdue < 2) return;
    out.push({ name: e.name, total: e.total, overdue: e.overdue, avgLate: +(e.lateSum / e.overdue).toFixed(1) });
  });
  out.sort((a, b) => (b.overdue - a.overdue) || (b.avgLate - a.avgLate));
  return limit ? out.slice(0, limit) : out;
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
  const open = todos.filter((t) => isLive(t) && isIso(t.dueDate));
  // 지연은 **오래 밀린 순**(마감일 오름차순). 정렬을 안 하면 입력 순서대로 나가
  // 메일·푸시·카카오에서 3일 → 4일 → 3일 처럼 뒤섞여 보인다.
  const overdue = open.filter((t) => t.dueDate < today)
    .sort((a, b) => (a.dueDate < b.dueDate ? -1 : (a.dueDate > b.dueDate ? 1 : 0)));
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
    stuckList: computeStuckChannels(todos, today, 3, 3),
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
