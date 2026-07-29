// /api/data — 전체 상태(JSON) 저장/조회. Bearer 토큰(=APP_PASSWORD)으로 보호.
// 데이터는 D1의 documents 테이블 단일 행(id='main')에 통째로 보관한다(단일 사용자).
//
// ⚠️ 저장은 통짜 덮어쓰기라 마지막에 저장한 쪽이 무조건 이긴다. 오래된 탭이 저장하면
// 그 사이 다른 기기에서 한 작업이 통째로 날아간다(실제 사고 있었음).
// 그래서 PUT은 클라이언트가 마지막으로 읽은 버전(updated_at)을 함께 보내고,
// 서버 버전이 더 새로우면 409로 거절한다. 덮어쓰려면 force:true 를 명시해야 한다.

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
    .prepare("SELECT data, updated_at FROM documents WHERE id = 'main'")
    .first();
  let data = null;
  if (row && row.data) {
    try { data = JSON.parse(row.data); } catch (e) { data = null; }
  }
  // version = 이 응답의 시점. 저장할 때 그대로 돌려보내면 충돌을 감지할 수 있다.
  return Response.json({ data, version: (row && row.updated_at) || 0 });
}

export async function onRequestPut(context) {
  if (!authed(context)) return unauthorized();
  let raw = await context.request.text();
  let incoming;
  try { incoming = JSON.parse(raw); } catch (e) {
    return new Response(JSON.stringify({ error: 'invalid json' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    });
  }

  // 버전 검사: baseVersion이 있으면 서버의 현재 버전과 같을 때만 저장한다.
  // (force:true 면 사용자가 '내 것으로 덮어쓰기'를 고른 것이므로 그대로 진행)
  const cur0 = await context.env.DB
    .prepare("SELECT data, updated_at FROM documents WHERE id = 'main'")
    .first();
  const serverVersion = (cur0 && cur0.updated_at) || 0;
  const base = Number(incoming.baseVersion);
  const force = incoming.force === true;
  delete incoming.baseVersion;   // 상태 문서에 남기지 않는다
  delete incoming.force;
  if (!force && base && serverVersion && base !== serverVersion) {
    let serverData = null;
    if (cur0 && cur0.data) { try { serverData = JSON.parse(cur0.data); } catch (e) {} }
    return Response.json(
      { error: 'conflict', serverVersion, yourVersion: base, data: serverData },
      { status: 409 }
    );
  }
  raw = JSON.stringify(incoming);   // baseVersion/force를 뺀 본문으로 다시 만든다

  // 금고(vault) 보호: 저장 요청에 vault가 없으면 기존 암호문을 유지한다.
  // (금고 생성 전에 열어둔 오래된 탭이 저장하면 암호문이 지워져 복구 불가해지는 것을 막음)
  // 의도적으로 지울 때는 vault:null 을 명시해서 보낸다.
  let body = raw;
  if (!('vault' in incoming)) {
    let prevVault;
    if (cur0 && cur0.data) {
      try { prevVault = JSON.parse(cur0.data).vault; } catch (e) {}
    }
    if (prevVault) {
      incoming.vault = prevVault;
      body = JSON.stringify(incoming);
    }
  } else if (incoming.vault === null) {
    delete incoming.vault; // 명시적 삭제
    body = JSON.stringify(incoming);
  }

  const now = Date.now();
  await context.env.DB
    .prepare(
      "INSERT INTO documents (id, data, updated_at) VALUES ('main', ?1, ?2) " +
      "ON CONFLICT(id) DO UPDATE SET data = ?1, updated_at = ?2"
    )
    .bind(body, now)
    .run();
  return Response.json({ ok: true, version: now });
}
