// /api/assistant — 자연어 일정 비서. Google Gemini(무료 등급) function-calling으로 D1의 todos/events를 조회·생성.
// 앱 비밀번호(Bearer) 보호. GEMINI_API_KEY(secret) 필요.
import { authed, unauthorized } from './_auth.js';

const MODEL = 'gemini-2.5-flash';
const API = (key) => `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(key)}`;

function kstToday() { return new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10); }
function addDays(dateStr, n) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const dt = new Date(Date.UTC(y, (m || 1) - 1, (d || 1) + n));
  return dt.toISOString().slice(0, 10);
}
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
const isDone = (t) => { const s = t.status || (t.done ? '완료' : '대기'); return s === '완료' || s === '지연완료'; };

async function loadState(env) {
  const row = await env.DB.prepare("SELECT data FROM documents WHERE id = 'main'").first();
  let s = {}; try { s = JSON.parse(row.data); } catch (e) {}
  s.todos = Array.isArray(s.todos) ? s.todos : [];
  s.events = Array.isArray(s.events) ? s.events : [];
  s.projects = Array.isArray(s.projects) ? s.projects : [];
  s.channels = Array.isArray(s.channels) ? s.channels : [];
  return s;
}
async function saveState(env, s) {
  await env.DB.prepare("INSERT INTO documents (id, data, updated_at) VALUES ('main', ?1, ?2) ON CONFLICT(id) DO UPDATE SET data = ?1, updated_at = ?2")
    .bind(JSON.stringify(s), Date.now()).run();
}

// ---- 도구 정의 (Gemini functionDeclarations) ----
const FUNCTIONS = [
  {
    name: 'list_schedule',
    description: '지정한 기간의 할 일과 일정을 조회한다. "내일 뭐 있어?", "이번 주 마감" 같은 질문에 사용.',
    parameters: {
      type: 'OBJECT',
      properties: {
        date_from: { type: 'STRING', description: '시작일 YYYY-MM-DD (포함)' },
        date_to: { type: 'STRING', description: '종료일 YYYY-MM-DD (포함)' },
        include_done: { type: 'BOOLEAN', description: '완료 항목 포함 여부(기본 false)' }
      },
      required: ['date_from', 'date_to']
    }
  },
  {
    name: 'find_free_slots',
    description: '특정 날짜에 시간이 지정된 일정 사이의 빈 시간대를 찾는다. 미팅을 잡기 전에 먼저 호출.',
    parameters: {
      type: 'OBJECT',
      properties: {
        date: { type: 'STRING', description: '날짜 YYYY-MM-DD' },
        part_of_day: { type: 'STRING', enum: ['morning', 'afternoon', 'evening', 'day'], description: '오전(09-12)/오후(13-18)/저녁(18-21)/하루(09-18)' },
        duration_minutes: { type: 'NUMBER', description: '필요한 시간(분), 기본 60' }
      },
      required: ['date']
    }
  },
  {
    name: 'add_event',
    description: '캘린더에 일정(미팅 등)을 추가한다.',
    parameters: {
      type: 'OBJECT',
      properties: {
        title: { type: 'STRING' },
        date: { type: 'STRING', description: '날짜 YYYY-MM-DD' },
        start_time: { type: 'STRING', description: '시작 HH:MM (24h). 생략 시 종일 일정' },
        end_time: { type: 'STRING', description: '종료 HH:MM (선택)' },
        notes: { type: 'STRING' }
      },
      required: ['title', 'date']
    }
  },
  {
    name: 'add_todo',
    description: '할 일(업무)을 추가한다.',
    parameters: {
      type: 'OBJECT',
      properties: {
        text: { type: 'STRING', description: '업무 내용' },
        due_date: { type: 'STRING', description: '마감일 YYYY-MM-DD (선택)' },
        priority: { type: 'STRING', enum: ['긴급', '중요', '보통'], description: '선택' },
        project_name: { type: 'STRING', description: '대분류 이름 (선택, 기존 목록에서)' },
        channel: { type: 'STRING', description: '세부채널 (선택)' },
        assignee: { type: 'STRING', description: '담당자 (선택)' }
      },
      required: ['text']
    }
  },
  {
    name: 'complete_todo',
    description: '내용이 일치하는 미완료 할 일을 완료 처리한다.',
    parameters: {
      type: 'OBJECT',
      properties: { text_contains: { type: 'STRING', description: '완료할 할 일 내용(부분 일치)' } },
      required: ['text_contains']
    }
  },
  {
    name: 'update_todo',
    description: '내용이 일치하는 할 일의 상태·마감일·우선순위·진행사항을 수정한다. "미루기/변경/진행중으로" 등에 사용.',
    parameters: {
      type: 'OBJECT',
      properties: {
        text_contains: { type: 'STRING', description: '수정할 할 일 내용(부분 일치)' },
        new_status: { type: 'STRING', enum: ['대기', '진행중', '완료', '지연완료', '보류'] },
        new_due_date: { type: 'STRING', description: '새 마감일 YYYY-MM-DD' },
        new_priority: { type: 'STRING', enum: ['긴급', '중요', '보통'] },
        progress_note: { type: 'STRING', description: '진행사항에 덧붙일 메모' }
      },
      required: ['text_contains']
    }
  },
  {
    name: 'delete_todo',
    description: '내용이 일치하는 할 일을 삭제한다.',
    parameters: {
      type: 'OBJECT',
      properties: { text_contains: { type: 'STRING', description: '삭제할 할 일 내용(부분 일치)' } },
      required: ['text_contains']
    }
  },
  {
    name: 'weekly_report',
    description: '주간 리포트용 데이터를 만든다. 이번 주 완료 / 다음 주 마감 예정 / 지연 항목을 반환. "이번 주 한 일 정리해줘/주간보고 써줘"에 사용.',
    parameters: { type: 'OBJECT', properties: { week_offset: { type: 'NUMBER', description: '0=이번주(기본), -1=지난주' } } }
  },
  {
    name: 'monthly_report',
    description: '월간 리포트용 데이터. 그 달 완료 / 그 달 마감인데 미완료 / 다음 달 예정 + 대분류별 요약. "이번 달 정리해줘/월간보고"에 사용.',
    parameters: { type: 'OBJECT', properties: { month_offset: { type: 'NUMBER', description: '0=이번달(기본), -1=지난달' } } }
  },
  {
    name: 'search_todos',
    description: '조건으로 할 일을 찾는다. 마감일 기준이 아닌 "채널/대분류/담당자/키워드/상태"로 찾을 때 사용. 예: "엔터식스 관련 업무 보여줘", "긴급인데 아직 안 끝난 것".',
    parameters: {
      type: 'OBJECT',
      properties: {
        keyword: { type: 'STRING', description: '업무 내용에 포함된 말(부분 일치)' },
        project_name: { type: 'STRING', description: '대분류 이름(부분 일치)' },
        channel: { type: 'STRING', description: '세부채널(부분 일치)' },
        assignee: { type: 'STRING', description: '담당자(부분 일치)' },
        status: { type: 'STRING', enum: ['대기', '진행중', '완료', '지연완료', '보류'] },
        priority: { type: 'STRING', enum: ['긴급', '중요', '보통'] },
        due_from: { type: 'STRING', description: '마감일 시작 YYYY-MM-DD' },
        due_to: { type: 'STRING', description: '마감일 종료 YYYY-MM-DD' },
        only_overdue: { type: 'BOOLEAN', description: '지연(마감 지난 미완료)만' },
        include_done: { type: 'BOOLEAN', description: '완료 항목 포함(기본 false)' },
        limit: { type: 'NUMBER', description: '최대 개수(기본 20, 최대 50)' }
      }
    }
  },
  {
    name: 'count_todos',
    description: '조건에 맞는 할 일의 "건수"를 센다. 목록이 아니라 숫자만 필요할 때. group_by를 주면 분류별 건수를 함께 낸다. 예: "이번 달 정산 몇 건 남았어?", "채널별로 몇 건씩 남았어?"',
    parameters: {
      type: 'OBJECT',
      properties: {
        keyword: { type: 'STRING' },
        project_name: { type: 'STRING' },
        channel: { type: 'STRING' },
        assignee: { type: 'STRING' },
        status: { type: 'STRING', enum: ['대기', '진행중', '완료', '지연완료', '보류'] },
        priority: { type: 'STRING', enum: ['긴급', '중요', '보통'] },
        due_from: { type: 'STRING', description: '마감일 시작 YYYY-MM-DD' },
        due_to: { type: 'STRING', description: '마감일 종료 YYYY-MM-DD' },
        only_overdue: { type: 'BOOLEAN' },
        include_done: { type: 'BOOLEAN', description: '완료 포함(기본 false)' },
        group_by: { type: 'STRING', enum: ['project', 'channel', 'status', 'priority', 'assignee', 'due_month', 'completed_month'], description: '분류 기준(선택)' }
      }
    }
  },
  {
    name: 'work_stats',
    description: '처리 지표를 계산한다: 평균 완료 소요일, 기한 준수율, 이번 달 완료(전월 대비), 지연 건수와 평균 경과일, 데이터 누락 건수. "요즘 얼마나 밀렸어?", "일 처리 얼마나 걸려?"에 사용.',
    parameters: { type: 'OBJECT', properties: {} }
  }
];

// ---- 조회 도구 공용 ----
const inc = (v, q) => String(v || '').toLowerCase().includes(String(q || '').toLowerCase());

function filterTodos(s, f) {
  const today = kstToday();
  const projName = (t) => (s.projects.find((p) => p.id === t.projectId) || {}).name || '';
  return s.todos.filter((t) => {
    if (!f.include_done && !f.status && isDone(t)) return false;
    if (f.status && (t.status || (t.done ? '완료' : '대기')) !== f.status) return false;
    if (f.keyword && !inc(t.text, f.keyword)) return false;
    if (f.project_name && !inc(projName(t), f.project_name)) return false;
    if (f.channel && !inc(t.channel, f.channel)) return false;
    if (f.assignee && !inc(t.assignee, f.assignee)) return false;
    if (f.priority && (t.priority || '') !== f.priority) return false;
    if (f.due_from && !(t.dueDate && t.dueDate >= f.due_from)) return false;
    if (f.due_to && !(t.dueDate && t.dueDate <= f.due_to)) return false;
    if (f.only_overdue && !(!isDone(t) && t.dueDate && t.dueDate < today)) return false;
    return true;
  });
}

function todoBrief(s, t) {
  const p = (s.projects.find((x) => x.id === t.projectId) || {}).name || '';
  return {
    업무: t.text, 대분류: p, 채널: t.channel || '', 담당: t.assignee || '',
    마감: t.dueDate || '', 상태: t.status || (t.done ? '완료' : '대기'),
    우선순위: t.priority || '', 완료일: t.completedDate || ''
  };
}

function monthRangeK(baseStr, offset) {
  const y = +baseStr.slice(0, 4), m = +baseStr.slice(5, 7) - 1;
  const first = new Date(Date.UTC(y, m + (offset || 0), 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0));
  const f = (x) => x.toISOString().slice(0, 10);
  return { start: f(first), end: f(last), label: first.getUTCFullYear() + '-' + String(first.getUTCMonth() + 1).padStart(2, '0') };
}

// ---- 도구 실행 ----
// export: web/tests/assistant-tools.test.mjs 에서 직접 호출해 검증한다(Gemini 호출 없이).
export function runTool(name, input, s) {
  if (name === 'list_schedule') {
    const from = input.date_from, to = input.date_to, incDone = !!input.include_done;
    const todos = s.todos.filter((t) => t.dueDate && t.dueDate >= from && t.dueDate <= to && (incDone || !isDone(t)))
      .map((t) => ({ 업무: t.text, 마감: t.dueDate, 상태: t.status || (t.done ? '완료' : '대기'), 채널: t.channel || '', 우선순위: t.priority || '' }));
    const events = s.events.filter((e) => (e.start || '').slice(0, 10) >= from && (e.start || '').slice(0, 10) <= to)
      .map((e) => ({ 일정: e.title, 날짜: (e.start || '').slice(0, 10), 시간: e.allDay === false && e.startTime ? e.startTime + (e.endTime ? '~' + e.endTime : '') : '종일', 메모: e.notes || '' }));
    return { changed: false, result: { 기간: from + '~' + to, 할일: todos, 일정: events, 개수: { 할일: todos.length, 일정: events.length } } };
  }
  if (name === 'find_free_slots') {
    const date = input.date;
    const dur = input.duration_minutes || 60;
    const ranges = { morning: [540, 720], afternoon: [780, 1080], evening: [1080, 1260], day: [540, 1080] };
    const [ws, we] = ranges[input.part_of_day || 'day'];
    const toMin = (hm) => { const [h, m] = String(hm).split(':').map(Number); return h * 60 + (m || 0); };
    const busy = s.events.filter((e) => (e.start || '').slice(0, 10) === date && e.allDay === false && e.startTime)
      .map((e) => [toMin(e.startTime), e.endTime ? toMin(e.endTime) : toMin(e.startTime) + 60])
      .sort((a, b) => a[0] - b[0]);
    const slots = [];
    let cur = ws;
    for (const [bs, be] of busy) {
      if (bs > cur && bs - cur >= dur) slots.push([cur, Math.min(bs, we)]);
      cur = Math.max(cur, be);
      if (cur >= we) break;
    }
    if (we - cur >= dur) slots.push([cur, we]);
    const fmt = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
    return { changed: false, result: { 날짜: date, 빈시간: slots.filter(([a, b]) => b > a).map(([a, b]) => fmt(a) + '~' + fmt(b)), 기존일정: busy.map(([a, b]) => fmt(a) + '~' + fmt(b)) } };
  }
  if (name === 'add_event') {
    const allDay = !input.start_time;
    const ev = {
      id: uid(), title: input.title, start: input.date, end: '',
      allDay, startTime: allDay ? '' : input.start_time, endTime: allDay ? '' : (input.end_time || ''),
      projectId: (s.projects[0] && s.projects[0].id) || 'default', color: '', notes: input.notes || ''
    };
    s.events.push(ev);
    return { changed: true, result: { 추가됨: '일정', 제목: ev.title, 날짜: ev.start, 시간: allDay ? '종일' : ev.startTime } };
  }
  if (name === 'add_todo') {
    const proj = input.project_name ? s.projects.find((p) => p.name === input.project_name) : null;
    const nextNo = Math.max(0, ...s.todos.map((t) => t.no || 0)) + 1;
    const channel = (input.channel || '').trim();
    if (channel && !s.channels.includes(channel)) s.channels.push(channel);
    const t = {
      id: uid(), no: nextNo, registeredDate: kstToday(),
      projectId: proj ? proj.id : ((s.projects[0] && s.projects[0].id) || 'default'),
      channel, priority: input.priority || '', text: input.text, assignee: input.assignee || '',
      dueDate: input.due_date || '', status: '대기', needsCheck: '', completedDate: '', progress: '', remarks: '', links: [], done: false
    };
    s.todos.push(t);
    return { changed: true, result: { 추가됨: '할일', 내용: t.text, 마감: t.dueDate || '없음', 대분류: proj ? proj.name : '' } };
  }
  if (name === 'complete_todo') {
    const q = (input.text_contains || '').toLowerCase();
    const cand = s.todos.filter((t) => !isDone(t) && (t.text || '').toLowerCase().includes(q));
    if (!cand.length) return { changed: false, result: { 오류: '일치하는 미완료 할 일을 찾지 못했어요' } };
    if (cand.length > 1) return { changed: false, result: { 여러개: cand.slice(0, 5).map((t) => t.text), 안내: '더 구체적으로 지정해 주세요' } };
    const t = cand[0]; t.status = '완료'; t.done = true; if (!t.completedDate) t.completedDate = kstToday();
    return { changed: true, result: { 완료처리: t.text } };
  }
  if (name === 'update_todo') {
    const q = (input.text_contains || '').toLowerCase();
    const cand = s.todos.filter((t) => (t.text || '').toLowerCase().includes(q));
    if (!cand.length) return { changed: false, result: { 오류: '일치하는 할 일을 찾지 못했어요' } };
    if (cand.length > 1) return { changed: false, result: { 여러개: cand.slice(0, 5).map((t) => t.text), 안내: '더 구체적으로 지정해 주세요' } };
    const t = cand[0]; const chg = {};
    if (input.new_status) { t.status = input.new_status; t.done = isDone(t); if (t.done && !t.completedDate) t.completedDate = kstToday(); chg.상태 = input.new_status; }
    if (input.new_due_date) { t.dueDate = input.new_due_date; chg.마감 = input.new_due_date; }
    if (input.new_priority) { t.priority = input.new_priority; chg.우선순위 = input.new_priority; }
    if (input.progress_note) { t.progress = (t.progress ? t.progress + '\n' : '') + input.progress_note; chg.진행 = input.progress_note; }
    return { changed: Object.keys(chg).length > 0, result: { 수정됨: t.text, 변경: chg } };
  }
  if (name === 'delete_todo') {
    const q = (input.text_contains || '').toLowerCase();
    const cand = s.todos.filter((t) => (t.text || '').toLowerCase().includes(q));
    if (!cand.length) return { changed: false, result: { 오류: '일치하는 할 일을 찾지 못했어요' } };
    if (cand.length > 1) return { changed: false, result: { 여러개: cand.slice(0, 5).map((t) => t.text), 안내: '더 구체적으로 지정해 주세요' } };
    const t = cand[0]; s.todos = s.todos.filter((x) => x.id !== t.id);
    // 첨부(R2 객체)도 함께 지운다. 안 지우면 접근 불가한 고아 객체로 남는다.
    const keys = (Array.isArray(t.files) ? t.files : []).map((f) => f && f.key).filter(Boolean);
    return { changed: true, deleteFiles: keys, result: { 삭제됨: t.text, 첨부삭제: keys.length || undefined } };
  }
  if (name === 'weekly_report') {
    const off = input.week_offset || 0;
    const today = kstToday();
    const d = new Date(today + 'T00:00:00Z'); const dow = (d.getUTCDay() + 6) % 7;
    const mon = new Date(d); mon.setUTCDate(d.getUTCDate() - dow + off * 7);
    const sun = new Date(mon); sun.setUTCDate(mon.getUTCDate() + 6);
    const nmon = new Date(mon); nmon.setUTCDate(mon.getUTCDate() + 7);
    const nsun = new Date(nmon); nsun.setUTCDate(nmon.getUTCDate() + 6);
    const fmt = (x) => x.toISOString().slice(0, 10);
    const ws = fmt(mon), we = fmt(sun), ns = fmt(nmon), ne = fmt(nsun);
    const tag = (t) => { const p = (s.projects.find((x) => x.id === t.projectId) || {}).name; return [p, t.channel].filter(Boolean).join('/'); };
    const done = s.todos.filter((t) => isDone(t) && t.completedDate >= ws && t.completedDate <= we).map((t) => ({ 업무: t.text, 분류: tag(t), 완료: t.completedDate }));
    const next = s.todos.filter((t) => !isDone(t) && t.dueDate >= ns && t.dueDate <= ne).map((t) => ({ 업무: t.text, 분류: tag(t), 마감: t.dueDate, 상태: t.status }));
    const overdue = s.todos.filter((t) => !isDone(t) && t.dueDate && t.dueDate < today).map((t) => ({ 업무: t.text, 분류: tag(t), 마감: t.dueDate }));
    return { changed: false, result: { 이번주: ws + '~' + we, 이번주완료: done, 다음주예정: next, 지연: overdue } };
  }
  if (name === 'monthly_report') {
    const today = kstToday();
    const tm = monthRangeK(today, input.month_offset || 0);
    const nm = monthRangeK(today, (input.month_offset || 0) + 1);
    const tag = (t) => { const p = (s.projects.find((x) => x.id === t.projectId) || {}).name; return [p, t.channel].filter(Boolean).join('/'); };
    const done = s.todos.filter((t) => isDone(t) && t.completedDate >= tm.start && t.completedDate <= tm.end)
      .map((t) => ({ 업무: t.text, 분류: tag(t), 완료: t.completedDate }));
    const open = s.todos.filter((t) => !isDone(t) && t.dueDate >= tm.start && t.dueDate <= tm.end)
      .map((t) => ({ 업무: t.text, 분류: tag(t), 마감: t.dueDate, 상태: t.status, 지연: t.dueDate < today }));
    const next = s.todos.filter((t) => !isDone(t) && t.dueDate >= nm.start && t.dueDate <= nm.end)
      .map((t) => ({ 업무: t.text, 분류: tag(t), 마감: t.dueDate }));
    const byProj = {};
    s.projects.forEach((p) => {
      const d = done.filter((x) => (x.분류 || '').startsWith(p.name)).length;
      const o = open.filter((x) => (x.분류 || '').startsWith(p.name)).length;
      if (d || o) byProj[p.name] = { 완료: d, 미완료: o };
    });
    return { changed: false, result: { 기간: tm.start + '~' + tm.end, 이번달완료: done, 이번달미완료: open, 다음달예정: next, 대분류별: byProj } };
  }
  if (name === 'search_todos') {
    const found = filterTodos(s, input);
    const limit = Math.min(Math.max(1, input.limit || 20), 50);
    return {
      changed: false,
      result: {
        총건수: found.length,
        보여준건수: Math.min(found.length, limit),
        목록: found.slice(0, limit).map((t) => todoBrief(s, t)),
        안내: found.length > limit ? `조건에 맞는 ${found.length}건 중 ${limit}건만 반환했다. 건수만 필요하면 count_todos를 쓸 것.` : undefined
      }
    };
  }
  if (name === 'count_todos') {
    const found = filterTodos(s, input);
    const out = { 건수: found.length };
    if (input.group_by) {
      const key = (t) => {
        switch (input.group_by) {
          case 'project': return (s.projects.find((p) => p.id === t.projectId) || {}).name || '(없음)';
          case 'channel': return t.channel || '(없음)';
          case 'status': return t.status || (t.done ? '완료' : '대기');
          case 'priority': return t.priority || '(없음)';
          case 'assignee': return t.assignee || '(없음)';
          case 'due_month': return (t.dueDate || '').slice(0, 7) || '(마감일 없음)';
          case 'completed_month': return (t.completedDate || '').slice(0, 7) || '(완료일 없음)';
          default: return '(전체)';
        }
      };
      const g = {};
      found.forEach((t) => { const k = key(t); g[k] = (g[k] || 0) + 1; });
      out.분류별 = Object.fromEntries(Object.entries(g).sort((a, b) => b[1] - a[1]));
    }
    return { changed: false, result: out };
  }
  if (name === 'work_stats') {
    const today = kstToday();
    const days = (from, to) => Math.round((new Date(to + 'T00:00:00Z') - new Date(from + 'T00:00:00Z')) / 864e5);
    const done = s.todos.filter(isDone);
    const lead = done.filter((t) => t.registeredDate && t.completedDate && t.completedDate >= t.registeredDate)
      .map((t) => days(t.registeredDate, t.completedDate));
    const withDue = done.filter((t) => t.dueDate && t.completedDate);
    const onTime = withDue.filter((t) => t.completedDate <= t.dueDate).length;
    const thisMonth = monthRangeK(today, 0).label, prevMonth = monthRangeK(today, -1).label;
    const overdue = s.todos.filter((t) => !isDone(t) && t.dueDate && t.dueDate < today);
    const missingCompleted = done.filter((t) => !t.completedDate).length;
    const missingDue = s.todos.filter((t) => !isDone(t) && !t.dueDate).length;
    return {
      changed: false,
      result: {
        평균완료소요일: lead.length ? +(lead.reduce((a, b) => a + b, 0) / lead.length).toFixed(1) : null,
        기한준수율: withDue.length ? Math.round(onTime / withDue.length * 100) : null,
        기한준수_기준건수: withDue.length,
        이번달완료: done.filter((t) => (t.completedDate || '').slice(0, 7) === thisMonth).length,
        전월완료: done.filter((t) => (t.completedDate || '').slice(0, 7) === prevMonth).length,
        지연건수: overdue.length,
        평균지연일: overdue.length ? +(overdue.reduce((a, t) => a + days(t.dueDate, today), 0) / overdue.length).toFixed(1) : null,
        미완료전체: s.todos.filter((t) => !isDone(t)).length,
        데이터누락: { 완료일없는완료: missingCompleted, 마감일없는미완료: missingDue }
      }
    };
  }
  return { changed: false, result: { 오류: 'unknown_tool' } };
}

function systemPrompt(s) {
  const today = kstToday();
  const dow = ['일', '월', '화', '수', '목', '금', '토'][new Date(today + 'T00:00:00+09:00').getUTCDay()];
  const projects = s.projects.map((p) => p.name).join(', ') || '(없음)';
  const channels = (s.channels || []).slice(0, 40).join(', ') || '(없음)';
  return [
    '너는 "SCLM" 일정 관리 앱의 한국어 AI 비서다. 사용자의 자연어 요청을 이해해 함수(도구)로 일정·할 일을 조회하거나 등록한다.',
    `오늘은 ${today} (${dow}요일), 한국 시간(KST) 기준이다. "내일"="${addDays(today, 1)}", "다음 주"는 다음 주 월~일.`,
    `대분류(프로젝트) 목록: ${projects}`,
    `세부채널 목록: ${channels}`,
    '규칙:',
    '- 미팅/일정을 "잡아줘"라고 하면 먼저 find_free_slots로 빈 시간을 확인하고, 적절한 시간을 골라 add_event로 등록한 뒤 결과를 알려준다. 시간을 특정하지 않았으면 지정 시간대의 첫 빈 슬롯을 기본으로 잡되, 어떤 시간에 잡았는지 명확히 말한다.',
    '- "뭐 있어/일정 알려줘"류는 list_schedule로 조회 후 간결히 요약한다.',
    '- 할 일 추가는 add_todo, 완료는 complete_todo, 수정(미루기/상태변경/우선순위)은 update_todo, 삭제는 delete_todo.',
    '- 여러 건을 한 번에 추가/처리하라고 하면 해당 함수를 여러 번 병렬 호출한다.',
    '- "주간보고/이번 주 한 일 정리" 요청은 weekly_report로, "월간보고/이번 달 정리"는 monthly_report로 데이터를 받아 보기 좋은 불릿 형식으로 정리해준다.',
    '- 도구 고르는 법: 날짜 구간의 예정 확인 = list_schedule / 조건(채널·대분류·담당자·키워드·상태)으로 찾기 = search_todos / **숫자만 필요하면 count_todos**(예: "몇 건 남았어?") / 처리 속도·지연 정도 = work_stats.',
    '- "몇 건"을 물으면 목록을 다 나열하지 말고 count_todos의 숫자로 답한다. 분류별 비교를 원하면 group_by를 쓴다.',
    '- 집계 결과를 말할 때는 조건을 함께 밝힌다(예: "이번 달 마감 기준, 정산 미완료 4건"). 완료 포함 여부가 애매하면 미완료 기준으로 답하고 그 사실을 덧붙인다.',
    '- work_stats의 데이터누락(완료일/마감일 빈 건)이 있으면, 지표가 실제와 다를 수 있다고 한 줄 알려준다.',
    '- "뭐부터 할까/우선순위" 질문엔 list_schedule로 지연·오늘·임박을 확인해 지연·긴급 우선으로 짧게 추천한다.',
    '- 날짜·시간은 반드시 함수 인자로 YYYY-MM-DD, HH:MM(24h)로 변환해 넘긴다.',
    '- 답변은 짧고 명확한 한국어로. 실행한 내용(추가/완료/시간)을 한 줄로 확인해준다. 정보가 정말 애매할 때만 한 가지만 되묻는다.',
    '- 도구로 확인되지 않은 내용을 지어내지 않는다.'
  ].join('\n');
}

async function callGemini(env, body) {
  const r = await fetch(API(env.GEMINI_API_KEY), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  const j = await r.json();
  if (!r.ok) throw new Error('gemini ' + r.status + ': ' + (j.error && j.error.message || JSON.stringify(j)).slice(0, 200));
  return j;
}

export async function onRequestPost(context) {
  const { env } = context;
  if (!authed(context)) return unauthorized();
  if (!env.GEMINI_API_KEY) return Response.json({ error: 'no_api_key', reply: '⚠ AI 비서가 아직 설정되지 않았어요 (GEMINI_API_KEY 필요).' }, { status: 200 });

  let payload = {};
  try { payload = await context.request.json(); } catch (e) {}
  const userMsg = (payload.message || '').toString().slice(0, 2000);
  if (!userMsg) return Response.json({ error: 'empty' }, { status: 400 });
  const history = Array.isArray(payload.history) ? payload.history.slice(-8) : [];

  const s = await loadState(env);
  let changed = false;

  // Gemini contents: role user/model, parts [{text}] | [{functionCall}] | [{functionResponse}]
  const contents = history
    .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: String(m.content || '').slice(0, 2000) }] }))
    .filter((c) => c.parts[0].text);
  contents.push({ role: 'user', parts: [{ text: userMsg }] });

  const base = {
    systemInstruction: { parts: [{ text: systemPrompt(s) }] },
    tools: [{ functionDeclarations: FUNCTIONS }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 1024 }
  };

  let reply = '';
  try {
    for (let iter = 0; iter < 6; iter++) {
      const resp = await callGemini(env, { ...base, contents });
      const cand = resp.candidates && resp.candidates[0];
      const parts = (cand && cand.content && cand.content.parts) || [];
      contents.push({ role: 'model', parts });
      const calls = parts.filter((p) => p.functionCall);
      const texts = parts.filter((p) => p.text).map((p) => p.text).join('\n').trim();
      if (texts) reply = texts;
      if (!calls.length) break;
      const responseParts = [];
      for (const c of calls) {
        const out = runTool(c.functionCall.name, c.functionCall.args || {}, s);
        if (out.changed) changed = true;
        // 삭제된 할 일의 첨부는 R2에서도 정리(실패해도 진행)
        if (out.deleteFiles && out.deleteFiles.length && env.FILES) {
          for (const k of out.deleteFiles) { try { await env.FILES.delete(k); } catch (e) {} }
        }
        responseParts.push({ functionResponse: { name: c.functionCall.name, response: out.result } });
      }
      contents.push({ role: 'user', parts: responseParts });
    }
  } catch (e) {
    return Response.json({ reply: '⚠ 비서 처리 중 오류: ' + String(e.message || e).slice(0, 160) }, { status: 200 });
  }

  if (changed) await saveState(env, s);
  return Response.json({ reply: reply || '(응답 없음)', changed });
}
