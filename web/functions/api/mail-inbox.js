// /api/mail-inbox — 메일을 전달하면 할 일이 만들어진다.
//
// 왜 — 업무는 대부분 메일로 들어오는데, 그걸 앱에 옮겨 적는 건 순전히 손품이다.
// 아웃룩에서 전달 한 번이면 제목·본문·첨부가 그대로 할 일이 된다.
//
// 흐름:  아웃룩에서 전달
//        → Cloudflare Email Routing (도메인 필요)
//        → Email Worker (web/email-inbox, MIME 파싱만)
//        → 여기 (판단·저장 전부)
//
// ⚠️ **MIME 파싱은 워커에, 업무 규칙은 여기에.** 워커는 도메인이 없으면 띄울 수도 없어서
//    테스트가 안 된다. 규칙을 여기 두면 하네스에서 전부 검증할 수 있다.
//
// 인증은 `X-Cron-Secret`(push-cron 워커와 같은 방식) + **발신자 확인**.
// 메일 주소는 세상 누구나 보낼 수 있으므로 둘 다 필요하다:
//   · 주소를 알아도 시크릿이 없으면 이 엔드포인트를 직접 못 부른다
//   · 워커를 거쳐 와도 허용된 발신자가 아니면 거절한다
import { safeEqual } from './_auth.js';

const MAX_FILES = 5;
const MAX_BYTES = 25 * 1024 * 1024;      // 첨부 1개 상한 — /api/files 와 같은 값
const LOG_MAX = 300;

const todayKST = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/* ---------- 제목 다듬기 ---------- */

/* 전달·회신 접두사를 걷어낸다. 아웃룩에서 전달하면 "FW: RE: 원제목"처럼 여러 겹이 붙는다.
   ⚠️ 반복해서 벗겨야 한다 — 한 번만 벗기면 "FW: RE: x" 가 "RE: x" 로 남는다. */
export function cleanSubject(raw) {
  let s = String(raw || '').replace(/\s+/g, ' ').trim();
  const PREFIX = /^\s*(FW|FWD|RE|답장|회신|전달|참조)\s*:\s*/i;
  for (let i = 0; i < 8 && PREFIX.test(s); i++) s = s.replace(PREFIX, '');
  // 아웃룩 한국어판이 붙이는 대괄호 표기도 함께 (예: "[전달] 제목")
  s = s.replace(/^\s*\[\s*(FW|FWD|RE|전달|회신)\s*\]\s*/i, '');
  return s.trim();
}

/* 제목에 섞어 쓰는 지시어를 뽑아낸다. 전달할 때 제목만 조금 고치면 분류까지 지정된다.
     #쿠팡      중분류(거래처)
     !중요      우선순위
     ~8/10      마감일 (~2026-08-10 도 됨)
   ⚠️ **지시어가 없어도 제대로 동작해야 한다.** 매번 제목을 고쳐야 하면 안 쓰게 된다. */
export function parseDirectives(subject, todayIso) {
  const today = todayIso || todayKST();
  let channel = '', priority = '', dueDate = '';

  let s = String(subject || '');
  s = s.replace(/(^|\s)#([^\s#!~]+)/g, (m, sp, v) => { if (!channel) channel = v; return sp; });
  s = s.replace(/(^|\s)!([^\s#!~]+)/g, (m, sp, v) => { if (!priority) priority = v; return sp; });
  s = s.replace(/(^|\s)~([0-9./-]+)/g, (m, sp, v) => { if (!dueDate) dueDate = v; return sp; });

  return {
    text: s.replace(/\s+/g, ' ').trim(),
    channel: channel.trim(),
    priority: normPriority(priority),
    dueDate: normDate(dueDate, today),
  };
}

/* 우선순위는 앱과 같은 세 값으로만 정규화한다(src/app.js 의 규칙과 같아야 한다). */
export function normPriority(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  if (/긴급|urgent|critical|매우|최우선/i.test(s)) return '긴급';
  if (/중요|high|important/i.test(s)) return '중요';
  if (/보통|normal|low|낮/i.test(s)) return '보통';
  return '';
}

/* 8/10 · 08-10 · 2026-08-10 · 2026/8/10 을 모두 받는다.
   연도가 없으면 올해로 보되, **이미 지난 날짜면 내년**으로 본다
   (12월에 "~1/5"라고 적으면 다음 달을 뜻하는 게 자연스럽다). */
export function normDate(v, todayIso) {
  const s = String(v || '').trim();
  if (!s) return '';
  const today = todayIso || todayKST();
  const p2 = (n) => String(n).padStart(2, '0');

  let m = s.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/);
  if (m) return m[1] + '-' + p2(m[2]) + '-' + p2(m[3]);

  m = s.match(/^(\d{1,2})[./-](\d{1,2})$/);
  if (!m) return '';
  const year = +today.slice(0, 4);
  const guess = year + '-' + p2(m[1]) + '-' + p2(m[2]);
  if (!isValidIso(guess)) return '';
  return guess >= today ? guess : (year + 1) + '-' + p2(m[1]) + '-' + p2(m[2]);
}

function isValidIso(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const d = new Date(iso + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === iso;
}

/* ---------- 본문 ---------- */

/* 본문에서 로그로 남길 한 덩어리를 뽑는다.
   전달 메일은 아래에 원문 헤더와 인용문이 통째로 딸려 오므로, **거기서 자른다** —
   안 자르면 로그 한 줄에 남의 메일 서명까지 들어가 목록이 못 읽게 된다. */
export function bodyToLog(text) {
  let s = String(text || '').replace(/\r\n/g, '\n');

  // 전달 원문 구분선 (아웃룩 한국어/영어판, 지메일)
  const CUT = [
    /\n-{2,}\s*(원본 메시지|Original Message|전달된 메시지)/i,
    /\n_{5,}/,
    /\n보낸 사람\s*:/,
    /\nFrom\s*:\s*.+\nSent\s*:/i,
    /\n\d{4}년 \d{1,2}월 \d{1,2}일.*작성:/,
    /\nOn .+ wrote:/i,
  ];
  for (const re of CUT) {
    const m = s.match(re);
    if (m && m.index > 0) s = s.slice(0, m.index);
  }

  s = s.split('\n').map((l) => l.trim()).filter((l) => l && !/^>/.test(l)).join(' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > LOG_MAX ? s.slice(0, LOG_MAX - 1) + '…' : s;
}

/* ---------- 발신자 ---------- */

/* "김성철 <a@b.com>" → "a@b.com" */
export function addressOf(from) {
  const s = String(from || '').trim();
  const m = s.match(/<([^>]+)>/);
  return (m ? m[1] : s).trim().toLowerCase();
}

/* 허용 발신자인지. MAIL_ALLOW_FROM(쉼표 구분)이 있으면 그것을, 없으면 MAIL_TO 를 쓴다.
   ⚠️ 둘 다 없으면 **아무도 통과시키지 않는다** — 설정을 깜빡한 채 열려 있는 것보다
      아무것도 안 되는 편이 낫다. 메일 주소는 세상 누구나 보낼 수 있다. */
export function senderAllowed(env, from) {
  const raw = (env && (env.MAIL_ALLOW_FROM || env.MAIL_TO)) || '';
  const list = String(raw).split(',').map((x) => addressOf(x)).filter(Boolean);
  if (!list.length) return false;
  const got = addressOf(from);
  return !!got && list.indexOf(got) > -1;
}

/* ---------- 저장 ---------- */

async function loadState(env) {
  const row = await env.DB.prepare("SELECT data FROM documents WHERE id = 'main'").first();
  let s = {}; try { s = JSON.parse(row.data); } catch (e) {}
  ['todos', 'events', 'projects', 'channels', 'subMaster'].forEach((k) => {
    if (!Array.isArray(s[k])) s[k] = [];
  });
  return s;
}

/* base64 → Uint8Array (워커가 첨부를 base64 로 실어 보낸다) */
function fromB64(b64) {
  const bin = atob(String(b64 || ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const safeName = (n) =>
  String(n || 'file').replace(/[\r\n"\\]/g, '').replace(/[/\\]/g, '_').slice(0, 120) || 'file';

/* 첨부를 R2 에 담는다. 키 형식은 /api/files 와 **똑같아야 한다** —
   앱의 다운로드·삭제가 그 형식을 검사한다(validKey). */
export async function storeAttachments(env, list) {
  const out = [];
  if (!env.FILES) return out;
  for (const a of (Array.isArray(list) ? list : []).slice(0, MAX_FILES)) {
    if (!a || !a.content) continue;
    let bytes;
    try { bytes = fromB64(a.content); } catch (e) { continue; }
    if (!bytes.length || bytes.length > MAX_BYTES) continue;
    const name = safeName(a.filename);
    const ext = (name.match(/\.([A-Za-z0-9]{1,8})$/) || [])[1] || '';
    const key = Date.now().toString(36) + '/' + Math.random().toString(36).slice(2, 10) + (ext ? '.' + ext : '');
    await env.FILES.put(key, bytes, {
      httpMetadata: { contentType: a.mimeType || 'application/octet-stream' },
      customMetadata: { name },
    });
    out.push({ key, name, size: bytes.length, url: '/api/files/' + key });
  }
  return out;
}

/* 메일 한 통 → 할 일 하나 (순수 함수). */
export function buildTodo(mail, state, todayIso) {
  const today = todayIso || todayKST();
  const d = parseDirectives(cleanSubject(mail.subject), today);
  const nos = state.todos.map((t) => +t.no || 0);
  const text = d.text || '(제목 없는 메일)';

  return {
    id: uid(),
    no: (nos.length ? Math.max.apply(null, nos) : 0) + 1,
    registeredDate: today,
    projectId: null,                 // 대분류는 사람이 정한다 — 메일만 보고 맞히면 오히려 정리가 어긋난다
    channel: d.channel,
    subChannel: '',
    priority: d.priority,
    text,
    assignee: '',
    dueDate: d.dueDate,              // 없으면 빈 값. 임의로 채우면 거짓 마감일이 생긴다
    status: '대기',
    needsCheck: '',
    completedDate: '',
    progress: '',
    remarks: '',
    links: [],
    done: false,
    fromMail: addressOf(mail.from),  // 어디서 왔는지 남긴다
    logs: [],
  };
}

/* ---------- 엔드포인트 ---------- */

export async function onRequestPost(context) {
  const { env, request } = context;

  const secret = env.CRON_SECRET;
  const got = request.headers.get('X-Cron-Secret') || '';
  if (!secret || !got || !safeEqual(got, secret)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  let mail = {};
  try { mail = await request.json(); } catch (e) {
    return Response.json({ error: 'bad_json' }, { status: 400 });
  }

  if (!senderAllowed(env, mail.from)) {
    // 누가 보냈는지는 남기되 내용은 버린다
    return Response.json({ ok: true, skipped: 'sender_not_allowed', from: addressOf(mail.from) });
  }

  const state = await loadState(env);
  const today = todayKST();
  const todo = buildTodo(mail, state, today);

  const log = bodyToLog(mail.text);
  if (log) todo.logs.push({ at: today, text: log });

  let files = [];
  try { files = await storeAttachments(env, mail.attachments); }
  catch (e) { files = []; }
  if (files.length) todo.files = files;

  // 중분류가 새 값이면 목록에도 등록한다(앱의 분류 필터에 바로 뜨도록)
  if (todo.channel && state.channels.indexOf(todo.channel) === -1) state.channels.push(todo.channel);

  state.todos.push(todo);
  await env.DB
    .prepare("INSERT INTO documents (id, data, updated_at) VALUES ('main', ?1, ?2) ON CONFLICT(id) DO UPDATE SET data = ?1, updated_at = ?2")
    .bind(JSON.stringify(state), Date.now())
    .run();

  // 등록됐는지 모르면 못 믿고 결국 앱에 다시 적게 된다 → 확인 메일 한 통.
  // 실패해도 등록은 이미 끝났으므로 응답을 막지 않는다.
  let notified = { skipped: 'not_configured' };
  try {
    const { sendInboxReceipt } = await import('./push/_mail.js');
    notified = await sendInboxReceipt(env, todo, files);
  } catch (e) {
    notified = { ok: false, error: String((e && e.message) || e).slice(0, 200) };
  }

  return Response.json({
    ok: true, id: todo.id, no: todo.no, text: todo.text,
    channel: todo.channel, priority: todo.priority, dueDate: todo.dueDate,
    files: files.length, notified,
  });
}
