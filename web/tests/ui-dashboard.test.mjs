// 대시보드 — 실제 DOM 에 그려 놓고 탭을 눌러 본다.
// ⚠️ 이 파일이 존재하는 이유: 2026-07-30 분류 Top 탭이 **배포까지 나간 뒤에** 안 눌린다는 걸 알았다.
//    추이 카드의 기간 토글이 공용 클래스(.an-seg-btn)로 핸들러를 걸어 탭의 onclick 을 덮어썼다.
//    계산은 멀쩡했으므로 순수 함수 테스트로는 절대 못 잡는다. 눌러 봐야 안다.
import { check, section } from './_helpers.mjs';
import { bootApp, $, $$, click, tick } from './_dom.mjs';

const TODAY = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const day = (n) => { const d = new Date(TODAY + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const T = (o) => Object.assign({ id: 'x' + Math.random().toString(36).slice(2), text: '업무', projectId: 'p1', channel: '마리오', subChannel: '패션플러스', status: '대기', registeredDate: day(-5), dueDate: day(1) }, o);

function boot() {
  const env = bootApp();
  env.app.setState({
    projects: [{ id: 'p1', name: '영업', color: '#1a73e8' }, { id: 'p2', name: '정산', color: '#0f9d58' }],
    todos: [
      T({ status: '완료', completedDate: day(-1), dueDate: day(-2) }),
      T({ status: '진행중' }),
      T({ status: '대기', channel: '사방넷', subChannel: '' }),
      T({ status: '완료', projectId: 'p2', completedDate: day(-1) }),
      T({ status: '대기', dueDate: day(-3) }),
    ],
    events: [], channels: ['마리오', '사방넷'], subMaster: ['패션플러스'], settings: {},
  });
  env.app.renderDashAnalytics();
  return env;
}

section('분류 Top — 탭이 실제로 전환된다');
{
  const env = boot();
  const tabs = () => $$(env.document, '[data-taxo]');
  const on = () => (tabs().find((b) => b.className.includes('on')) || {}).dataset;

  check('탭 3개가 그려진다', tabs().length === 3);
  check('기본은 중분류', on() && on().taxo === 'mid');
  check('중분류 값이 보인다', $(env.document, '#dashAnalytics').innerHTML.includes('마리오'));

  // 소분류로 전환 — 여기가 예전에 죽어 있던 자리
  click(tabs().find((b) => b.dataset.taxo === 'sub'));
  await tick();
  check('소분류로 바뀐다', on() && on().taxo === 'sub');
  check('소분류 값이 보인다', $(env.document, '#dashAnalytics').innerHTML.includes('패션플러스'));

  // 대분류로
  click(tabs().find((b) => b.dataset.taxo === 'proj'));
  await tick();
  check('대분류로 바뀐다', on() && on().taxo === 'proj');
  check('대분류 값이 보인다', $(env.document, '#dashAnalytics').innerHTML.includes('영업'));

  check('선택이 기기에 기억된다', env.store['dashTaxoTab'] === 'proj');
}

section('추이 기간 토글도 같이 살아 있다');
{
  const env = boot();
  const months = () => $$(env.document, '[data-months]');
  check('6·12개월 버튼', months().length === 2);

  click(months().find((b) => b.dataset.months === '12'));
  await tick();
  check('12개월로 바뀐다', env.store['trendMonths'] === '12');

  // ⚠️ 핵심 회귀 검사: 분류 탭을 눌러도 기간이 리셋되면 안 된다.
  //    예전 버그에서는 탭 클릭이 기간 토글 핸들러를 타서 6개월로 되돌아갔다.
  click($$(env.document, '[data-taxo]').find((b) => b.dataset.taxo === 'sub'));
  await tick();
  check('분류 탭을 눌러도 기간이 유지된다', env.store['trendMonths'] === '12');
  check('그리고 분류는 제대로 바뀐다', env.store['dashTaxoTab'] === 'sub');
}

section('분류 Top 내용이 데이터와 맞는다');
{
  const env = boot();
  const html = $(env.document, '#dashAnalytics').innerHTML;
  check('막대가 2중이다(전체 + 완료)', html.includes('color-mix(in srgb') && html.includes('<b style="width:'));
  check('"남음" 표기', html.includes('남음'));
  check('처리 지표 카드', html.includes('처리 지표'));
  check('진행 상태 분포 카드', html.includes('진행 상태 분포'));
  check('추이 카드', html.includes('개월 추이'));
  check('옛 카드는 없다', !html.includes('중분류 Top') && !html.includes('대분류별 진행률'));
}

section('할 일이 없으면 분석 영역과 제목이 함께 숨는다');
{
  const env = bootApp();
  env.app.setState({ projects: [{ id: 'p1', name: '영업' }], todos: [], events: [], channels: [], subMaster: [], settings: {} });
  env.app.renderDashAnalytics();
  check('분석 영역이 비어 있다', $(env.document, '#dashAnalytics').innerHTML === '');
  check('구역 제목도 숨는다', $(env.document, '#dashAnalyticsSec').hasAttribute('hidden'));
}
