// 분류 체계(대분류·중분류·소분류 — 서로 독립) — src/app.js 에서 함수를 추출해 검증한다.
// (브라우저용 조각이라 import가 불가능하므로 소스에서 떼어내 실행)
import { readFileSync } from 'node:fs';
import { check, section } from './_helpers.mjs';

const src = readFileSync(new URL('../../src/app.js', import.meta.url), 'utf8');
const grab = (re, name) => { const m = src.match(re); if (!m) throw new Error('함수 추출 실패: ' + name); return m[0]; };
// migrateTaxonomy는 taxoInit에 의존하므로 둘 다 떼어내 함께 평가한다
const code = grab(/function taxoInit\([\s\S]*?\r?\n}/, 'taxoInit') + '\n'
  + grab(/function migrateTaxonomy\([\s\S]*?\r?\n  return s;\r?\n}/, 'migrateTaxonomy');
const migrateTaxonomy = new Function(code + '; return migrateTaxonomy;')();

const P = [{ id: 'p1', name: '영업' }, { id: 'p2', name: '정산' }];
const T = (o) => Object.assign({ id: Math.random().toString(36).slice(2), text: '업무' }, o);

section('빈 상태에서도 안전');
{
  const s = migrateTaxonomy({});
  check('channels 배열 생성', Array.isArray(s.channels) && s.channels.length === 0);
  check('subMaster 배열 생성', Array.isArray(s.subMaster) && s.subMaster.length === 0);

  const s2 = migrateTaxonomy({ todos: null, projects: null, channels: 'x' });
  check('망가진 값도 배열로 교정', Array.isArray(s2.channels) && s2.channels.length === 0);
}

section('할 일에 쓰인 값을 목록으로 수집');
{
  const s = migrateTaxonomy({
    projects: P,
    todos: [
      T({ projectId: 'p1', channel: '마리오아울렛', subChannel: '하프' }),
      T({ projectId: 'p1', channel: '마리오아울렛', subChannel: '패플' }),
      T({ projectId: 'p2', channel: '엔터식스' })
    ]
  });
  check('중분류 2개 수집', s.channels.join(',') === '마리오아울렛,엔터식스');
  check('소분류 2개 수집', s.subMaster.join(',') === '하프,패플');
  check('중복은 한 번만', migrateTaxonomy({
    projects: P,
    todos: [T({ channel: 'A', subChannel: 'x' }), T({ channel: 'A', subChannel: 'x' })]
  }).subMaster.length === 1);
}

section('세 축은 서로 독립 — 소속을 만들지 않는다');
{
  // 같은 거래처(중분류)에 정산 업무도 영업 업무도 있는 실제 상황
  const s = migrateTaxonomy({
    projects: P,
    todos: [
      T({ projectId: 'p1', channel: '마리오아울렛', subChannel: '하프' }),
      T({ projectId: 'p2', channel: '마리오아울렛', subChannel: '하프' })
    ]
  });
  check('중분류를 대분류에 묶지 않음', s.channelProjects === undefined);
  check('소분류를 중분류에 묶지 않음', s.subChannels === undefined);
  check('중분류는 한 번만 등록', s.channels.join(',') === '마리오아울렛');
  check('두 대분류의 할 일이 모두 남아 있음', s.todos.length === 2);
  check('할 일의 대분류는 그대로', s.todos.map((t) => t.projectId).join(',') === 'p1,p2');
}

section('중분류 없이 소분류만 있어도 수집된다');
{
  const s = migrateTaxonomy({
    projects: P,
    todos: [T({ projectId: 'p1', subChannel: '하프' })]
  });
  check('소분류는 중분류와 독립이라 그대로 등록', s.subMaster.includes('하프'));
  check('중분류는 비어 있음', s.channels.length === 0);
}

section('공백·빈 값 처리');
{
  const s = migrateTaxonomy({
    projects: P,
    todos: [
      T({ projectId: 'p1', channel: '  ', subChannel: '   ' }),
      T({ projectId: 'p1', channel: '엔터식스', subChannel: '하프' })
    ]
  });
  check('빈 중분류는 등록 안 함', s.channels.join(',') === '엔터식스');
  check('빈 소분류는 등록 안 함', s.subMaster.join(',') === '하프');
}

section('옛 종속 구조 데이터 호환');
{
  const s = migrateTaxonomy({
    projects: P,
    channels: ['마리오아울렛', '대백'],
    channelProjects: { 마리오아울렛: 'p1', 대백: 'p1' },       // 옛 소속 정보
    subChannels: { 마리오아울렛: ['하프'], 대백: ['하프', '패플'] }, // 옛 연결 정보
    todos: []
  });
  check('옛 연결의 소분류를 목록으로 흡수', s.subMaster.join(',') === '하프,패플');
  check('중복 흡수 안 함', s.subMaster.filter((x) => x === '하프').length === 1);
  check('옛 소속 정보는 버린다', s.channelProjects === undefined);
  check('옛 연결 정보도 버린다', s.subChannels === undefined);
  check('중분류 목록은 유지', s.channels.join(',') === '마리오아울렛,대백');
}

section('기존 목록을 지우지 않는다');
{
  const s = migrateTaxonomy({
    projects: P,
    channels: ['쓰이지않는중분류'],
    subMaster: ['쓰이지않는소분류'],
    todos: []
  });
  check('할 일에 없어도 중분류 유지', s.channels.includes('쓰이지않는중분류'));
  check('할 일에 없어도 소분류 유지', s.subMaster.includes('쓰이지않는소분류'));
  check('todos는 건드리지 않음', s.todos.length === 0);
}
