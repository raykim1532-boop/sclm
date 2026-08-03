// 아침 크론이 하루 1회 백업을 남기는지 — snapshots 테이블까지 흉내내는 전용 DB 모의로 본다.
// ⚠️ 공용 mockDB 는 snapshots 를 모른다(INSERT 를 무시한다). 그걸로 테스트하면
//    백업이 안 생겨도 통과해 버린다. 2026-08-03 전수조사에서 백업이 3일간 안 돌던 걸
//    발견해 서버 쪽으로 옮겼으므로, 여기서는 실제로 행이 쌓이는지 확인한다.
import { check, section } from './_helpers.mjs';
import { API, mockRequest, mockFetch } from './_helpers.mjs';

const { onRequestPost } = await import(API + 'push/run-daily.js');

const TODAY = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const DUE_TODAY = { id: 'a', no: 1, text: '오늘 마감', dueDate: TODAY, status: '대기' };

/* documents + snapshots 를 함께 들고 있는 DB 모의 */
function makeDB(docs, snaps) {
  return {
    prepare(q) {
      return {
        _b: null,
        bind(...a) { this._b = a; return this; },
        async first() {
          if (/FROM snapshots/.test(q)) {
            const sorted = snaps.slice().sort((x, y) => y.created_at - x.created_at);
            return sorted[0] || null;
          }
          const m = q.match(/id = '(\w+)'/);
          return m && docs[m[1]] ? { data: docs[m[1]], updated_at: 0 } : null;
        },
        async all() { return { results: [] }; },
        async run() {
          if (/INSERT INTO snapshots/.test(q)) {
            snaps.push({ id: this._b[0], created_at: this._b[1], reason: this._b[2], summary: this._b[3], data: this._b[4] });
            return {};
          }
          if (/DELETE FROM snapshots/.test(q)) return {};
          const m = q.match(/VALUES \('(\w+)'/);
          if (m) docs[m[1]] = this._b[0];
          return {};
        },
      };
    },
  };
}

const ctx = (docs, snaps, headers) => ({
  env: { APP_PASSWORD: 'pw', CRON_SECRET: 'CRONSEC', DB: makeDB(docs, snaps) },
  request: mockRequest(headers),
});
const CRON = { 'X-Cron-Secret': 'CRONSEC' };

section('아침 브리핑을 보내면서 백업도 남긴다');
{
  const docs = { main: JSON.stringify({ todos: [DUE_TODAY], events: [], projects: [] }) };
  const snaps = [];
  mockFetch([]);
  const r = await onRequestPost(ctx(docs, snaps, CRON));
  const b = await r.json();

  check('알림은 발송된다', b.ok === true && !b.skipped);
  check('백업이 1건 생겼다', snaps.length === 1, snaps.length + '건');
  check('사유가 daily-cron', snaps[0].reason === 'daily-cron');
  check('응답에 백업 결과가 실린다', b.backup && b.backup.ok === true);
  check('백업 내용이 현재 main', JSON.parse(snaps[0].data).todos.length === 1);
}

section('같은 날 두 번 불려도 백업은 하나 (08:10 재시도)');
{
  const docs = { main: JSON.stringify({ todos: [DUE_TODAY], events: [], projects: [] }) };
  const snaps = [];
  mockFetch([]);
  await onRequestPost(ctx(docs, snaps, CRON));           // 08:00
  const r2 = await onRequestPost(ctx(docs, snaps, CRON)); // 08:10
  const b2 = await r2.json();

  check('두 번째는 발송을 건너뛴다', b2.skipped === 'already_sent_today');
  check('백업은 여전히 1건', snaps.length === 1, snaps.length + '건');
  check('건너뛴 응답에도 백업 결과가 실린다', b2.backup && b2.backup.skipped === true);
}

section('알릴 게 없는 날에도 백업은 남는다');
{
  // 지연·오늘·임박·일정 모두 0 → nothing_due 로 조기 반환하지만 백업은 이미 끝났어야 한다
  const docs = { main: JSON.stringify({ todos: [], events: [], projects: [] }) };
  const snaps = [];
  mockFetch([]);
  const r = await onRequestPost(ctx(docs, snaps, CRON));
  const b = await r.json();

  check('발송은 건너뛴다', b.skipped === 'nothing_due');
  check('그래도 백업은 생긴다', snaps.length === 1, snaps.length + '건');
}

section('날이 바뀌면 다시 남는다');
{
  const docs = { main: JSON.stringify({ todos: [DUE_TODAY], events: [], projects: [] }) };
  // 어제 백업이 하나 있는 상태
  const snaps = [{ id: 'old', created_at: Date.now() - 26 * 3600e3, reason: 'daily-cron', summary: '', data: '{}' }];
  mockFetch([]);
  await onRequestPost(ctx(docs, snaps, CRON));
  check('오늘치가 새로 생긴다', snaps.length === 2, snaps.length + '건');
  check('가장 최근이 오늘 것', snaps[1].created_at > snaps[0].created_at);
}

section('백업이 실패해도 알림은 나간다');
{
  // snapshots 조회가 터지는 DB
  const docs = { main: JSON.stringify({ todos: [DUE_TODAY], events: [], projects: [] }) };
  const brokenDB = {
    prepare(q) {
      return {
        bind() { return this; },
        async first() {
          if (/FROM snapshots/.test(q)) throw new Error('D1 오류');
          const m = q.match(/id = '(\w+)'/);
          return m && docs[m[1]] ? { data: docs[m[1]], updated_at: 0 } : null;
        },
        async all() { return { results: [] }; },
        async run() { return {}; },
      };
    },
  };
  mockFetch([]);
  const r = await onRequestPost({
    env: { APP_PASSWORD: 'pw', CRON_SECRET: 'CRONSEC', DB: brokenDB },
    request: mockRequest(CRON),
  });
  const b = await r.json();
  check('알림은 정상 발송', b.ok === true && !b.skipped);
  check('백업 실패가 응답에 남는다', b.backup && b.backup.ok === false && !!b.backup.error);
}
