// 단일 소스(../MySchedulerApp.html)를 배포용 정적 폴더(public/index.html)로 복사.
// 앱을 한 곳에서만 관리하고 배포 직전에 public/ 으로 밀어넣는다.
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'MySchedulerApp.html');
const outDir = path.join(__dirname, 'public');
fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(src, path.join(outDir, 'index.html'));
console.log('✓ 복사: ../MySchedulerApp.html → public/index.html');
