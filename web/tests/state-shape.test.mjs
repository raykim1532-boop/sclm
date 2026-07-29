// 상태 정규화(ensureShape) — src/cloud-sync.js 에서 함수를 추출해 검증한다.
// 회귀 방지: 2026-07-29 화이트리스트로 새 객체를 만드는 바람에 소분류 목록(subMaster)이
// 앱을 열 때마다 사라졌다. 모르는 키를 버리면 안 된다.
import { readFileSync } from 'node:fs';
import { check, section } from './_helpers.mjs';

const src = readFileSync(new URL('../../src/cloud-sync.js', import.meta.url), 'utf8');
const grab = (re, name) => { const m = src.match(re); if (!m) throw new Error('함수 추출 실패: ' + name); return m[0]; };
const code = grab(/function ensureShape\([\s\S]*?\r?\n  }/, 'ensureShape');
// ensureShape가 쓰는 uniqueChannels는 app.js에 있으므로 같은 동작의 최소 구현을 넣어준다
const ensureShape = new Function(
  'function uniqueChannels(todos){const s=[];(Array.isArray(todos)?todos:[]).forEach(t=>{const c=((t&&t.channel)||"").trim();if(c&&!s.includes(c))s.push(c)});return s;}'
  + code + '; return ensureShape;'
)();

section('모르는 키를 버리지 않는다');
{
  const s = ensureShape({
    todos: [], projects: [{ id: 'p1', name: '영업' }],
    subMaster: ['하프클럽', '패션플러스'],       // 나중에 추가된 필드
    channelColors: { 마리오아울렛: '#1a73e8' },
    미래필드: { 아무거나: 1 }
  });
  check('소분류 목록 보존', Array.isArray(s.subMaster) && s.subMaster.length === 2);
  check('중분류 색상 보존', s.channelColors['마리오아울렛'] === '#1a73e8');
  check('앞으로 추가될 필드도 보존', s.미래필드.아무거나 === 1);
}

section('아는 키는 모양을 보정한다');
{
  const s = ensureShape({});
  check('projects 기본값', s.projects.length === 1 && s.projects[0].id === 'default');
  check('todos 배열', Array.isArray(s.todos) && s.todos.length === 0);
  check('settings 기본 테마', s.settings.theme === 'light');
  check('tasks 배열', Array.isArray(s.tasks));

  const broken = ensureShape({ todos: 'x', events: null, projects: [] });
  check('망가진 todos 교정', Array.isArray(broken.todos));
  check('망가진 events 교정', Array.isArray(broken.events));
  check('빈 projects는 기본값으로', broken.projects.length === 1);
}

section('금고와 분류 목록');
{
  const s = ensureShape({ vault: { ct: 'SECRET' }, channels: ['마리오아울렛'], subMaster: ['하프클럽'] });
  check('vault 그대로', s.vault.ct === 'SECRET');
  check('중분류 그대로', s.channels[0] === '마리오아울렛');
  check('소분류 그대로', s.subMaster[0] === '하프클럽');

  const seeded = ensureShape({ todos: [{ channel: 'SEMP' }, { channel: 'SEMP' }] });
  check('channels 없으면 할 일에서 수집', seeded.channels.join(',') === 'SEMP');
}
