// POST /api/google/sync — 서버에서 구글 캘린더와 양방향 동기화(전용 "SCLM" 캘린더).
// SCLM<->구글 생성/수정/삭제. 변경분만 전송(서명 비교), 호출 상한으로 Cloudflare subrequest(50) 제한 회피.
import { authed, unauthorized, readGoogleDoc, writeGoogleDoc, getAccessToken } from './_util.js';

const CAL = 'https://www.googleapis.com/calendar/v3';
const MAX_OPS = 45; // 한 번의 동기화에서 구글 쓰기(생성/수정/삭제) 호출 상한

function addDays(dateStr, n) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const dt = new Date(Date.UTC(y, (m || 1) - 1, (d || 1) + n));
  return dt.toISOString().slice(0, 10);
}

async function gfetch(token, url, method = 'GET', body) {
  const r = await fetch(url, {
    method,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!r.ok) {
    const t = await r.text();
    const err = new Error(`${method} ${url.split('?')[0]} → ${r.status} ${t.slice(0, 140)}`);
    err.status = r.status;
    throw err;
  }
  return r.status === 204 ? {} : r.json();
}

async function ensureCalendar(token, gdoc, env) {
  if (gdoc.calendarId) return gdoc.calendarId;
  const list = await gfetch(token, `${CAL}/users/me/calendarList?maxResults=250`);
  const found = (list.items || []).find((c) => c.summary === 'SCLM');
  let calId;
  if (found) calId = found.id;
  else {
    const created = await gfetch(token, `${CAL}/calendars`, 'POST', { summary: 'SCLM', timeZone: 'Asia/Seoul' });
    calId = created.id;
  }
  gdoc.calendarId = calId;
  await writeGoogleDoc(env, gdoc);
  return calId;
}

function eventResource(e) {
  const allDay = e.allDay !== false && !e.startTime;
  const endBase = (e.end && e.end !== e.start) ? e.end : e.start;
  const res = {
    summary: e.title || '(제목 없음)',
    description: e.notes || '',
    extendedProperties: { private: { sclmType: 'event', sclmId: e.id } }
  };
  if (allDay) {
    res.start = { date: e.start };
    res.end = { date: addDays(endBase, 1) };
  } else {
    res.start = { dateTime: `${e.start}T${e.startTime || '09:00'}:00`, timeZone: 'Asia/Seoul' };
    res.end = { dateTime: `${endBase}T${e.endTime || e.startTime || '10:00'}:00`, timeZone: 'Asia/Seoul' };
  }
  return res;
}

function todoResource(t) {
  const text = t.text || '(제목 없음)';
  // 제목이 이미 [..] 로 시작하면 우선순위 접두를 붙이지 않음(이중 대괄호 방지)
  const pri = (t.priority && !/^\s*\[/.test(text)) ? `[${t.priority}] ` : '';
  const desc = [
    t.channel && ('채널: ' + t.channel),
    t.assignee && ('담당: ' + t.assignee),
    t.status && ('상태: ' + t.status),
    t.progress && ('진행: ' + t.progress),
    t.remarks && ('비고: ' + t.remarks)
  ].filter(Boolean).join('\n');
  return {
    summary: pri + text,
    description: desc,
    start: { date: t.dueDate },
    end: { date: addDays(t.dueDate, 1) },
    extendedProperties: { private: { sclmType: 'todo', sclmId: t.id } }
  };
}

// 구글에 보낼 내용의 서명(변경 감지용)
function sig(res) {
  return JSON.stringify([res.summary, res.description, res.start, res.end]);
}

// 앱 비밀번호(Bearer) 또는 크론 시크릿(X-Cron-Secret)이면 허용.
// 크론 워커가 매일 서버에서 캘린더를 갱신할 수 있게 한다(탭이 안 열려 있어도 최신 유지).
function allowed(context) {
  const secret = context.env.CRON_SECRET;
  const got = context.request.headers.get('X-Cron-Secret') || '';
  if (secret && got && got === secret) return true;
  return authed(context);
}

export async function onRequestPost(context) {
  if (!allowed(context)) return unauthorized();
  const out = await runCalendarSync(context.env);
  const status = out.error ? (out.error === 'not_connected' ? 400 : 500) : 200;
  return Response.json(out, { status });
}

// 공용 캘린더 동기화(엔드포인트/크론 공용). 실패 시 { error } 반환.
export async function runCalendarSync(env) {
  const tok = await getAccessToken(env);
  if (!tok) return { error: 'not_connected' };
  const token = tok.access_token;
  const gdoc = await readGoogleDoc(env);

  const row = await env.DB.prepare("SELECT data FROM documents WHERE id = 'main'").first();
  let state = {};
  try { state = JSON.parse(row.data); } catch (e) {}
  state.events = Array.isArray(state.events) ? state.events : [];
  state.todos = Array.isArray(state.todos) ? state.todos : [];
  state.settings = state.settings || {};
  const defProj = (Array.isArray(state.projects) && state.projects[0]) ? state.projects[0].id : 'default';

  const errors = [];
  let pushed = 0, updated = 0, pulled = 0, deletedLocal = 0, deletedRemote = 0;
  let ops = 0;
  let truncated = false;

  try {
    const calId = await ensureCalendar(token, gdoc, env);
    const enc = encodeURIComponent(calId);

    // ---- 구글 이벤트 전부 조회(창: -60d ~ +365d) ----
    const now = Date.now();
    const winStart = addDays(new Date(now).toISOString().slice(0, 10), -60);
    const winEnd = addDays(new Date(now).toISOString().slice(0, 10), 365);
    const timeMin = new Date(now - 60 * 864e5).toISOString();
    const timeMax = new Date(now + 365 * 864e5).toISOString();
    const gEvents = [];
    let pageToken;
    do {
      const url = `${CAL}/calendars/${enc}/events?singleEvents=true&maxResults=2500&timeMin=${timeMin}&timeMax=${timeMax}` + (pageToken ? `&pageToken=${pageToken}` : '');
      const page = await gfetch(token, url);
      (page.items || []).forEach((e) => gEvents.push(e));
      pageToken = page.nextPageToken;
    } while (pageToken);

    const present = new Set();       // 현재 구글에 존재하는 이벤트 id
    const bySclmId = new Map();      // sclmId -> 구글 이벤트
    for (const g of gEvents) {
      if (g.status === 'cancelled') continue;
      present.add(g.id);
      const priv = (g.extendedProperties && g.extendedProperties.private) || {};
      if (priv.sclmId) bySclmId.set(priv.sclmId, g);
    }
    const inWindow = (d) => d && d >= winStart && d <= winEnd;

    // ---- (C) 구글 → SCLM 삭제: 이전에 동기화됐는데(googleId 보유) 창 안이면서 구글에서 사라진 항목 제거 ----
    const beforeT = state.todos.length, beforeE = state.events.length;
    state.todos = state.todos.filter((t) => {
      if (t.googleId && inWindow(t.dueDate) && !present.has(t.googleId)) return false;
      return true;
    });
    state.events = state.events.filter((e) => {
      if (e.googleId && inWindow(e.start) && !present.has(e.googleId)) return false;
      return true;
    });
    deletedLocal = (beforeT - state.todos.length) + (beforeE - state.events.length);

    // ---- 구글 → SCLM 신규 가져오기: SCLM이 만들지 않은(외부) 새 일정 ----
    const knownGids = new Set([
      ...state.events.filter((e) => e.googleId).map((e) => e.googleId),
      ...state.todos.filter((t) => t.googleId).map((t) => t.googleId)
    ]);
    for (const g of gEvents) {
      if (g.status === 'cancelled') continue;
      const priv = (g.extendedProperties && g.extendedProperties.private) || {};
      if (priv.sclmType) continue;
      if (knownGids.has(g.id)) continue;
      const allDay = !!(g.start && g.start.date);
      const startDate = allDay ? g.start.date : ((g.start && g.start.dateTime) || '').slice(0, 10);
      if (!startDate) continue;
      state.events.push({
        id: 'g' + Math.random().toString(36).slice(2, 10),
        googleId: g.id,
        source: 'google',
        title: g.summary || '(제목 없음)',
        start: startDate,
        end: allDay ? addDays(g.end.date, -1) : (((g.end && g.end.dateTime) || '').slice(0, 10) || startDate),
        allDay: allDay,
        startTime: allDay ? '' : ((g.start.dateTime || '').slice(11, 16)),
        endTime: allDay ? '' : (((g.end && g.end.dateTime) || '').slice(11, 16)),
        projectId: defProj,
        notes: g.description || '',
        color: ''
      });
      pulled++;
    }

    // ---- (C) SCLM → 구글 삭제: SCLM에서 지운 항목의 구글 이벤트 제거(고아 정리) ----
    const localIds = new Set([...state.todos.map((t) => t.id), ...state.events.map((e) => e.id)]);
    for (const g of gEvents) {
      if (ops >= MAX_OPS) { truncated = true; break; }
      if (g.status === 'cancelled') continue;
      const priv = (g.extendedProperties && g.extendedProperties.private) || {};
      if (priv.sclmType && priv.sclmId && !localIds.has(priv.sclmId)) {
        try {
          const r = await fetch(`${CAL}/calendars/${enc}/events/${g.id}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } });
          if (r.ok || r.status === 404 || r.status === 410) deletedRemote++;
          ops++;
        } catch (err) { errors.push('del: ' + err.message); }
      }
    }

    // ---- SCLM → 구글 생성/수정(변경분만) ----
    async function upsert(item, res) {
      const s = sig(res);
      if (item.googleId && item.gSig === s && present.has(item.googleId)) return; // 변화 없음
      if (ops >= MAX_OPS) { truncated = true; return; }
      if (item.googleId && present.has(item.googleId)) {
        const r = await fetch(`${CAL}/calendars/${enc}/events/${item.googleId}`, {
          method: 'PUT', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(res)
        });
        ops++;
        if (r.ok) { item.gSig = s; updated++; return; }
        if (r.status !== 404 && r.status !== 410) { const t = await r.text(); throw new Error(`PUT ${r.status} ${t.slice(0, 120)}`); }
      }
      // 신규 생성
      if (ops >= MAX_OPS) { truncated = true; return; }
      const c = await gfetch(token, `${CAL}/calendars/${enc}/events`, 'POST', res);
      ops++;
      item.googleId = c.id; item.gSig = s; pushed++;
    }

    for (const e of state.events) {
      if (truncated) break;
      try { await upsert(e, eventResource(e)); } catch (err) { errors.push('event: ' + err.message); }
    }
    for (const t of state.todos) {
      if (truncated) break;
      if (!t.dueDate) continue;
      try { await upsert(t, todoResource(t)); } catch (err) { errors.push('todo#' + (t.no || '') + ': ' + err.message); }
    }

    state.settings.googleLastSync = Date.now();
    await env.DB
      .prepare("INSERT INTO documents (id, data, updated_at) VALUES ('main', ?1, ?2) ON CONFLICT(id) DO UPDATE SET data = ?1, updated_at = ?2")
      .bind(JSON.stringify(state), Date.now())
      .run();

    return { ok: true, pushed, updated, pulled, deletedLocal, deletedRemote, truncated, calendarId: calId, errors: errors.slice(0, 5) };
  } catch (err) {
    return { error: String(err.message || err), pushed, updated, pulled, deletedLocal, deletedRemote, errors: errors.slice(0, 5) };
  }
}
