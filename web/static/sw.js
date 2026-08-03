// SCLM 서비스 워커 — 웹푸시 수신/클릭 + 오프라인 캐싱.
//
// 캐시 전략
//   - 문서(내비게이션): 네트워크 우선 → 실패 시 캐시된 '/' (배포 직후에도 항상 최신을 먼저 시도)
//   - 정적 자산(아이콘/매니페스트 등): 캐시 우선 + 백그라운드 갱신
//   - GET /api/data : 네트워크 우선 + 성공 응답 캐싱 → 오프라인이면 마지막 응답 반환
//   - GET /api/health: 오프라인이면 {cloud:true,offline:true} 를 합성해 반환
//                      (앱이 로컬 모드로 떨어져 별도 저장소를 쓰는 걸 막는다)
//   - 그 외 /api/*  및 모든 비-GET 요청: 손대지 않음(네트워크 전용)
const VERSION = 'v2';
const SHELL_CACHE = 'sclm-shell-' + VERSION;
const DATA_CACHE = 'sclm-data'; // 버전과 무관하게 유지 — 앱 업데이트로 오프라인 데이터를 잃지 않도록
const SHELL = ['/', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/icon-180.png'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // 일부 자산이 실패해도 설치는 진행되도록 개별 처리
    await Promise.all(SHELL.map(async (u) => {
      try { await cache.put(u, await fetch(new Request(u, { cache: 'reload' }))); } catch (e) {}
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k.startsWith('sclm-') && k !== SHELL_CACHE && k !== DATA_CACHE)
          .map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

/* ---------- 캐시 핸들러 ---------- */

// 문서: 네트워크 우선(최신 배포 반영), 실패하면 캐시된 앱 셸
//
// ⚠️ **앱 셸이 아닌 문서를 '/' 로 캐시하지 말 것.** /api/mail-action 처럼 HTML 을 돌려주는
//    엔드포인트도 링크로 열면 내비게이션이라, 예전엔 그 확인 화면이 앱 셸 자리를 덮어썼다.
//    그러면 오프라인에서 앱을 열었을 때 앱 대신 그 페이지가 뜬다(2026-08-03 발견).
//    같은 이유로 오프라인 폴백도 앱 셸이 아닌 주소에는 주지 않는다 — 눌러 봐야
//    엉뚱한 화면이고, 서버에 닿아야만 되는 동작이라 캐시로 흉내낼 수도 없다.
async function handleNavigate(req) {
  const cache = await caches.open(SHELL_CACHE);
  let isShell = true;
  try { isShell = !new URL(req.url).pathname.startsWith('/api/'); } catch (e) {}
  try {
    const res = await fetch(req);
    if (isShell && res && res.ok) cache.put('/', res.clone());
    return res;
  } catch (e) {
    if (!isShell) {
      return new Response('오프라인입니다. 네트워크에 연결된 뒤 다시 눌러 주세요.', {
        status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      });
    }
    return (await cache.match('/')) || new Response('오프라인입니다.', {
      status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}

// 정적 자산: 캐시 우선 + 백그라운드 갱신
async function handleAsset(req) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(req);
  const net = fetch(req)
    .then((res) => { if (res && res.ok) cache.put(req, res.clone()); return res; })
    .catch(() => null);
  if (hit) return hit;
  return (await net) || new Response('', { status: 504 });
}

// GET /api/data: 네트워크 우선 + 캐싱, 오프라인이면 마지막 성공 응답
async function handleData(req) {
  const cache = await caches.open(DATA_CACHE);
  try {
    const res = await fetch(req);
    if (res && res.status === 200) cache.put('/api/data', res.clone());
    return res;
  } catch (e) {
    const hit = await cache.match('/api/data');
    if (!hit) throw e; // 캐시도 없으면 앱의 localStorage 폴백으로 넘긴다
    const headers = new Headers(hit.headers);
    headers.set('X-SCLM-Offline', '1');
    return new Response(hit.body, { status: 200, statusText: 'OK (offline cache)', headers });
  }
}

// GET /api/health: 오프라인이면 클라우드 모드를 유지시킨다.
// 단, 이 기기에 캐시된 데이터가 있을 때만 — 캐시가 없으면 클라우드라고 우겨봐야
// 보여줄 게 없고, 앱이 로그인 게이트에서 멈춰버린다.
async function handleHealth(req) {
  try { return await fetch(req); }
  catch (e) {
    const cache = await caches.open(DATA_CACHE);
    const hit = await cache.match('/api/data');
    if (!hit) throw e; // 앱의 detect()가 false → 로컬 모드로 폴백
    return new Response(JSON.stringify({ cloud: true, offline: true }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;                    // 저장/업로드 등 쓰기 요청은 개입 금지
  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;     // 구글 API 등 외부 요청은 통과

  if (req.mode === 'navigate') { event.respondWith(handleNavigate(req)); return; }
  if (url.pathname === '/api/health') { event.respondWith(handleHealth(req)); return; }
  if (url.pathname === '/api/data') { event.respondWith(handleData(req)); return; }
  if (url.pathname.startsWith('/api/')) return;        // 첨부 다운로드 등은 네트워크 전용

  event.respondWith(handleAsset(req));
});

/* ---------- 웹푸시 ---------- */

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch (e) { data = { title: 'SCLM', body: event.data ? event.data.text() : '' }; }
  const title = data.title || 'SCLM';
  const options = {
    body: data.body || '',
    tag: data.tag || 'sclm',
    renotify: true,
    data: { url: data.url || '/' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if ('focus' in c) { try { await c.navigate(url); } catch (e) {} return c.focus(); }
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});
