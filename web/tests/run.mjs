// 테스트 러너 — web/tests/*.test.mjs 를 모두 실행하고 실패 시 exit 1.
// 실행: cd web && npm test
import { readdirSync } from 'node:fs';
import { results } from './_helpers.mjs';

const dir = new URL('.', import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).sort();

console.log('SCLM 테스트 — ' + files.length + '개 파일\n');
for (const f of files) {
  console.log('▶ ' + f);
  await import(new URL(f, dir).href);
}

const { passed, failed, failures } = results();
console.log('\n' + '─'.repeat(46));
console.log(`통과 ${passed} · 실패 ${failed}`);
if (failed) {
  console.log('\n실패 목록:');
  failures.forEach((n) => console.log('  ✗ ' + n));
  process.exit(1);
}
console.log('✅ 전부 통과');
// UI 테스트가 app.js 를 통째로 실행하면서 남긴 타이머(금고 자동잠금 30초 간격 등) 때문에
// 결과를 다 찍고도 node 가 안 죽는다. 러너는 판정이 끝나면 바로 나가는 게 맞다.
process.exit(0);
