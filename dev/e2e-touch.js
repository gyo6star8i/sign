// 실제 터치 입력(CDP)으로 서명 칸 첫 획이 바로 그려지는지 확인: node dev/e2e-touch.js "iPhone 13" [broken]
const { chromium, devices } = require('playwright');
const BASE = 'http://localhost:8787/exec';
(async () => {
  const browser = await chromium.launch();
  const admin = await browser.newPage();
  admin.on('dialog', (d) => d.accept());
  await admin.goto(BASE + '?page=admin');
  await admin.fill('#pw', 'admin1234'); if (await admin.$('#pw2')) await admin.fill('#pw2', 'admin1234');
  await admin.click('#f button'); await admin.click('#new');
  await admin.fill('[name=agenda]', '테스트 안건');
  for (const i of await admin.$$('[data-k=name]')) await i.fill('가나다');
  await admin.click('#save'); await admin.waitForSelector('.modal .pw');
  const t = await admin.$eval('.modal pre.copy', (e) => e.textContent);
  const link = t.match(/링크: (\S+)/)[1]; const pw = t.match(/비밀번호: (\d{6})/)[1];

  const ctx = await browser.newContext({ ...devices[process.argv[2] || 'iPhone 13'] });
  const pg = await ctx.newPage();
  pg.on('console', (m) => console.log('console:', m.text()));
  await pg.goto(link); await pg.fill('#pw', pw); await pg.click('#f button');
  await pg.waitForSelector('#pad');
  const cdp = await ctx.newCDPSession(pg);
  const ink = () => pg.evaluate(() => {
    const c = document.getElementById('pad'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 10) n++; return n;
  });
  const info = () => pg.evaluate(() => { const c = document.getElementById('pad'); const r = c.getBoundingClientRect();
    return `canvas ${c.width}x${c.height} rect ${Math.round(r.width)}x${Math.round(r.height)} top ${Math.round(r.top)}`; });
  const stroke = async () => {
    await pg.$eval('#pad', (c) => c.scrollIntoView({ block: 'center' }));
    await pg.waitForTimeout(300);
    const r = await pg.$eval('#pad', (c) => { const b = c.getBoundingClientRect(); return { x: b.left, y: b.top }; });
    const pt = (x, y) => [{ x: r.x + x, y: r.y + y }];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(40, 100) });
    for (let k = 1; k < 20; k++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(40 + k * 12, 100 + Math.sin(k / 2) * 40) });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await pg.waitForTimeout(200);
  };
  if (process.argv[3] === 'broken') { // 처음 크기가 잘못 잡힌 상황 흉내
    await pg.evaluate(() => { const c = document.getElementById('pad'); c.width = 1; c.height = 1; });
  }
  console.log('before:', await info());
  await stroke();
  console.log('ink after 1st real touch stroke:', await ink(), '| hint hidden:', await pg.$eval('#hint', (h) => h.classList.contains('hidden')));
  console.log('after:', await info());
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
