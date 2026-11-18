// 공적심사위원회 흐름 테스트: node dev/server.js 를 켠 뒤 node dev/e2e-award.js <출력폴더>
// 예시5로 회의록을 만들고, 위원이 가/부 + 서명 한 번 → 공적심사의결서와 회의록에 함께 들어가는지 확인합니다.
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
  if (await admin.$('#pw2')) { // 새 서버
    await admin.fill('#pw', 'admin1234'); await admin.fill('#pw2', 'admin1234');
  } else {
    await admin.fill('#pw', 'admin1234');
  }
  await admin.click('#f button');
  await admin.click('#new');
  await admin.check('[name=mtype][value=award]');
  console.log('committee switched:', await admin.inputValue('[name=committee]'), '/', await admin.inputValue('[name=title]'));
  await admin.click('[data-tpl="4"]'); // 예시5 공적심사
  const f = (n, v) => admin.fill(`[name=${n}]`, v);
  await f('datetime', '2026. 3. 30.(월) 13:20~');
  await f('place', '교무회의실');
  await f('school', '구미초등학교 2026 공적심사위원회');
  await f('agenda', '제59회 과학의 날 기념 교육감 표창 대상자 추천 공적심사');
  await admin.dispatchEvent('[name=agenda]', 'input');
  await f('result', (await admin.inputValue('[name=result]')).replace(/제○회 ○○의 날/g, '제59회 과학의 날').replace(/○○○/g, '이순신').replace(/○/g, '1'));
  await admin.dispatchEvent('[name=result]', 'input');
  console.log('auto title:', await admin.inputValue('[name=a_title]'));
  console.log('auto criteria:', await admin.inputValue('[name=a_criteria]'));
  console.log('auto org:', await admin.inputValue('[name=a_org]'));
  const nom = await admin.$$('#nrows [data-n]');
  console.log('nominee auto grade/org:', await nom[0].inputValue(), '/', await nom[1].inputValue());
  await nom[3].fill('이순신');
  await f('a_confirmerName', '임 지 선');
  const names = ['홍길동', '김하늘', '이바다', '최산들', '정나래', '강도윤', '윤서아', '한지우'];
  const inputs = await admin.$$('[data-k=name]');
  for (let i = 0; i < inputs.length; i++) await inputs[i].fill(names[i]);
  await admin.screenshot({ path: OUT + '/a1-edit.png', fullPage: true });
  await admin.click('#save');
  await admin.waitForSelector('.modal .pw');
  const texts = await admin.$$eval('.modal pre.copy', (els) => els.map((e) => e.textContent));
  const creds = texts.map((t) => ({ link: t.match(/링크: (\S+)/)[1], pw: t.match(/비밀번호: (\d{6})/)[1] }));
  await admin.click('.modal [data-close]');

  const phone = await browser.newContext({ ...devices['iPhone 13'] });
  for (let i = 0; i < 8; i++) {
    const pg = await phone.newPage();
    pg.on('pageerror', (e) => errors.push('member: ' + e.message));
    await pg.goto(creds[i].link);
    await pg.fill('#pw', creds[i].pw);
    await pg.click('#f button');
    await pg.waitForSelector('#pad');
    if (i === 0) await pg.screenshot({ path: OUT + '/a3-member-view.png', fullPage: true });
    await pg.evaluate(() => {
      const c = document.getElementById('pad');
      const r = c.getBoundingClientRect();
      const ev = (type, x, y) => c.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 1, pointerType: 'touch', clientX: r.left + x, clientY: r.top + y }));
      ev('pointerdown', 40, 110);
      for (let k = 0; k < 30; k++) ev('pointermove', 40 + k * 9, 95 + Math.sin(k / 2.5) * 45);
      ev('pointerup', 310, 100);
    });
    await pg.check('#agree');
    await pg.check('#esign');
    if (i === 0) {
      await pg.click('#sign'); // 가/부 없이 → 막혀야 함
      console.log('no-vote msg:', await pg.textContent('#m'));
    }
    await pg.check(`[name=vote][value=${i === 5 ? '부' : '가'}]`);
    if (i === 0) await (await pg.$('#signCard')).screenshot({ path: OUT + '/a4-sign-card.png' });
    await pg.click('#sign');
    await pg.waitForSelector('.msg.ok', { timeout: 8000 });
    if (i === 0) {
      const marks = await pg.$$eval('.doc.award td.vote', (tds) => tds.map((t) => t.textContent.trim()).join(''));
      console.log('member sees own vote only:', JSON.stringify(marks));
      await pg.screenshot({ path: OUT + '/a5-member-done.png', fullPage: true });
    }
    await pg.close();
  }

  await admin.reload();
  await admin.waitForSelector('tr.click');
  await admin.screenshot({ path: OUT + '/a6-list.png' });
  await admin.click('tr.click');
  await admin.waitForSelector('.doc.award');
  console.log('award sig imgs:', await admin.$$eval('.doc.award td.sig img', (x) => x.length),
    'minutes sig imgs:', await admin.$$eval('.doc:not(.award) .sign img', (x) => x.length));
  console.log('votes:', await admin.$$eval('.doc.award td.vote', (tds) => tds.map((t) => t.textContent.trim() || '_').join('')));
  await admin.screenshot({ path: OUT + '/a7-detail.png', fullPage: true });

  await admin.click('#print');
  await admin.evaluate(() => { window.print = () => { window.__printed = true; }; });
  await admin.click('#doPrint');
  await admin.waitForFunction(() => window.__printed);
  console.log('print order:', await admin.$$eval('#print-area .doc', (ds) => ds.map((d) => d.className).join(' | ')));
  await admin.emulateMedia({ media: 'print' });
  await admin.pdf({ path: OUT + '/award.pdf', preferCSSPageSize: true, printBackground: true });

  console.log('errors:', errors);
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
