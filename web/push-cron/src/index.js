// 매일 정해진 시각에 Pages 엔드포인트들을 호출한다.
//  1) /api/google/sync     — 구글 캘린더 동기화 (먼저!)
//  2) /api/push/run-daily  — 웹푸시/카카오 아침 브리핑
// ⚠️ 순서가 중요하다: 브리핑이 오늘 일정을 읽으므로 캘린더를 먼저 맞춰야 한다.
//    반대로 두면 어제 동기화분을 보고 브리핑이 나간다. 동기화가 실패해도
//    브리핑은 반드시 나가야 하므로 try/catch 로 끊어 둔다.
// 요청을 나누는 이유: Cloudflare 서브리퀘스트 한도(요청당 50)를 각각 따로 쓰기 위해서.
// fetch 핸들러는 ?key=<CRON_SECRET> 로 수동 트리거(테스트)할 때만 실행.

function calendarUrl(env) {
  if (env.CAL_URL) return env.CAL_URL;
  return String(env.TARGET_URL || '').replace('/api/push/run-daily', '/api/google/sync');
}

// source: 어느 스케줄러가 불렀는지 서버(D1 'daily' 문서)에 기록되게 한다.
// GitHub Actions와 병행 운영 중이라, 이 워커의 크론이 실제로 발사되는지 확인하는 유일한 근거다.
async function post(url, env, source) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'X-Cron-Secret': env.CRON_SECRET || '', 'X-Cron-Source': source || 'cf-cron' }
  });
  const text = await r.text();
  try { return JSON.parse(text); } catch (e) { return { status: r.status, body: text.slice(0, 200) }; }
}

async function run(env, source) {
  // 1) 캘린더 먼저 — 브리핑이 오늘 일정을 읽기 때문.
  //    한 번에 처리 못 하면(truncated) 이어서 최대 3회까지 호출.
  const calUrl = calendarUrl(env);
  const calendar = [];
  if (calUrl) {
    try {
      for (let i = 0; i < 3; i++) {
        const res = await post(calUrl, env, source);
        calendar.push(res);
        if (!res || !res.truncated) break;
      }
    } catch (e) {
      // 캘린더가 죽어도 브리핑은 나가야 한다(일정 없이라도)
      calendar.push({ error: String((e && e.message) || e).slice(0, 200) });
    }
  }
  console.log('calendar sync done:', JSON.stringify(calendar).slice(0, 200));

  // 2) 브리핑
  console.log('calling run-daily:', env.TARGET_URL, 'source=', source);
  const daily = await post(env.TARGET_URL, env, source);
  console.log('run-daily result:', JSON.stringify(daily).slice(0, 300));

  return JSON.stringify({ calendar, daily });
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(env, 'cf-cron'));
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (env.CRON_SECRET && url.searchParams.get('key') === env.CRON_SECRET) {
      const body = await run(env, 'cf-manual');
      return new Response(body, { headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('sclm-push-cron ok');
  }
};
