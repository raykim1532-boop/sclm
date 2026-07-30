// Password 관리자 CSV 가져오기 — src/app.js 에서 파서를 추출해 검증한다.
// 회귀 방지: 구분자를 파일 전체에서 찾던 탓에, 메모나 비밀번호에 탭이 하나만 섞여도
// 쉼표 CSV를 통째로 TSV로 읽어 모든 행이 한 칸으로 뭉개졌다(비밀번호가 조용히 사라짐).
import { readFileSync } from 'node:fs';
import { check, section } from './_helpers.mjs';

const src = readFileSync(new URL('../../src/app.js', import.meta.url), 'utf8');
const grab = (re, name) => { const m = src.match(re); if (!m) throw new Error('함수 추출 실패: ' + name); return m[0]; };
const { parseDelimitedTable, vaultCsvRowsToEntries } = new Function([
  grab(/function parseDelimitedTable\([\s\S]*?\r?\n}/, 'parseDelimitedTable'),
  grab(/function normHeaderKey\([^\r\n]*/, 'normHeaderKey'),
  grab(/const VAULT_CSV_HEADER_MAP = \{[\s\S]*?\r?\n\};/, 'VAULT_CSV_HEADER_MAP'),
  grab(/function vaultCsvRowsToEntries\([\s\S]*?\r?\n}/, 'vaultCsvRowsToEntries'),
  'return { parseDelimitedTable, vaultCsvRowsToEntries };'
].join('\n'))();

const imp = (t) => vaultCsvRowsToEntries(parseDelimitedTable(t));
const CHROME = 'name,url,username,password,note\n';

section('크롬·구글 비밀번호 내보내기 형식');
{
  const e = imp(CHROME
    + 'GitHub,https://github.com,ray@x.com,pw-aaa,\n'
    + 'Cloudflare,https://dash.cloudflare.com,ray@x.com,pw-bbb,업무용\n');
  check('2건', e.length === 2);
  check('name→site', e[0].site === 'GitHub');
  check('url', e[0].url === 'https://github.com');
  check('username→user', e[0].user === 'ray@x.com');
  check('password→pass', e[0].pass === 'pw-aaa');
  check('note→memo', e[1].memo === '업무용');
}

section('값에 탭이 섞여도 쉼표 CSV로 읽는다');
{
  // ⚠️ 이 절이 깨지면 가져오기가 조용히 전부 망가진다. 구분자는 머리글 줄만 보고 정해야 한다.
  const cases = [
    ['메모에 탭', CHROME + 'A,https://a.com,u1,p1,"메\t모"\n'],
    ['비밀번호에 탭', CHROME + 'A,https://a.com,u1,"p\t1",\n'],
    ['뒷줄에만 탭', CHROME + 'A,https://a.com,u1,p1,\nB,,u2,p2,"x\ty"\n']
  ];
  for (const [label, csv] of cases) {
    const e = imp(csv);
    check(label + ' — 아이디가 살아 있다', e[0] && e[0].user === 'u1');
    check(label + ' — 비밀번호가 살아 있다', !!(e[0] && e[0].pass && e[0].pass.indexOf('p') === 0));
  }
}

section('구글시트 붙여넣기(TSV)는 그대로 동작');
{
  const rows = parseDelimitedTable('머리1\t머리2\t머리3\nA\tB\tC\n');
  check('탭 구분 유지', rows.length === 2 && rows[1].length === 3 && rows[1][1] === 'B');

  // 머리글에 탭과 쉼표가 함께 있으면 탭을 택한다(시트 붙여넣기 쪽 우선)
  const mixed = parseDelimitedTable('"가,나"\t다\nA\tB\n');
  check('머리글에 쉼표가 껴 있어도 탭 우선', mixed[1].length === 2 && mixed[1][0] === 'A');
}

section('BOM·따옴표·쉼표·줄바꿈');
{
  const bom = imp('﻿' + CHROME + 'A,https://a.com,u1,p1,\n');
  check('BOM 붙은 파일도 머리글 인식', bom.length === 1 && bom[0].user === 'u1');

  const e = imp(CHROME
    + '"회사, 주식회사",https://x.com,u,"pw,with,comma","여러 줄\n메모"\n'
    + 'B,https://b.com,u2,"큰따옴표 ""있음""",\n');
  check('쉼표 든 이름', e[0].site === '회사, 주식회사');
  check('쉼표 든 비밀번호', e[0].pass === 'pw,with,comma');
  check('줄바꿈 든 메모', e[0].memo === '여러 줄\n메모');
  check('이스케이프된 따옴표', e[1].pass === '큰따옴표 "있음"');
}

section('Bitwarden·1Password 머리글');
{
  const e = imp('folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n'
    + '업무,,login,사방넷,메모,,,https://sabangnet.co.kr,ray,pw-ccc,\n');
  check('name→site', e.length === 1 && e[0].site === '사방넷');
  check('login_username→user', e[0].user === 'ray');
  check('login_password→pass', e[0].pass === 'pw-ccc');
  check('login_uri→url', e[0].url === 'https://sabangnet.co.kr');
  check('folder→category', e[0].category === '업무');
}

section('빈 행·머리글 없는 파일');
{
  check('완전히 빈 행은 버린다', imp(CHROME + ',,,,\n').length === 0);
  check('아이디·비번 없이 url만 있는 행도 버린다', imp(CHROME + ',https://b.com,,,\n').length === 0);

  const urlOnly = imp(CHROME + ',https://b.com,,p1,\n');
  check('이름이 없으면 url을 이름으로', urlOnly.length === 1 && urlOnly[0].site === 'https://b.com');

  const noHeader = imp('A,https://a.com,u1,p1,메모\nB,https://b.com,u2,p2,\n');
  check('머리글이 없으면 site,url,user,pass,memo 순서로', noHeader.length === 2 && noHeader[0].pass === 'p1');
}

section('대량 가져오기에서 id가 겹치지 않는다');
{
  let csv = CHROME;
  for (let i = 0; i < 1000; i++) csv += `사이트${i},,u${i},p${i},\n`;
  const e = imp(csv);
  check('1000건 전부 파싱', e.length === 1000);
  check('id 전부 고유', new Set(e.map((x) => x.id)).size === 1000);
}
