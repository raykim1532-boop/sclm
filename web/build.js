// 단일 소스(../MySchedulerApp.html)와 정적 자산(static/*)을 배포용 폴더(public/)로 복사.
// 앱은 한 곳에서만 관리하고 배포 직전에 public/ 으로 밀어넣는다.
// public/ 은 gitignore 되므로, 배포에 필요한 파일은 반드시 static/ 에 두고 커밋할 것.
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'MySchedulerApp.html');
const outDir = path.join(__dirname, 'public');
const staticDir = path.join(__dirname, 'static');

fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(src, path.join(outDir, 'index.html'));
console.log('✓ 복사: ../MySchedulerApp.html → public/index.html');

if (fs.existsSync(staticDir)) {
  const files = fs.readdirSync(staticDir);
  files.forEach((f) => fs.copyFileSync(path.join(staticDir, f), path.join(outDir, f)));
  console.log(`✓ 복사: static/* (${files.length}개) → public/`);
}
