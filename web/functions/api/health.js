// GET /api/health — 프런트가 "클라우드 모드" 여부를 판별하는 핑
export function onRequestGet() {
  return Response.json({ cloud: true, ts: Date.now() });
}
