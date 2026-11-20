// 불참 처리·성원/의결 계산 테스트: node dev/server.js 를 켠 뒤 node dev/e2e-absence.js <출력폴더>
// 공적심사 8명 중 3명 불참(불참/출장/연수) → 참석 5명(성원 충족), 가 3 · 부 2 → 가결, 참석자 전원 서명 시 자동 마감.
const { chromium, devices } = require('playwright');
const OUT = process.argv[2] || '.';
const BASE = 'http://localhost:8787/exec';

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const admin = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  admin.on('pageerror', (e) => errors.push('admin: ' + e.message));
  admin.on('dialog', (d) => d.accept());
  await admin.goto(BASE + '?page=admin');
  await admin.fill('#pw', 'admin1234'); if (await admin.$('#pw2')) await admin.fill('#pw2', 'admin1234');
  await admin.click('#f button');
  await admin.click('#new');
  await admin.check('[name=mtype][value=award]');
  await admin.click('[data-tpl="4"]');
  await admin.fill('[name=school]', '한빛초등학교 2026 공적심사위원회');
  await admin.dispatchEvent('[name=school]', 'input');
  const names = ['홍길동', '김하늘', '이바다', '최산들', '정나래', '강도윤', '윤서아', '한지우'];
  const inputs = await admin.$$('[data-k=name]');
  for (let i = 0; i < inputs.length; i++) await inputs[i].fill(names[i]);
  await admin.click('#save');
  await admin.waitForSelector('.modal .pw');
  const texts = await admin.$$eval('.modal pre.copy', (els) => els.map((e) => e.textContent));
  const creds = texts.map((t) => ({ link: t.match(/링크: (\S+)/)[1], pw: t.match(/비밀번호: (\d{6})/)[1] }));
  await admin.click('.modal [data-close]');

  // 5~7번 위원 불참 처리 (불참 / 출장 / 직접 입력 '연수')
  const reasons = { 5: null, 6: '출장', 7: '연수' };
  for (const i of [5, 6, 7]) {
    await admin.click(`tr[data-mid]:nth-of-type(${i + 2}) [data-act=absent]`);
    await admin.waitForSelector('#absText');
    if (reasons[i] === '출장') await admin.click('[data-chip="출장"]');
    if (reasons[i] === '연수') await admin.fill('#absText', '연수');
    await admin.click('#absSave');
    await admin.waitForSelector('.modal-back', { state: 'detached' });
    await admin.waitForSelector('.quorum');
  }
  console.log('quorum before signing:', (await admin.textContent('.quorum')).replace(/\s+/g, ' ').trim());
  await admin.screenshot({ path: OUT + '/b1-detail-absent.png', fullPage: true });

  // 불참 위원은 서명할 수 없음
  const phone = await browser.newContext({ ...devices['iPhone 13'] });
  const ab = await phone.newPage();
  await ab.goto(creds[6].link); await ab.fill('#pw', creds[6].pw); await ab.click('#f button');
  await ab.waitForSelector('.doc');
  console.log('absent member pad shown:', !!(await ab.$('#pad')), '| msg:', (await ab.textContent('.msg.warn')).trim());
  await ab.close();

  // 참석 5명 서명: 가 3, 부 2
  for (let i = 0; i < 5; i++) {
    const pg = await phone.newPage();
    pg.on('pageerror', (e) => errors.push('member: ' + e.message));
    await pg.goto(creds[i].link); await pg.fill('#pw', creds[i].pw); await pg.click('#f button');
    await pg.waitForSelector('#pad');
    await pg.evaluate(() => {
      const c = document.getElementById('pad'); const r = c.getBoundingClientRect();
      const ev = (type, x, y) => c.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'touch', clientX: r.left + x, clientY: r.top + y }));
      ev('pointerdown', 40, 110); for (let k = 0; k < 30; k++) ev('pointermove', 40 + k * 9, 95 + Math.sin(k / 2.5) * 45); ev('pointerup', 310, 100);
    });
    await pg.check(`[name=vote][value=${i < 3 ? '가' : '부'}]`);
    await pg.check('#agree'); await pg.check('#esign'); await pg.click('#sign');
    await pg.waitForSelector('.msg.ok', { timeout: 8000 });
    if (i === 0) {
      const cells = await pg.$$eval('.doc.award td.sig', (tds) => tds.map((t) => t.textContent.trim() || (t.querySelector('img') ? '[서명]' : '_')));
      console.log('member view sig cells:', cells.join(' '));
    }
    await pg.close();
  }

  await admin.reload();
  await admin.waitForSelector('tr.click');
  console.log('list row:', (await admin.textContent('tr.click')).replace(/\s+/g, ' ').trim());
  await admin.click('tr.click');
  await admin.waitForSelector('.quorum');
  console.log('quorum after:', (await admin.textContent('.quorum')).replace(/\s+/g, ' ').trim());
  console.log('closed:', await admin.textContent('#toggle'));
  console.log('award sig cells:', (await admin.$$eval('.doc.award td.sig', (tds) => tds.map((t) => t.textContent.trim() || (t.querySelector('img') ? '[서명]' : '_')))).join(' '));
  console.log('minutes sig cells:', (await admin.$$eval('.doc:not(.award) tr.r-sig td', (tds) => tds.map((t) => t.textContent.trim() || (t.querySelector('img') ? '[서명]' : '_')))).join(' '));
  await admin.screenshot({ path: OUT + '/b2-detail-done.png', fullPage: true });

  await admin.click('#print');
  await admin.evaluate(() => { window.print = () => { window.__printed = true; }; });
  await admin.click('#doPrint');
  await admin.waitForFunction(() => window.__printed);
  console.log('audit quorum:', (await admin.$eval('#print-area .doc.audit', (d) => d.textContent)).match(/재적[^(]+/)[0].replace(/\s+/g, ' ').trim());
  await admin.emulateMedia({ media: 'print' });
  await admin.pdf({ path: OUT + '/absence.pdf', preferCSSPageSize: true, printBackground: true });

  console.log('errors:', errors);
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
