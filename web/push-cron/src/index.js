// 매일 정해진 시각에 Pages의 run-daily 엔드포인트를 호출한다.
// fetch 핸들러는 ?key=<CRON_SECRET> 로 수동 트리거(테스트)할 때만 실행.
async function run(env) {
  const r = await fetch(env.TARGET_URL, {
    method: 'POST',
    headers: { 'X-Cron-Secret': env.CRON_SECRET || '' }
  });
  return await r.text();
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(env));
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (env.CRON_SECRET && url.searchParams.get('key') === env.CRON_SECRET) {
      const body = await run(env);
      return new Response(body, { headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('sclm-push-cron ok');
  }
};
