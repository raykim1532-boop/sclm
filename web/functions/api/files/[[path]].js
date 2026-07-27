// /api/files/... — 할 일 산출물 파일 첨부(R2).
//   POST   /api/files            : 업로드(multipart form-data, field=file) → { key, name, size, url }
//   GET    /api/files/<key>      : 다운로드(첨부 스트리밍)
//   DELETE /api/files/<key>      : 삭제
// 앱 비밀번호(Bearer) 보호. GET은 브라우저 직접 링크를 위해 ?t=<APP_PASSWORD> 쿼리도 허용.
import { authed, unauthorized, safeEqual } from '../_auth.js';

const MAX_BYTES = 25 * 1024 * 1024; // 25MB

function keyFromPath(context) {
  const parts = context.params && context.params.path;
  const raw = Array.isArray(parts) ? parts.join('/') : (parts || '');
  return raw ? decodeURIComponent(raw) : '';
}
// 업로드 키는 서버가 생성하므로 경로 조작 여지는 없지만, 방어적으로 형식을 강제한다.
function validKey(k) { return /^[0-9a-z]+\/[0-9a-z]+(\.[A-Za-z0-9]{1,8})?$/.test(k); }

function safeName(n) {
  return String(n || 'file').replace(/[\r\n"\\]/g, '').replace(/[/\\]/g, '_').slice(0, 120) || 'file';
}

export async function onRequestPost(context) {
  const { env } = context;
  if (!authed(context)) return unauthorized();
  if (!env.FILES) return Response.json({ error: 'r2_not_bound' }, { status: 500 });

  const ct = context.request.headers.get('content-type') || '';
  if (!ct.includes('multipart/form-data')) return Response.json({ error: 'expect_multipart' }, { status: 400 });

  const form = await context.request.formData();
  const file = form.get('file');
  if (!file || typeof file === 'string') return Response.json({ error: 'no_file' }, { status: 400 });
  if (file.size > MAX_BYTES) return Response.json({ error: 'too_large', max_mb: MAX_BYTES / 1048576 }, { status: 413 });

  const name = safeName(file.name);
  const ext = (name.match(/\.([A-Za-z0-9]{1,8})$/) || [])[1] || '';
  const key = Date.now().toString(36) + '/' + Math.random().toString(36).slice(2, 10) + (ext ? '.' + ext : '');

  await env.FILES.put(key, file.stream(), {
    httpMetadata: { contentType: file.type || 'application/octet-stream' },
    customMetadata: { name }
  });

  return Response.json({ ok: true, key, name, size: file.size, url: '/api/files/' + key });
}

export async function onRequestGet(context) {
  const { env, request } = context;
  // 브라우저에서 직접 열 수 있도록 토큰 쿼리도 허용(헤더를 못 붙이는 <a href> 케이스)
  const url = new URL(request.url);
  const qt = url.searchParams.get('t') || '';
  const okQuery = !!env.APP_PASSWORD && !!qt && safeEqual(qt, env.APP_PASSWORD);
  if (!authed(context) && !okQuery) return unauthorized();
  if (!env.FILES) return Response.json({ error: 'r2_not_bound' }, { status: 500 });

  const key = keyFromPath(context);
  if (!validKey(key)) return Response.json({ error: 'bad_key' }, { status: 400 });

  const obj = await env.FILES.get(key);
  if (!obj) return Response.json({ error: 'not_found' }, { status: 404 });

  const name = (obj.customMetadata && obj.customMetadata.name) || 'file';
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  headers.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  headers.set('Cache-Control', 'private, max-age=3600');
  return new Response(obj.body, { headers });
}

export async function onRequestDelete(context) {
  const { env } = context;
  if (!authed(context)) return unauthorized();
  if (!env.FILES) return Response.json({ error: 'r2_not_bound' }, { status: 500 });
  const key = keyFromPath(context);
  if (!validKey(key)) return Response.json({ error: 'bad_key' }, { status: 400 });
  await env.FILES.delete(key);
  return Response.json({ ok: true });
}
