// 분류 체계(대분류 > 중분류 > 소분류) — src/app.js 에서 함수를 추출해 검증한다.
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
  check('channelProjects 객체 생성', s.channelProjects && typeof s.channelProjects === 'object');
  check('subChannels 객체 생성', s.subChannels && typeof s.subChannels === 'object');
  check('subMaster 배열 생성', Array.isArray(s.subMaster) && s.subMaster.length === 0);

  const s2 = migrateTaxonomy({ todos: null, projects: null, channels: 'x' });
  check('망가진 값도 배열/객체로 교정', Array.isArray(s2.channels) && s2.channels.length === 0);
}

section('할 일에 쓰인 값을 마스터로 편입');
{
  const s = migrateTaxonomy({
    projects: P,
    todos: [
      T({ projectId: 'p1', channel: '마리오아울렛', subChannel: '온라인' }),
      T({ projectId: 'p1', channel: '마리오아울렛', subChannel: '오프라인' }),
      T({ projectId: 'p2', channel: '엔터식스' })
    ]
  });
  check('중분류 2개 수집', s.channels.length === 2 && s.channels.includes('마리오아울렛') && s.channels.includes('엔터식스'));
  check('소분류가 중분류에 연결', s.subChannels['마리오아울렛'].join(',') === '온라인,오프라인');
  check('소분류가 공용 목록에도 등록', s.subMaster.join(',') === '온라인,오프라인');
  check('소분류 없는 중분류는 키 없음', s.subChannels['엔터식스'] === undefined);
  check('중복 소분류는 한 번만', migrateTaxonomy({
    projects: P,
    todos: [T({ projectId: 'p1', channel: 'A', subChannel: 'x' }), T({ projectId: 'p1', channel: 'A', subChannel: 'x' })]
  }).subChannels['A'].length === 1);
}

section('소속 대분류 추론 (가장 많이 쓰인 쪽)');
{
  const s = migrateTaxonomy({
    projects: P,
    todos: [
      T({ projectId: 'p1', channel: '마리오아울렛' }),
      T({ projectId: 'p1', channel: '마리오아울렛' }),
      T({ projectId: 'p2', channel: '마리오아울렛' })   // 소수파
    ]
  });
  check('다수결로 p1 배정', s.channelProjects['마리오아울렛'] === 'p1');

  const keep = migrateTaxonomy({
    projects: P,
    channels: ['마리오아울렛'],
    channelProjects: { '마리오아울렛': 'p2' },
    todos: [T({ projectId: 'p1', channel: '마리오아울렛' })]
  });
  check('이미 정해진 소속은 덮어쓰지 않음', keep.channelProjects['마리오아울렛'] === 'p2');

  const gone = migrateTaxonomy({
    projects: P,
    channels: ['X'],
    channelProjects: { X: 'p9' },   // 삭제된 대분류를 가리킴
    todos: [T({ projectId: 'p2', channel: 'X' })]
  });
  check('사라진 대분류를 가리키면 다시 추론', gone.channelProjects['X'] === 'p2');

  const unused = migrateTaxonomy({ projects: P, channels: ['미사용'], todos: [] });
  check('할 일이 없는 중분류는 첫 대분류로', unused.channelProjects['미사용'] === 'p1');

  const noProj = migrateTaxonomy({ projects: [], channels: ['고아'], todos: [] });
  check('대분류가 하나도 없으면 null', noProj.channelProjects['고아'] === null);
}

section('공백·빈 값 처리');
{
  const s = migrateTaxonomy({
    projects: P,
    todos: [
      T({ projectId: 'p1', channel: '  ', subChannel: '온라인' }),   // 중분류 없음 → 소분류도 버림
      T({ projectId: 'p1', channel: '엔터식스', subChannel: '   ' })
    ]
  });
  check('빈 중분류는 등록 안 함', !s.channels.includes('') && !s.channels.includes('  '));
  check('중분류 없는 소분류는 연결되지 않음', Object.keys(s.subChannels).length === 0);
  check('다만 공용 목록에는 남는다(값 보존)', s.subMaster.includes('온라인'));
  check('빈 소분류도 등록 안 함', s.channels.includes('엔터식스') && !s.subMaster.includes('   '));
}

section('기존 데이터를 지우지 않는다');
{
  const s = migrateTaxonomy({
    projects: P,
    channels: ['기존중분류'],
    subChannels: { 기존중분류: ['기존소분류'] },
    todos: []
  });
  check('기존 중분류 유지', s.channels.includes('기존중분류'));
  check('기존 소분류 연결 유지', s.subChannels['기존중분류'].includes('기존소분류'));
  check('기존 연결이 공용 목록으로 승격(구조 변경 호환)', s.subMaster.includes('기존소분류'));
  check('todos는 건드리지 않음', Array.isArray(s.todos) === false || s.todos.length === 0);
}

section('소분류 공용 — 한 이름을 여러 중분류가 공유');
{
  const s = migrateTaxonomy({
    projects: P,
    todos: [
      T({ projectId: 'p1', channel: '마리오아울렛', subChannel: '하프' }),
      T({ projectId: 'p1', channel: '대백', subChannel: '하프' }),
      T({ projectId: 'p1', channel: '대백', subChannel: '패플' })
    ]
  });
  check('공용 목록엔 이름이 한 번만', s.subMaster.join(',') === '하프,패플');
  check('마리오아울렛에 하프 연결', s.subChannels['마리오아울렛'].join(',') === '하프');
  check('대백에 하프·패플 연결', s.subChannels['대백'].join(',') === '하프,패플');
}
