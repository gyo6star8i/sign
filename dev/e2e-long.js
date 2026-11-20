// 회의록이 길어 두 쪽 이상이 될 때: 원본 전체·회의록만 PDF에 모든 쪽과 서명표가 들어가는지 확인
// node dev/server.js 를 켠 뒤 node dev/e2e-long.js <출력폴더> [줄 수]
// (테스트 서버는 HTML을 그대로 'PDF'로 저장하므로, 그 HTML을 크롬으로 A4 PDF로 그려 쪽 수를 셉니다.)
const { chromium } = require('playwright');
const fs = require('fs');
const OUT = process.argv[2] || '.';
const LINES = Number(process.argv[3] || 70);
const BASE = 'http://localhost:8787/exec';

async function renderPdf(browser, html, path) {
  const p = await browser.newPage();
  await p.setContent(html);
  await p.pdf({ path, format: 'A4', margin: { top: '15mm', bottom: '15mm', left: '15mm', right: '15mm' } });
  const info = await p.evaluate(() => ({
    docs: Array.from(document.querySelectorAll('.doc')).map((d) => d.className),
    signTable: !!document.querySelector('.doc:not(.audit) table.sign'),
    lastLine: (document.querySelector('.doc .info .result td') || {}).textContent.trim().split('\n').pop(),
  }));
  await p.close();
  const pages = (fs.readFileSync(path, 'latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
  return Object.assign({ pages }, info);
}

(async () => {
  const browser = await chromium.launch();
  const a = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  a.on('dialog', (d) => d.accept());
  await a.goto(BASE + '?page=admin');
  await a.fill('#pw', 'admin1234'); if (await a.$('#pw2')) await a.fill('#pw2', 'admin1234');
  await a.click('#f button');
  await a.click('#new');
  await a.fill('[name=datetime]', '2026. 11. 20.(금) 08:30~');
  await a.fill('[name=place]', '교무회의실');
  await a.fill('[name=agenda]', '긴 회의록 쪽 나눔 확인');
  const lines = Array.from({ length: LINES }, (_, i) => `  - ${i + 1}번째 줄: 회의 결과 내용이 길어질 때 두 쪽으로 나뉘어 저장되는지 확인하는 문장입니다.`);
  lines[LINES - 1] = '  - 마지막 줄입니다.';
  await a.fill('[name=result]', lines.join('\n'));
  for (const i of await a.$$('[data-k=name]')) await i.fill('가나다');
  await a.click('#save'); await a.waitForSelector('.modal .pw'); await a.click('.modal [data-close]');

  await a.click('#print');
  await a.click('#drive');
  await a.waitForSelector('#dlMin');
  const full = await (await fetch('http://localhost:8787/__pdf')).text();
  await a.click('#dlMin');
  await a.waitForSelector('#dlMinNote a');
  const min = await (await fetch('http://localhost:8787/__pdf')).text();

  const f = await renderPdf(browser, full, OUT + '/long-full.pdf');
  const m = await renderPdf(browser, min, OUT + '/long-minutes.pdf');
  console.log(`[${LINES}줄] 원본 전체: ${f.pages}쪽, 문서 ${f.docs.join(' | ')}, 서명표 ${f.signTable}, 마지막 줄 "${f.lastLine}"`);
  console.log(`[${LINES}줄] 회의록만: ${m.pages}쪽, 문서 ${m.docs.join(' | ')}, 서명표 ${m.signTable}, 마지막 줄 "${m.lastLine}"`);
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
