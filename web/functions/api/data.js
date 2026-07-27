// /api/data — 전체 상태(JSON) 저장/조회. Bearer 토큰(=APP_PASSWORD)으로 보호.
// 데이터는 D1의 documents 테이블 단일 행(id='main')에 통째로 보관한다(단일 사용자).

function getToken(request) {
  const h = request.headers.get('Authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

// 길이 정보 노출을 줄인 상수시간 비교
function safeEqual(a, b) {
  a = String(a || '');
  b = String(b || '');
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authed(context) {
  const expected = context.env.APP_PASSWORD;
  const got = getToken(context.request);
  return !!expected && !!got && safeEqual(got, expected);
}

const unauthorized = () =>
  new Response(JSON.stringify({ error: 'unauthorized' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' }
  });

export async function onRequestGet(context) {
  if (!authed(context)) return unauthorized();
  const row = await context.env.DB
    .prepare("SELECT data FROM documents WHERE id = 'main'")
    .first();
  let data = null;
  if (row && row.data) {
    try { data = JSON.parse(row.data); } catch (e) { data = null; }
  }
  return Response.json({ data });
}

export async function onRequestPut(context) {
  if (!authed(context)) return unauthorized();
  const raw = await context.request.text();
  let incoming;
  try { incoming = JSON.parse(raw); } catch (e) {
    return new Response(JSON.stringify({ error: 'invalid json' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    });
  }

  // 금고(vault) 보호: 저장 요청에 vault가 없으면 기존 암호문을 유지한다.
  // (금고 생성 전에 열어둔 오래된 탭이 저장하면 암호문이 지워져 복구 불가해지는 것을 막음)
  // 의도적으로 지울 때는 vault:null 을 명시해서 보낸다.
  let body = raw;
  if (!('vault' in incoming)) {
    const cur = await context.env.DB.prepare("SELECT data FROM documents WHERE id = 'main'").first();
    let prevVault;
    if (cur && cur.data) {
      try { prevVault = JSON.parse(cur.data).vault; } catch (e) {}
    }
    if (prevVault) {
      incoming.vault = prevVault;
      body = JSON.stringify(incoming);
    }
  } else if (incoming.vault === null) {
    delete incoming.vault; // 명시적 삭제
    body = JSON.stringify(incoming);
  }

  await context.env.DB
    .prepare(
      "INSERT INTO documents (id, data, updated_at) VALUES ('main', ?1, ?2) " +
      "ON CONFLICT(id) DO UPDATE SET data = ?1, updated_at = ?2"
    )
    .bind(body, Date.now())
    .run();
  return Response.json({ ok: true });
}
