// 테스트 공용 헬퍼 — 외부 의존성 없이 D1/fetch를 모의한다.
// 실행: npm test (web/tests/run.mjs)

export const API = new URL('../functions/api/', import.meta.url).href;

let passed = 0;
let failed = 0;
const failures = [];

export function check(name, cond) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; failures.push(name); console.log('  ✗ FAIL ' + name); }
}
export function section(title) { console.log('\n— ' + title); }
export function results() { return { passed, failed, failures }; }

// D1 모의: documents 테이블(id → JSON 문자열)만 흉내낸다.
// docs 객체를 그대로 들고 있으므로 테스트에서 저장 결과를 바로 확인할 수 있다.
// versions: 문서별 updated_at(=저장 버전). 저장 충돌 감지 테스트에서 쓴다.
export function mockDB(docs, versions = {}) {
  return {
    prepare(q) {
      return {
        _b: null,
        bind(...a) { this._b = a; return this; },
        async first() {
          const m = q.match(/id = '(\w+)'/);
          return m && docs[m[1]] ? { data: docs[m[1]], updated_at: versions[m[1]] || 0 } : null;
        },
        async all() { return { results: [] }; },
        async run() {
          const m = q.match(/VALUES \('(\w+)'/);
          if (m) { docs[m[1]] = this._b[0]; versions[m[1]] = this._b[1]; }
          return {};
        },
      };
    },
  };
}

// 요청 모의. url 은 쿼리스트링을 읽는 엔드포인트(mail-action 등)에서만 쓴다.
export function mockRequest(headers = {}, bodyObj, url) {
  return {
    url: url || 'https://sclm.pages.dev/api/',
    headers: { get: (k) => headers[k] || '' },
    async text() { return JSON.stringify(bodyObj ?? {}); },
    async json() { return bodyObj ?? {}; },
  };
}

// fetch 모의: [{ match: '문자열', reply: obj|fn, status }] 순서대로 첫 매치 사용
export function mockFetch(routes) {
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    url = String(url);
    calls.push({ method: opts.method || 'GET', url, opts });
    for (const r of routes) {
      if (url.includes(r.match) && (!r.method || r.method === (opts.method || 'GET'))) {
        const status = r.status || 200;
        const payload = typeof r.reply === 'function' ? r.reply(url, opts) : r.reply;
        return {
          ok: status < 300,
          status,
          async json() { return payload; },
          async text() { return JSON.stringify(payload); },
        };
      }
    }
    return { ok: false, status: 404, async json() { return {}; }, async text() { return '{}'; } };
  };
  return calls;
}

// 구글 토큰 발급은 대부분의 테스트에서 공통
export const GOOGLE_TOKEN_ROUTE = { match: 'oauth2.googleapis.com/token', reply: { access_token: 'AT', expires_in: 3600 } };
