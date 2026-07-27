// /api/assistant — 자연어 일정 비서. Claude(opus-5) tool-use로 D1의 todos/events를 조회·생성.
// 앱 비밀번호(Bearer) 보호. ANTHROPIC_API_KEY(secret) 필요.
import { authed, unauthorized } from './_auth.js';

const MODEL = 'claude-opus-5';
const API = 'https://api.anthropic.com/v1/messages';

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

// ---- 도구 정의 ----
const TOOLS = [
  {
    name: 'list_schedule',
    description: '지정한 기간의 할 일과 일정을 조회한다. "내일 뭐 있어?", "이번 주 마감" 같은 질문에 사용.',
    input_schema: {
      type: 'object',
      properties: {
        date_from: { type: 'string', description: '시작일 YYYY-MM-DD (포함)' },
        date_to: { type: 'string', description: '종료일 YYYY-MM-DD (포함)' },
        include_done: { type: 'boolean', description: '완료 항목 포함 여부(기본 false)' }
      },
      required: ['date_from', 'date_to']
    }
  },
  {
    name: 'find_free_slots',
    description: '특정 날짜에 시간이 지정된 일정 사이의 빈 시간대를 찾는다. 미팅을 잡기 전에 먼저 호출.',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: '날짜 YYYY-MM-DD' },
        part_of_day: { type: 'string', enum: ['morning', 'afternoon', 'evening', 'day'], description: '오전(09-12)/오후(13-18)/저녁(18-21)/하루(09-18)' },
        duration_minutes: { type: 'number', description: '필요한 시간(분), 기본 60' }
      },
      required: ['date']
    }
  },
  {
    name: 'add_event',
    description: '캘린더에 일정(미팅 등)을 추가한다.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        date: { type: 'string', description: '날짜 YYYY-MM-DD' },
        start_time: { type: 'string', description: '시작 HH:MM (24h). 생략 시 종일 일정' },
        end_time: { type: 'string', description: '종료 HH:MM (선택)' },
        notes: { type: 'string' }
      },
      required: ['title', 'date']
    }
  },
  {
    name: 'add_todo',
    description: '할 일(업무)을 추가한다.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '업무 내용' },
        due_date: { type: 'string', description: '마감일 YYYY-MM-DD (선택)' },
        priority: { type: 'string', enum: ['긴급', '중요', '보통'], description: '선택' },
        project_name: { type: 'string', description: '대분류 이름 (선택, 기존 목록에서)' },
        channel: { type: 'string', description: '세부채널 (선택)' },
        assignee: { type: 'string', description: '담당자 (선택)' }
      },
      required: ['text']
    }
  },
  {
    name: 'complete_todo',
    description: '내용이 일치하는 미완료 할 일을 완료 처리한다.',
    input_schema: {
      type: 'object',
      properties: { text_contains: { type: 'string', description: '완료할 할 일 내용(부분 일치)' } },
      required: ['text_contains']
    }
  }
];

// ---- 도구 실행 ----
function runTool(name, input, s) {
  const today = kstToday();
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
  return { changed: false, result: { 오류: 'unknown_tool' } };
}

function systemPrompt(s) {
  const today = kstToday();
  const dow = ['일', '월', '화', '수', '목', '금', '토'][new Date(today + 'T00:00:00+09:00').getUTCDay()];
  const projects = s.projects.map((p) => p.name).join(', ') || '(없음)';
  const channels = (s.channels || []).slice(0, 40).join(', ') || '(없음)';
  return [
    '너는 "SCLM" 일정 관리 앱의 한국어 AI 비서다. 사용자의 자연어 요청을 이해해 도구로 일정·할 일을 조회하거나 등록한다.',
    `오늘은 ${today} (${dow}요일), 한국 시간(KST) 기준이다. "내일"="${addDays(today, 1)}", "다음 주"는 다음 주 월~일.`,
    `대분류(프로젝트) 목록: ${projects}`,
    `세부채널 목록: ${channels}`,
    '규칙:',
    '- 미팅/일정을 "잡아줘"라고 하면 먼저 find_free_slots로 빈 시간을 확인하고, 적절한 시간을 골라 add_event로 등록한 뒤 결과를 알려준다. 시간을 특정하지 않았으면 오후 첫 빈 슬롯을 기본으로 잡되, 어떤 시간에 잡았는지 명확히 말한다.',
    '- "뭐 있어/일정 알려줘"류는 list_schedule로 조회 후 간결히 요약한다.',
    '- 할 일 추가는 add_todo, 완료 처리는 complete_todo.',
    '- 날짜·시간은 반드시 도구 인자로 YYYY-MM-DD, HH:MM(24h)로 변환해 넘긴다.',
    '- 답변은 짧고 명확한 한국어로. 실행한 내용(추가/완료/시간)을 한 줄로 확인해준다. 정보가 정말 애매할 때만 한 가지만 되묻는다.',
    '- 도구로 확인되지 않은 내용을 지어내지 않는다.'
  ].join('\n');
}

async function callClaude(env, body) {
  const r = await fetch(API, {
    method: 'POST',
    headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const j = await r.json();
  if (!r.ok) throw new Error('claude ' + r.status + ': ' + JSON.stringify(j).slice(0, 200));
  return j;
}

export async function onRequestPost(context) {
  const { env } = context;
  if (!authed(context)) return unauthorized();
  if (!env.ANTHROPIC_API_KEY) return Response.json({ error: 'no_api_key', reply: '⚠ AI 비서가 아직 설정되지 않았어요 (ANTHROPIC_API_KEY 필요).' }, { status: 200 });

  let payload = {};
  try { payload = await context.request.json(); } catch (e) {}
  const userMsg = (payload.message || '').toString().slice(0, 2000);
  if (!userMsg) return Response.json({ error: 'empty' }, { status: 400 });
  const history = Array.isArray(payload.history) ? payload.history.slice(-8) : [];

  const s = await loadState(env);
  let changed = false;

  const messages = [...history.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '').slice(0, 2000) })), { role: 'user', content: userMsg }];

  const base = {
    model: MODEL,
    max_tokens: 4096,
    output_config: { effort: 'low' },
    system: systemPrompt(s),
    tools: TOOLS
  };

  let reply = '';
  try {
    for (let iter = 0; iter < 6; iter++) {
      const resp = await callClaude(env, { ...base, messages });
      messages.push({ role: 'assistant', content: resp.content });
      const toolUses = (resp.content || []).filter((b) => b.type === 'tool_use');
      const texts = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      if (texts) reply = texts;
      if (resp.stop_reason !== 'tool_use' || !toolUses.length) break;
      const results = [];
      for (const tu of toolUses) {
        const out = runTool(tu.name, tu.input || {}, s);
        if (out.changed) changed = true;
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(out.result) });
      }
      messages.push({ role: 'user', content: results });
    }
  } catch (e) {
    return Response.json({ reply: '⚠ 비서 처리 중 오류: ' + String(e.message || e).slice(0, 160) }, { status: 200 });
  }

  if (changed) await saveState(env, s);
  return Response.json({ reply: reply || '(응답 없음)', changed });
}
