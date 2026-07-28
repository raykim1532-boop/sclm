// 소스 조각(../src/*)을 합쳐 배포용 단일 HTML(public/index.html)을 만들고,
// 정적 자산(static/*)을 함께 복사한다.
//
// 앱은 여전히 "단일 HTML"로 배포된다. 편집만 나눠서 할 뿐이다.
//   src/shell.html   — HTML 뼈대 + FullCalendar 임베드 번들(수정 금지) + <!--@include ...--> 자리표시자
//   src/app.css      — 앱 스타일
//   src/local-api.js — 로컬 저장 계층(window.api)
//   src/cloud-sync.js— 클라우드 동기화(window.CloudSync)
//   src/app.js       — 앱 로직
//
// public/ 은 gitignore 되므로, 배포에 필요한 파일은 반드시 static/ 에 두고 커밋할 것.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const srcDir = path.join(root, 'src');
const outDir = path.join(__dirname, 'public');
const staticDir = path.join(__dirname, 'static');

const INCLUDE = /^[ \t]*<!--@include ([^>]+?)-->[ \t]*$/gm;

function build() {
  const shellPath = path.join(srcDir, 'shell.html');
  if (!fs.existsSync(shellPath)) throw new Error('src/shell.html 이 없습니다');
  const shell = fs.readFileSync(shellPath, 'utf8');

  const used = [];
  const html = shell.replace(INCLUDE, (_m, rel) => {
    const p = path.join(root, rel.trim());
    if (!fs.existsSync(p)) throw new Error('include 대상 없음: ' + rel);
    used.push(rel.trim());
    // 조각 파일은 끝에 개행이 있어야 편집이 편하지만, 합칠 때는 중복 개행을 만들지 않는다
    return fs.readFileSync(p, 'utf8').replace(/\r?\n$/, '');
  });

  if (!used.length) throw new Error('include 자리표시자를 찾지 못했습니다(shell.html 확인)');
  if (/<!--@include/.test(html)) throw new Error('처리되지 않은 include 가 남아 있습니다');

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'index.html'), html);
  console.log(`✓ 생성: src/shell.html + ${used.length}개 조각 → public/index.html`);
  used.forEach((u) => console.log('   ├ ' + u));

  if (fs.existsSync(staticDir)) {
    const files = fs.readdirSync(staticDir);
    files.forEach((f) => fs.copyFileSync(path.join(staticDir, f), path.join(outDir, f)));
    console.log(`✓ 복사: static/* (${files.length}개) → public/`);
  }
}

build();
