// 로컬 전체 흐름 테스트: node dev/server.js 를 켠 뒤 node dev/e2e.js <출력폴더>
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
  await admin.fill('#pw', 'admin1234');
  await admin.fill('#pw2', 'admin1234');
  await admin.click('#f button');
  await admin.click('#new');
  const f = (n, v) => admin.fill(`[name=${n}]`, v);
  await f('title', '2026 인사자문위원회 회의록');
  await f('datetime', '2026. 9. 15.(수) 13:40~');
  await f('place', '교무회의실');
  await f('agenda', '계약제교원 연장 계약 채용 심의를 위한 인사자문위원 개최 결과');
  await f('result', '1. 사유: 유치원 방과후교사 홍길동 선생님의 육아휴직 및 출산휴가로 인함(2026. 9. 1. ~ 2027. 2. 28.)\n\n2. 결과: \n  - 본교에서 계약제교사로 성실히 근무함.\n  - 유치원 유아 특성을 잘 이해하여 생활지도 및 학습지도를 잘함.\n  - 교원이 갖추어야 할 덕목을 잘 알고 있으며, 풍부한 현장 경험으로 학생들을 잘 지도함.라고 판단함.\n  - 임꺽정 선생님을 연장하여 채용하기로 함.');
  await f('confirmDate', '2026. 10. 10.');
  await f('school', '○○초등학교 2026 인사자문위원회');
  const names = ['박교감', '김하늘', '이바다', '최산들', '정나래', '강도윤', '윤서아', '한지우'];
  const inputs = await admin.$$('[data-k=name]');
  for (let i = 0; i < inputs.length; i++) await inputs[i].fill(names[i]);
  await admin.screenshot({ path: OUT + '/1-edit.png', fullPage: true });
  await admin.click('#save');
  await admin.waitForSelector('.modal .pw');
  await admin.screenshot({ path: OUT + '/2-passwords.png' });
  const texts = await admin.$$eval('.modal pre.copy', (els) => els.map((e) => e.textContent));
  const creds = texts.map((t) => ({ link: t.match(/링크: (\S+)/)[1], pw: t.match(/비밀번호: (\d{6})/)[1] }));
  await admin.click('.modal [data-close]');

  // 위원 서명 (휴대폰 화면). 마지막 위원은 미서명으로 남겨 둡니다.
  const phone = await browser.newContext({ ...devices['iPhone 13'] });
  for (let i = 0; i < 7; i++) {
    const pg = await phone.newPage();
    pg.on('pageerror', (e) => errors.push('member: ' + e.message));
    await pg.goto(creds[i].link);
    if (i === 0) {
      await pg.fill('#pw', '000000');
      await pg.click('#f button');
      await pg.waitForSelector('#m.msg.err');
      console.log('wrong pw msg:', await pg.textContent('#m'));
    }
    await pg.fill('#pw', creds[i].pw);
    await pg.click('#f button');
    await pg.waitForSelector('#pad');
    if (i === 0) await pg.screenshot({ path: OUT + '/3-member-view.png', fullPage: true });
    if (i % 2 === 0) {
      await pg.evaluate(() => {
        const c = document.getElementById('pad');
        const r = c.getBoundingClientRect();
        const ev = (type, x, y) => c.dispatchEvent(new PointerEvent(type, {
          bubbles: true, cancelable: true, pointerId: 1, pointerType: 'touch', clientX: r.left + x, clientY: r.top + y }));
        ev('pointerdown', 40, 110);
        for (let k = 0; k < 30; k++) ev('pointermove', 40 + k * 9, 95 + Math.sin(k / 2.5) * 45);
        ev('pointerup', 310, 100);
      });
    } else {
      await pg.click('#auto');
    }
    // 동의 체크 없이 누르면 막혀야 함
    await pg.click('#sign');
    if (i === 0) console.log('no-agree msg:', await pg.textContent('#m'));
    await pg.check('#agree');
    await pg.click('#sign');
    await pg.waitForSelector('.msg.ok');
    if (i === 1) await pg.screenshot({ path: OUT + '/4-member-done.png', fullPage: true });
    await pg.close();
  }
  const again = await phone.newPage();
  await again.goto(creds[0].link);
  await again.fill('#pw', creds[0].pw);
  await again.click('#f button');
  await again.waitForSelector('.msg.ok');
  console.log('re-login after signing, pad shown:', !!(await again.$('#pad')));

  await admin.reload();
  await admin.waitForSelector('tr.click');
  await admin.screenshot({ path: OUT + '/5-list.png' });
  await admin.click('tr.click');
  await admin.waitForSelector('.doc');
  await admin.screenshot({ path: OUT + '/6-detail.png', fullPage: true });

  await admin.click('#print');
  await admin.click('#drive');
  await admin.waitForSelector('#pm.msg');
  console.log('drive:', await admin.textContent('#pm'));
  await admin.evaluate(() => { window.print = () => { window.__printed = true; }; });
  await admin.click('#doPrint');
  await admin.waitForFunction(() => window.__printed);
  await admin.emulateMedia({ media: 'print' });
  await admin.pdf({ path: OUT + '/minutes.pdf', preferCSSPageSize: true, printBackground: true });
  await admin.emulateMedia({ media: 'screen' });

  // 서명 후 내용 수정 → 초기화 경고(confirm 자동 수락) → 서명 0명
  await admin.click('#edit');
  await admin.fill('[name=place]', '교무회의실(2층)');
  await admin.click('#save');
  await admin.waitForSelector('#print');
  console.log('after edit signed:', await admin.textContent('.card .muted'));

  console.log('errors:', errors);
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
