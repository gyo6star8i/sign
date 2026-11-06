// 로컬 테스트용 서버: Google Apps Script 서비스를 메모리로 흉내 내 Code.gs / Index.html을 실행합니다.
// 실행: node dev/server.js  → http://localhost:8787/exec
const http = require('http');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const SRC = path.join(__dirname, '..', 'src');
const PORT = Number(process.env.PORT || 8787);
const BASE = `http://localhost:${PORT}/exec`;

// ── 가짜 스프레드시트 ──
function makeSheet(name) {
  const rows = [];
  return {
    _rows: rows, name,
    getLastRow: () => rows.length,
    setFrozenRows() {},
    deleteRow(r) { rows.splice(r - 1, 1); },
    getRange(r, c, nr = 1, nc = 1) {
      return {
        setNumberFormat() { return this; },
        setValues(vals) {
          for (let i = 0; i < nr; i++) {
            rows[r - 1 + i] = rows[r - 1 + i] || [];
            for (let j = 0; j < nc; j++) {
              let v = vals[i][j];
              if (typeof v === 'string' && v.length > 50000) throw new Error('셀 한도 5만 자 초과');
              if (typeof v === 'string' && /^'/.test(v)) v = v.slice(1); // 시트처럼 ' 접두어 제거
              rows[r - 1 + i][c - 1 + j] = v;
            }
          }
          return this;
        },
        getValues() {
          const out = [];
          for (let i = 0; i < nr; i++) {
            const row = rows[r - 1 + i] || [];
            out.push(Array.from({ length: nc }, (_, j) => (row[c - 1 + j] === undefined ? '' : row[c - 1 + j])));
          }
          return out;
        },
      };
    },
  };
}
const sheets = {};
const ss = {
  getSheetByName: (n) => sheets[n] || null,
  insertSheet: (n) => (sheets[n] = makeSheet(n)),
  getId: () => 'fake-ss',
};
const props = {};
const cache = new Map();
const drive = {};

const gas = {
  SpreadsheetApp: { getActiveSpreadsheet: () => ss },
  PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = String(v); } }) },
  CacheService: { getScriptCache: () => ({
    get: (k) => { const e = cache.get(k); return e && e.exp > Date.now() ? e.v : null; },
    put: (k, v, ttl) => cache.set(k, { v: String(v), exp: Date.now() + (ttl || 600) * 1000 }),
    remove: (k) => cache.delete(k),
  }) },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  Utilities: {
    DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
    computeDigest: (alg, s) => Array.from(crypto.createHash(alg).update(String(s), 'utf8').digest()).map((b) => (b > 127 ? b - 256 : b)),
    getUuid: () => crypto.randomUUID(),
    formatDate: (d) => new Date(d.getTime() + 9 * 3600e3).toISOString().replace('T', ' ').slice(0, 19),
  },
  Session: { getScriptTimeZone: () => 'Asia/Seoul' },
  ScriptApp: { getService: () => ({ getUrl: () => BASE }) },
  HtmlService: {
    createTemplateFromFile: (f) => {
      const t = { evaluate() {
        const html = fs.readFileSync(path.join(SRC, f + '.html'), 'utf8').replace(/<\?!=\s*(\w+)\s*\?>/g, (_, k) => t[k]);
        const o = { setTitle: () => o, addMetaTag: () => o, getContent: () => html };
        return o;
      } };
      return t;
    },
    createHtmlOutput: (html) => ({ getBlob: () => ({ getAs: () => ({ setName(n) { this.name = n; this.html = html; return this; } }) }) }),
  },
  DriveApp: {
    createFolder: () => ({ getId: () => 'folder1', createFile: (b) => { drive[b.name] = b.html; return { getUrl: () => 'https://drive.example/' + encodeURIComponent(b.name), getName: () => b.name }; } }),
    getFolderById: () => gas.DriveApp.createFolder(),
  },
  console,
};
const ctx = vm.createContext(gas);
vm.runInContext(fs.readFileSync(path.join(SRC, 'Code.gs'), 'utf8') + '\n;globalThis.__api = api; globalThis.__doGet = doGet;', ctx);

const SHIM = `<script>
window.google = { script: { run: (function mk(ok, fail) {
  return { withSuccessHandler: (f) => mk(f, fail), withFailureHandler: (f) => mk(ok, f),
    api: (a, p) => fetch('/api', { method: 'POST', body: JSON.stringify({ a, p }) }).then((r) => r.json()).then(ok, fail) };
})() } };
</script>`;

http.createServer((req, res) => {
  const url = new URL(req.url, BASE);
  if (req.method === 'POST' && url.pathname === '/api') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { a, p } = JSON.parse(body);
      const out = ctx.__api(a, JSON.parse(JSON.stringify(p)));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    });
    return;
  }
  if (url.pathname === '/exec') {
    const html = ctx.__doGet({ parameter: Object.fromEntries(url.searchParams) }).getContent();
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html.replace('<head>', '<head>' + SHIM));
    return;
  }
  if (url.pathname === '/__state') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ sheets: Object.fromEntries(Object.entries(sheets).map(([k, v]) => [k, v._rows])), drive: Object.keys(drive) }));
    return;
  }
  res.writeHead(404); res.end();
}).listen(PORT, () => console.log('dev server ' + BASE));
