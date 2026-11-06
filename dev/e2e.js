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
  await f('agenda', '계약제교원 연장 계약 채용 심의');
  await f('result', '1. 사유: 방과후교사 홍길동 선생님의 휴직으로 인함(2026. 9. 1. ~ 2027. 2. 28.)\n\n2. 결과: \n  - 본교에서 계약제교사로 성실히 근무함.\n  - 학생 특성을 잘 이해하여 생활지도 및 학습지도를 잘함.\n  - 임꺽정 선생님을 연장하여 채용하기로 함.');
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
  console.log('short link:', creds[0].link);
  await admin.click('.modal [data-close]');

  // 위원 서명 (휴대폰 화면). 마지막 위원은 미서명으로 남겨 둡니다.
  const phone = await browser.newContext({ ...devices['iPhone 13'] });
  for (let i = 0; i < 8; i++) {
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
    if (i === 0) { await pg.click('#sign'); console.log('no-esign msg:', await pg.textContent('#m')); }
    await pg.check('#esign');
    if (i === 1) await (await pg.$('#signCard')).screenshot({ path: OUT + '/4-sign-card.png' });
    await pg.click('#sign');
    await pg.waitForSelector('.msg.ok', { timeout: 8000 }).catch(async (e) => {
      console.log('sign failed for member', i, ':', await pg.textContent('#m').catch(() => '?'));
      throw e;
    });
    if (i === 1) await pg.screenshot({ path: OUT + '/4-member-done.png', fullPage: true });
    await pg.close();
  }
  const bad = await phone.newPage();
  await bad.goto('http://localhost:8787/short/?ZZZZZZ');
  await bad.waitForSelector('.msg.err');
  console.log('bad code:', await bad.textContent('.msg.err'));
  const again = await phone.newPage();
  await again.goto(creds[0].link);
  await again.fill('#pw', creds[0].pw);
  await again.click('#f button');
  await again.waitForSelector('.msg.ok');
  console.log('re-login after signing, pad shown:', !!(await again.$('#pad')));

  console.log('auto-closed:', JSON.parse(await (await fetch('http://localhost:8787/__state')).text()).sheets.Meetings[1][9]);
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

  // 위변조 확인: 원본 파일은 일치, 한 글자 바꾼 파일은 불일치
  const fs = require('fs');
  const orig = Buffer.from(await (await fetch('http://localhost:8787/__pdf')).arrayBuffer());
  fs.writeFileSync(OUT + '/orig.pdf', orig);
  const forged = Buffer.from(orig); forged[forged.length - 20] ^= 1;
  fs.writeFileSync(OUT + '/forged.pdf', forged);
  const v = await browser.newPage({ viewport: { width: 600, height: 700 } });
  await v.goto(BASE + '?page=verify');
  await v.setInputFiles('#file', OUT + '/orig.pdf');
  await v.waitForSelector('#m.msg.ok');
  await v.screenshot({ path: OUT + '/8-verify-ok.png' });
  await v.setInputFiles('#file', OUT + '/forged.pdf');
  await v.waitForSelector('#m.msg.err');
  console.log('forged:', (await v.textContent('#m')).slice(0, 30));

  // 마감 상태에서는 수정 버튼이 잠김 → 다시 열고 수정하면 서명 초기화
  // 모두 서명해서 이미 자동 마감된 상태
  console.log('edit disabled when closed:', await admin.$eval('#edit', (b) => b.disabled));
  await admin.click('#toggle');
  await admin.waitForFunction(() => document.querySelector('#toggle') && document.querySelector('#toggle').textContent === '서명 마감');
  await admin.click('#edit');
  await admin.fill('[name=place]', '교무회의실(2층)');
  await admin.click('#save');
  await admin.waitForSelector('#print');
  console.log('after edit signed:', await admin.textContent('.card .muted'));

  console.log('errors:', errors);
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
