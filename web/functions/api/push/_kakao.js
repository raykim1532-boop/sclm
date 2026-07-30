// 카카오톡 '나에게 보내기'(메모) 발송 모듈.
// 텍스트 템플릿은 1건당 200자 제한이라, 할 일이 많으면 자동으로 여러 건으로 분할 발송한다.
// 필요한 시크릿(Pages sclm): KAKAO_REST_API_KEY, KAKAO_REFRESH_TOKEN (선택: KAKAO_CLIENT_SECRET)
const TOKEN_URL = 'https://kauth.kakao.com/oauth/token';
const MEMO_URL = 'https://kapi.kakao.com/v2/api/talk/memo/default/send';
const APP_URL = 'https://sclm.pages.dev';
const MSG_LIMIT = 200; // 텍스트 템플릿 text 최대 길이

// REST 키만 확인(동기). refresh_token은 D1(회전분) 또는 시크릿에 있을 수 있어
// 실제 존재 여부는 getAccessToken이 판단하고, 없으면 kakao_no_refresh_token 으로 실패한다.
export function kakaoConfigured(env) {
  return !!env.KAKAO_REST_API_KEY;
}

// 카카오 상태(회전된 refresh_token 등)는 D1 documents id='kakao' 한 행에 보관한다.
// 시크릿(env)은 최초 부트스트랩용이고, 이후에는 D1의 값이 우선한다.
export async function readKakaoDoc(env) {
  try {
    const row = await env.DB.prepare("SELECT data FROM documents WHERE id = 'kakao'").first();
    if (row && row.data) return JSON.parse(row.data);
  } catch (e) {}
  return {};
}
export async function writeKakaoDoc(env, obj) {
  await env.DB
    .prepare("INSERT INTO documents (id, data, updated_at) VALUES ('kakao', ?1, ?2) ON CONFLICT(id) DO UPDATE SET data = ?1, updated_at = ?2")
    .bind(JSON.stringify(obj), Date.now())
    .run();
}

// refresh_token 으로 access_token 재발급.
// 카카오는 refresh_token 만료가 가까우면 새 refresh_token을 함께 준다 → 반드시 저장해야 알림이 끊기지 않는다.
export async function getAccessToken(env) {
  const doc = await readKakaoDoc(env);
  const refresh = doc.refresh_token || env.KAKAO_REFRESH_TOKEN;
  if (!refresh) throw new Error('kakao_no_refresh_token');

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: env.KAKAO_REST_API_KEY,
    refresh_token: refresh,
  });
  if (env.KAKAO_CLIENT_SECRET) body.set('client_secret', env.KAKAO_CLIENT_SECRET);
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body: body.toString(),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    doc.lastError = ('(' + r.status + ') ' + JSON.stringify(j)).slice(0, 200);
    doc.lastErrorAt = Date.now();
    try { await writeKakaoDoc(env, doc); } catch (e) {}
    throw new Error('kakao_token_refresh_failed' + doc.lastError);
  }
  // 회전된 refresh_token 저장(+ 성공 기록). 실패해도 발송은 계속 진행.
  const next = { ...doc, lastOkAt: Date.now() };
  delete next.lastError; delete next.lastErrorAt;
  if (j.refresh_token && j.refresh_token !== doc.refresh_token) next.refresh_token = j.refresh_token;
  else if (!doc.refresh_token) next.refresh_token = refresh; // 최초 1회 D1로 승격
  try { await writeKakaoDoc(env, next); } catch (e) {}
  return j; // { access_token, expires_in, [refresh_token], ... }
}

// 텍스트 템플릿 1건 발송(≤200자).
async function sendMemoText(accessToken, text, linkUrl = APP_URL) {
  const template = {
    object_type: 'text',
    text: String(text || '').slice(0, MSG_LIMIT),
    link: { web_url: linkUrl, mobile_web_url: linkUrl },
    button_title: '앱 열기',
  };
  const body = new URLSearchParams({ template_object: JSON.stringify(template) });
  const r = await fetch(MEMO_URL, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + accessToken,
      'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
    },
    body: body.toString(),
  });
  const t = await r.text();
  return { ok: r.ok, status: r.status, body: t.slice(0, 200) };
}

// 여러 메시지를 access token 한 번으로 순차 발송(분할 발송).
export async function sendKakaoMessages(env, messages) {
  const list = (Array.isArray(messages) ? messages : [messages]).filter(Boolean);
  const tok = await getAccessToken(env);
  const results = [];
  for (let i = 0; i < list.length; i++) {
    results.push(await sendMemoText(tok.access_token, list[i]));
    if (i < list.length - 1) await new Promise((r) => setTimeout(r, 250)); // 연속 발송 간 짧은 간격
  }
  const sent = results.filter((r) => r.ok).length;
  return { ok: sent === list.length && sent > 0, sent, total: list.length, results };
}

// ---- 메시지 구성 (computeSummary 결과 → 분할된 메시지 배열) ----
function stripTag(s) {
  return String(s || '').replace(/^\s*\[[^\]]*\]\s*/, '').trim();
}
function shortTitle(t, n = 30) {
  const s = stripTag(t.text);
  return s.length > n ? s.slice(0, n) + '…' : s;
}
function mmdd(iso) {
  return iso ? iso.slice(5).replace('-', '/') : '';
}

// 한 줄에 한 항목: 카테고리 헤더 + 항목들
function summaryLines(s) {
  const lines = [];
  const add = (label, list, withDate) => {
    if (!list || !list.length) return;
    lines.push(`${label} ${list.length}`);
    for (const t of list) lines.push('· ' + shortTitle(t) + (withDate ? ` (${mmdd(t.dueDate)})` : ''));
  };
  add('⏰지연', s.overdueList, false);
  add('📅오늘', s.todayList, false);
  add('🔜임박', s.upcomingList, true);
  // 일정은 할 일과 성격이 다르므로(마감이 아니라 시각) 맨 아래 따로 둔다
  const ev = s.eventList || [];
  if (ev.length) {
    lines.push(`🗓일정 ${ev.length}`);
    for (const e of ev) lines.push('· ' + eventTime(e) + ' ' + shortTitle({ text: e.title }));
  }
  return lines;
}

// 시간이 지정된 일정은 HH:MM, 아니면 '종일'
function eventTime(e) {
  return e && e.allDay === false && e.startTime ? String(e.startTime).slice(0, 5) : '종일';
}

// 줄 단위로 ≤max 청크로 묶어 여러 메시지로. 2건 이상이면 제목에 (k/N) 표기.
function chunkMessages(title, lines, max = MSG_LIMIT) {
  if (!lines.length) return [title];
  const reserve = title.length + 8; // 제목 + " (k/N)" + 줄바꿈 여유
  const bodyMax = Math.max(40, max - reserve);
  const groups = [];
  let cur = [];
  let len = 0;
  for (const ln of lines) {
    const add = ln.length + 1; // +\n
    if (len + add > bodyMax && cur.length) {
      groups.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(ln);
    len += add;
  }
  if (cur.length) groups.push(cur);
  const n = groups.length;
  return groups.map((g, i) => {
    const head = n > 1 ? `${title} (${i + 1}/${n})` : title;
    return [head, ...g].join('\n').slice(0, max);
  });
}

// computeSummary 결과 → 발송할 메시지 배열(길면 자동 분할).
export function buildKakaoMessages(s) {
  // 일정이 있는 날엔 제목도 그렇게 말해 준다(내용과 제목이 어긋나지 않게)
  const what = (s.eventList || []).length ? '할 일·일정' : '할 일';
  const title = `📌 SCLM ${what} (${mmdd(s.today)})`;
  return chunkMessages(title, summaryLines(s));
}
