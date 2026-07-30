// Password 관리자 목록 — 실제 DOM 에서 버튼을 눌러 본다.
// 삭제는 되돌릴 수 없고 복사 버튼 바로 옆이라, 배선이 어긋나면 바로 사고가 된다.
import { check, section } from './_helpers.mjs';
import { bootApp, $, $$, click, tick } from './_dom.mjs';

const V = (o) => Object.assign({ id: 'v1', site: 'GitHub', url: 'https://github.com', user: 'ray@x.com', pass: 'pw', category: '', memo: '', updatedAt: Date.now() }, o);

/* vaultSave() 가 실제로 암호화하므로 진짜 키·솔트를 넣어 준다(잠금 해제된 상태 재현) */
async function boot(entries, opts) {
  const env = bootApp(opts);
  env.app.setState({ projects: [], todos: [], events: [], channels: [], subMaster: [], settings: {} });
  env.app.setVaultKey(await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']));
  env.app.setVaultSalt(crypto.getRandomValues(new Uint8Array(16)));
  env.app.setVaultEntries(entries);
  env.app.renderVaultList();
  return env;
}
/* 정렬(사이트명 가나다순)에 기대지 않고 이름으로 행을 찾는다 */
const rowOf = (doc, site) => $$(doc, '.vault-item').find((r) => $(r, '.vi-site').textContent.includes(site));

section('목록 렌더');
{
  const env = await boot([V({}), V({ id: 'v2', site: '사방넷', user: '', pass: '', url: '' })]);
  check('2줄이 그려진다', $$(env.document, '.vault-item').length === 2);
  check('개수 표시', $(env.document, '#vaultCount').textContent === '2개');

  const full = rowOf(env.document, 'GitHub');
  const empty = rowOf(env.document, '사방넷');
  check('값이 있으면 아이디·비번 버튼이 있다', $$(full, '[data-act="user"]').length === 1 && $$(full, '[data-act="pass"]').length === 1);
  check('값이 없으면 버튼도 없다', $$(empty, '[data-act="user"]').length === 0 && $$(empty, '[data-act="pass"]').length === 0);
  check('삭제 버튼은 항상 있다', $$(env.document, '[data-act="del"]').length === 2);
  check('삭제가 맨 끝', $$(full, '.vi-actions button').pop().dataset.act === 'del');
}

section('삭제 — 확인을 누르면 지워지고 저장된다');
{
  let asked = '';
  const env = await boot([V({}), V({ id: 'v2', site: '사방넷' })], { confirm: (m) => { asked = m; return true; } });
  click($(rowOf(env.document, 'GitHub'), '[data-act="del"]'));
  await tick(40);

  check('확인 문구에 계정 이름이 들어간다', asked.includes('GitHub'), asked.split('\n')[0]);
  check('되돌릴 수 없다고 알린다', asked.includes('되돌릴 수 없어요'));
  check('1건만 지워진다', env.app.getVaultEntries().length === 1);
  check('남은 것이 맞다', env.app.getVaultEntries()[0].site === '사방넷');
  check('목록도 다시 그려진다', $$(env.document, '.vault-item').length === 1);
  check('암호화해서 저장까지 갔다', env.saves.length === 1 && !!env.saves[0].vault.ct);
}

section('삭제 — 취소하면 아무 일도 없다');
{
  const env = await boot([V({})], { confirm: () => false });
  click($(env.document, '.vault-item [data-act="del"]'));
  await tick(40);
  check('그대로 있다', env.app.getVaultEntries().length === 1);
  check('저장도 안 한다', env.saves.length === 0);
}

section('삭제 버튼이 편집 화면을 열지 않는다');
{
  // ⚠️ 행 전체를 누르면 편집이 열린다. 삭제는 stopPropagation 으로 막혀 있어야 한다.
  const env = await boot([V({})], { confirm: () => true });
  const row = $(env.document, '.vault-item');
  let rowClicked = 0;
  row.addEventListener('click', () => { rowClicked++; });

  click($(row, '[data-act="del"]'));
  await tick(40);
  check('행 클릭(편집 열기)이 일어나지 않는다', rowClicked === 0);
  check('삭제는 됐다', env.app.getVaultEntries().length === 0);
}

section('검색 — 깨진 가져오기를 찾아내는 방법');
{
  // 2026-07-30 CSV 탭 버그 점검에 실제로 쓴 방법: 사이트명에 쉼표가 있으면 깨진 것.
  const env = await boot([V({}), V({ id: 'v2', site: 'A,https://a.com,u1,p1,' })]);
  $(env.document, '#vaultSearch').value = ',';
  env.app.renderVaultList();
  check('쉼표 검색으로 깨진 항목만 걸린다', $$(env.document, '.vault-item').length === 1);
  check('걸린 것이 그 항목', $(env.document, '.vault-item .vi-site').textContent.includes('A,https'));
}
