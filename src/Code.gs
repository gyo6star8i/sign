/**
 * 인사자문위원회 회의록 전자서명 시스템 (Google Apps Script)
 *
 * - 관리자: 회의록(일시/장소/위원/안건/회의결과)과 위원 명단을 입력하고, 위원별 접속 비밀번호를 발급합니다.
 * - 위원: 받은 링크와 비밀번호로 접속해 회의록을 확인하고 서명 후 '동의'를 누릅니다.
 * - 관리자: 서명이 모두 모이면 회의록을 PDF로 출력합니다.
 *
 * 데이터는 이 스크립트가 연결된 구글 시트의 Meetings / Members / Log 시트에 저장됩니다.
 */

const SHEETS = {
  MEETINGS: {
    name: 'Meetings',
    headers: ['id', 'title', 'datetime', 'place', 'committee', 'agenda', 'result',
      'confirmDate', 'school', 'status', 'createdAt', 'updatedAt'],
  },
  MEMBERS: {
    name: 'Members',
    headers: ['meetingId', 'memberId', 'order', 'role', 'position', 'name',
      'pwHash', 'salt', 'signedAt', 'signature', 'docHash', 'failCount'],
  },
  LOG: {
    name: 'Log',
    headers: ['time', 'meetingId', 'memberId', 'action', 'detail'],
  },
  PDFS: {
    name: 'Pdfs',
    headers: ['meetingId', 'fileId', 'name', 'sha256', 'docHash', 'createdAt'],
  },
};

const MEETING_FIELDS = ['title', 'datetime', 'place', 'committee', 'agenda', 'result', 'confirmDate', 'school'];
const ADMIN_TTL = 6 * 60 * 60;   // 관리자 로그인 유지: 6시간
const MEMBER_TTL = 2 * 60 * 60;  // 위원 로그인 유지: 2시간
const MAX_MEMBER_FAILS = 5;      // 위원 비밀번호 5회 틀리면 잠금
const MAX_SIGNATURE_CHARS = 45000; // 시트 셀 한도(5만 자) 안쪽

// ───────────────────────── 웹앱 진입점 ─────────────────────────

function doGet(e) {
  const params = (e && e.parameter) || {};
  const t = HtmlService.createTemplateFromFile('Index');
  t.boot = JSON.stringify({
    params: { page: params.page || '', m: params.m || '', u: params.u || '' },
    appUrl: ScriptApp.getService().getUrl(),
  }).replace(/</g, '\\u003c');
  return t.evaluate()
    .setTitle('회의록 전자서명')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** 화면에서 google.script.run.api(action, payload)로 호출하는 단일 창구 */
function api(action, payload) {
  try {
    const fn = ACTIONS[action];
    if (!fn) throw new Error('알 수 없는 요청입니다.');
    return { ok: true, data: fn(payload || {}) };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err), code: err && err.code };
  }
}

const ACTIONS = {
  // 관리자
  adminStatus: () => ({ hasPassword: !!getProp('ADMIN_PW_HASH') }),
  adminSetup,
  adminLogin,
  listMeetings,
  getMeeting,
  saveMeeting,
  deleteMeeting,
  setMeetingStatus,
  reissuePassword,
  resetSignature,
  savePdf,
  verifyPdf,
  // 위원
  getPublicMeeting,
  memberLogin,
  memberSign,
};

// ───────────────────────── 관리자 ─────────────────────────

function adminSetup(p) {
  return withLock(() => {
    if (getProp('ADMIN_PW_HASH')) throw new Error('관리자 비밀번호가 이미 설정되어 있습니다.');
    const pw = String(p.password || '');
    if (pw.length < 6) throw new Error('비밀번호는 6자 이상으로 정해 주세요.');
    const salt = newId();
    setProp('ADMIN_PW_SALT', salt);
    setProp('ADMIN_PW_HASH', hash(salt, pw));
    log('', '', 'admin-setup', '');
    return { token: issueToken('adm', '1', ADMIN_TTL) };
  });
}

function adminLogin(p) {
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('adm-fails') || 0);
  if (fails >= 10) throw new Error('로그인 시도가 너무 많습니다. 10분 뒤 다시 시도해 주세요.');
  const salt = getProp('ADMIN_PW_SALT');
  if (!salt || hash(salt, String(p.password || '')) !== getProp('ADMIN_PW_HASH')) {
    cache.put('adm-fails', String(fails + 1), 600);
    throw new Error('비밀번호가 올바르지 않습니다.');
  }
  cache.remove('adm-fails');
  return { token: issueToken('adm', '1', ADMIN_TTL) };
}

function requireAdmin(p) {
  if (!p.token || !readToken('adm', p.token)) {
    const err = new Error('관리자 로그인이 만료되었습니다. 다시 로그인해 주세요.');
    err.code = 'AUTH';
    throw err;
  }
}

function listMeetings(p) {
  requireAdmin(p);
  const members = readAll(SHEETS.MEMBERS);
  return readAll(SHEETS.MEETINGS)
    .map((m) => {
      const ms = members.filter((x) => x.meetingId === m.id);
      return {
        id: m.id, title: m.title, datetime: m.datetime, confirmDate: m.confirmDate,
        status: m.status, createdAt: m.createdAt,
        total: ms.length, signed: ms.filter((x) => x.signedAt).length,
      };
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

function getMeeting(p) {
  requireAdmin(p);
  const meeting = findMeeting(p.id);
  const members = membersOf(p.id).map((m) => ({
    memberId: m.memberId, order: Number(m.order), role: m.role, position: m.position, name: m.name,
    signedAt: m.signedAt, signature: m.signature, docHash: m.docHash,
    locked: Number(m.failCount || 0) >= MAX_MEMBER_FAILS,
  }));
  const logs = readAll(SHEETS.LOG).filter((l) => l.meetingId === p.id)
    .map((l) => ({ time: l.time, memberId: l.memberId, action: l.action, detail: l.detail }));
  const pdfs = readAll(SHEETS.PDFS).filter((x) => x.meetingId === p.id)
    .map((x) => ({ name: x.name, sha256: x.sha256, createdAt: x.createdAt, url: 'https://drive.google.com/file/d/' + x.fileId + '/view' }));
  return { meeting: publicMeeting(meeting), members, logs, pdfs, docHash: docHash(meeting, members) };
}

/**
 * 회의록 저장(새로 만들기/수정).
 * 새로 추가된 위원에게는 비밀번호를 발급해 돌려줍니다(평문은 이때만 확인 가능).
 * 이미 서명이 있는 회의록의 내용을 바꾸면, 위원들이 다른 내용에 서명한 셈이 되므로 서명을 모두 초기화합니다.
 */
function saveMeeting(p) {
  requireAdmin(p);
  return withLock(() => {
    const input = p.meeting || {};
    const inputMembers = (p.members || [])
      .map((m) => ({
        memberId: m.memberId || '',
        role: clean(m.role), position: clean(m.position), name: clean(m.name),
      }))
      .filter((m) => m.name || m.role || m.position);
    if (!clean(input.title)) throw new Error('회의록 제목을 입력해 주세요.');
    if (inputMembers.length === 0) throw new Error('위원을 한 명 이상 입력해 주세요.');
    if (inputMembers.some((m) => !m.name)) throw new Error('위원 성명을 모두 입력해 주세요.');

    const now = nowStr();
    const isNew = !input.id;
    let meeting;
    if (isNew) {
      meeting = { id: newId(), status: 'open', createdAt: now };
    } else {
      meeting = findMeeting(input.id);
      if (meeting.status === 'closed') {
        throw new Error('마감된 회의록은 수정할 수 없습니다. 먼저 [서명 다시 열기]를 눌러 주세요.');
      }
    }
    const before = isNew ? null : docHash(meeting, membersOf(meeting.id));
    MEETING_FIELDS.forEach((f) => { meeting[f] = cleanMultiline(input[f]); });
    meeting.updatedAt = now;

    const existing = isNew ? [] : membersOf(meeting.id);
    const existingById = {};
    existing.forEach((m) => { existingById[m.memberId] = m; });

    const issued = [];
    const pendingLogs = [];
    const nextMembers = inputMembers.map((m, i) => {
      const prev = m.memberId && existingById[m.memberId];
      if (prev) {
        return Object.assign({}, prev, { order: i + 1, role: m.role, position: m.position, name: m.name });
      }
      const pw = newPassword();
      const salt = newId();
      const row = {
        meetingId: meeting.id, memberId: newId(), order: i + 1,
        role: m.role, position: m.position, name: m.name,
        pwHash: hash(salt, pw), salt, signedAt: '', signature: '', docHash: '', failCount: 0,
      };
      issued.push({ memberId: row.memberId, name: row.name, password: pw });
      pendingLogs.push([row.memberId, 'issue-password', row.name]);
      return row;
    });

    const after = docHash(meeting, nextMembers);
    const signedCount = existing.filter((m) => m.signedAt).length;
    let signaturesReset = false;
    if (!isNew && before !== after && signedCount > 0) {
      if (!p.confirmReset) {
        const err = new Error(`이미 ${signedCount}명이 서명했습니다. 내용을 바꾸면 서명이 모두 초기화됩니다.`);
        err.code = 'SIGNED_EXISTS';
        throw err;
      }
      nextMembers.forEach((m) => { m.signedAt = ''; m.signature = ''; m.docHash = ''; });
      signaturesReset = true;
    }

    upsertRow(SHEETS.MEETINGS, 'id', meeting);
    replaceMembers(meeting.id, nextMembers);
    log(meeting.id, '', isNew ? 'create' : 'update',
      signaturesReset ? '내용 변경으로 서명 초기화' : '');
    pendingLogs.forEach((l) => log(meeting.id, l[0], l[1], l[2]));
    return { id: meeting.id, issued, signaturesReset };
  });
}

function deleteMeeting(p) {
  requireAdmin(p);
  return withLock(() => {
    findMeeting(p.id);
    deleteRowsWhere(SHEETS.MEETINGS, (r) => r.id === p.id);
    deleteRowsWhere(SHEETS.MEMBERS, (r) => r.meetingId === p.id);
    log(p.id, '', 'delete', '');
    return true;
  });
}

function setMeetingStatus(p) {
  requireAdmin(p);
  return withLock(() => {
    const meeting = findMeeting(p.id);
    if (p.status !== 'open' && p.status !== 'closed') throw new Error('잘못된 상태 값입니다.');
    meeting.status = p.status;
    meeting.updatedAt = nowStr();
    upsertRow(SHEETS.MEETINGS, 'id', meeting);
    log(p.id, '', p.status === 'closed' ? 'close' : 'reopen', '');
    return true;
  });
}

function reissuePassword(p) {
  requireAdmin(p);
  return withLock(() => {
    const member = findMember(p.meetingId, p.memberId);
    const pw = newPassword();
    member.salt = newId();
    member.pwHash = hash(member.salt, pw);
    member.failCount = 0;
    updateMember(member);
    log(p.meetingId, p.memberId, 'reissue-password', member.name);
    return { memberId: member.memberId, name: member.name, password: pw };
  });
}

function resetSignature(p) {
  requireAdmin(p);
  return withLock(() => {
    const member = findMember(p.meetingId, p.memberId);
    member.signedAt = '';
    member.signature = '';
    member.docHash = '';
    updateMember(member);
    log(p.meetingId, p.memberId, 'reset-signature', member.name);
    return true;
  });
}

/** 화면에서 만든 회의록 HTML을 PDF로 바꿔 구글 드라이브에 저장합니다. */
function savePdf(p) {
  requireAdmin(p);
  const meeting = findMeeting(p.meetingId);
  const html = String(p.html || '');
  if (!html) throw new Error('PDF로 만들 내용이 없습니다.');
  const date = String(meeting.confirmDate || nowStr().slice(0, 10)).replace(/\.\s*$/, '');
  const name = `${meeting.title || '회의록'}_${date}.pdf`
    .replace(/[\\/:*?"<>|]/g, '_');
  const blob = HtmlService.createHtmlOutput(html).getBlob().getAs('application/pdf').setName(name);
  const folder = getPdfFolder();
  const file = folder.createFile(blob);
  // 원본 확인용 지문: 나중에 누가 PDF 파일을 올리면 이 값과 비교해 위변조 여부를 확인합니다.
  const sha256 = toHex(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, blob.getBytes()));
  const dh = docHash(meeting, membersOf(meeting.id));
  appendObj(getSheet(SHEETS.PDFS), SHEETS.PDFS,
    { meetingId: meeting.id, fileId: file.getId(), name: file.getName(), sha256, docHash: dh, createdAt: nowStr() });
  log(meeting.id, '', 'save-pdf', `${file.getName()} / 파일확인값 ${sha256.slice(0, 16)}`);
  return { url: file.getUrl(), name: file.getName(), sha256 };
}

/** 위변조 검증: 올린 PDF 파일의 SHA-256 값이 시스템이 저장한 원본과 같은지 확인합니다(누구나 사용 가능). */
function verifyPdf(p) {
  const sha = String(p.sha256 || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error('파일 확인값이 올바르지 않습니다.');
  const rec = readAll(SHEETS.PDFS).find((x) => x.sha256 === sha);
  if (!rec) return { match: false };
  const meeting = readAll(SHEETS.MEETINGS).find((m) => m.id === rec.meetingId);
  return {
    match: true, name: rec.name, createdAt: rec.createdAt,
    title: meeting ? meeting.title : '(삭제된 회의록)', school: meeting ? meeting.school : '',
    confirmDate: meeting ? meeting.confirmDate : '',
    signers: meeting ? membersOf(meeting.id).map((m) => ({ name: m.name, role: m.role, signedAt: m.signedAt })) : [],
  };
}

function getPdfFolder() {
  const id = getProp('PDF_FOLDER_ID');
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) { /* 폴더가 지워졌으면 새로 만듭니다 */ }
  }
  const folder = DriveApp.createFolder('회의록 전자서명 PDF');
  setProp('PDF_FOLDER_ID', folder.getId());
  return folder;
}

// ───────────────────────── 위원 ─────────────────────────

/** 로그인 전 화면: 회의 제목과 위원 이름만 공개합니다. */
function getPublicMeeting(p) {
  const meeting = findMeeting(p.meetingId);
  return {
    title: meeting.title, school: meeting.school, status: meeting.status,
    members: membersOf(meeting.id).map((m) => ({ memberId: m.memberId, name: m.name, role: m.role })),
  };
}

function memberLogin(p) {
  return withLock(() => {
    const meeting = findMeeting(p.meetingId);
    const member = findMember(p.meetingId, p.memberId);
    if (Number(member.failCount || 0) >= MAX_MEMBER_FAILS) {
      throw new Error('비밀번호를 여러 번 틀려 잠겼습니다. 담당자에게 비밀번호 재발급을 요청해 주세요.');
    }
    if (hash(member.salt, String(p.password || '').trim()) !== member.pwHash) {
      member.failCount = Number(member.failCount || 0) + 1;
      updateMember(member);
      log(meeting.id, member.memberId, 'login-fail', member.name);
      const left = MAX_MEMBER_FAILS - member.failCount;
      throw new Error(left > 0
        ? `비밀번호가 올바르지 않습니다. (남은 시도 ${left}회)`
        : '비밀번호를 여러 번 틀려 잠겼습니다. 담당자에게 비밀번호 재발급을 요청해 주세요.');
    }
    if (Number(member.failCount || 0) > 0) {
      member.failCount = 0;
      updateMember(member);
    }
    log(meeting.id, member.memberId, 'login', `${member.name} / ${device(p)}`);
    const token = issueToken('mem', JSON.stringify({ meetingId: meeting.id, memberId: member.memberId }), MEMBER_TTL);
    return Object.assign({ token }, memberView(meeting, member));
  });
}

function memberSign(p) {
  const raw = p.token && readToken('mem', p.token);
  if (!raw) {
    const err = new Error('로그인이 만료되었습니다. 비밀번호를 다시 입력해 주세요.');
    err.code = 'AUTH';
    throw err;
  }
  const who = JSON.parse(raw);
  const sig = String(p.signature || '');
  if (!/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(sig)) throw new Error('서명 이미지가 올바르지 않습니다.');
  if (sig.length > MAX_SIGNATURE_CHARS) throw new Error('서명 이미지가 너무 큽니다. 다시 서명해 주세요.');

  return withLock(() => {
    const meeting = findMeeting(who.meetingId);
    if (meeting.status !== 'open') throw new Error('서명이 마감된 회의록입니다.');
    const members = membersOf(meeting.id);
    const member = members.find((m) => m.memberId === who.memberId);
    if (!member) throw new Error('위원 정보를 찾을 수 없습니다.');
    if (member.signedAt) throw new Error('이미 서명하셨습니다.');
    const h = docHash(meeting, members);
    // 위원이 화면에서 본 내용과 지금 저장된 내용이 다르면(그 사이 관리자가 수정) 서명을 받지 않습니다.
    if (p.docHash && p.docHash !== h) {
      throw new Error('회의록 내용이 그사이 수정되었습니다. 새로고침 후 다시 확인해 주세요.');
    }
    if (p.consentEsign !== true) throw new Error('전자서명 사용에 동의해 주세요.');
    member.signedAt = nowStr();
    member.signature = sig;
    member.docHash = h;
    updateMember(member);
    log(meeting.id, member.memberId, 'sign',
      `${member.name} / 내용 확인·동의, 전자서명 사용 동의 / 문서확인값 ${h.slice(0, 16)} / ${device(p)}`);
    // 모든 위원이 서명하면 자동으로 마감해 더 이상 바뀌지 않게 합니다.
    if (members.every((m) => m.memberId === member.memberId || m.signedAt)) {
      meeting.status = 'closed';
      meeting.updatedAt = nowStr();
      upsertRow(SHEETS.MEETINGS, 'id', meeting);
      log(meeting.id, '', 'auto-close', '모든 위원 서명 완료');
    }
    return memberView(meeting, member);
  });
}

function memberView(meeting, member) {
  const members = membersOf(meeting.id);
  return {
    meeting: publicMeeting(meeting),
    me: { memberId: member.memberId, name: member.name, role: member.role, position: member.position,
      signedAt: member.signedAt, signature: member.signature },
    // 다른 위원의 서명 이미지는 보여주지 않고, 서명 여부만 알려줍니다.
    members: members.map((m) => ({ memberId: m.memberId, role: m.role, position: m.position, name: m.name,
      signed: !!m.signedAt })),
    docHash: docHash(meeting, members),
  };
}

// ───────────────────────── 공통 도우미 ─────────────────────────

function publicMeeting(m) {
  const out = { id: m.id, status: m.status, createdAt: m.createdAt, updatedAt: m.updatedAt };
  MEETING_FIELDS.forEach((f) => { out[f] = m[f] || ''; });
  return out;
}

/** 회의록 내용(본문+위원 명단)의 지문. 위원이 어떤 내용에 서명했는지 확인하는 데 씁니다. */
function docHash(meeting, members) {
  const body = {
    f: MEETING_FIELDS.map((f) => String(meeting[f] || '')),
    m: members.slice().sort((a, b) => Number(a.order) - Number(b.order))
      .map((m) => [String(m.memberId), String(m.role), String(m.position), String(m.name)]),
  };
  return toHex(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, JSON.stringify(body),
    Utilities.Charset.UTF_8));
}

function findMeeting(id) {
  const m = readAll(SHEETS.MEETINGS).find((r) => r.id === id);
  if (!id || !m) throw new Error('회의록을 찾을 수 없습니다. 링크를 다시 확인해 주세요.');
  return m;
}

function membersOf(meetingId) {
  return readAll(SHEETS.MEMBERS).filter((r) => r.meetingId === meetingId)
    .sort((a, b) => Number(a.order) - Number(b.order));
}

function findMember(meetingId, memberId) {
  const m = readAll(SHEETS.MEMBERS).find((r) => r.meetingId === meetingId && r.memberId === memberId);
  if (!m) throw new Error('위원 정보를 찾을 수 없습니다.');
  return m;
}

function updateMember(member) {
  const sheet = getSheet(SHEETS.MEMBERS);
  const rows = readAll(SHEETS.MEMBERS);
  const found = rows.find((r) => r.meetingId === member.meetingId && r.memberId === member.memberId);
  if (!found) throw new Error('위원 정보를 찾을 수 없습니다.');
  writeRow(sheet, SHEETS.MEMBERS, found._row, member);
}

function replaceMembers(meetingId, members) {
  deleteRowsWhere(SHEETS.MEMBERS, (r) => r.meetingId === meetingId);
  const sheet = getSheet(SHEETS.MEMBERS);
  members.forEach((m) => appendObj(sheet, SHEETS.MEMBERS, Object.assign({}, m, { meetingId })));
}

function log(meetingId, memberId, action, detail) {
  appendObj(getSheet(SHEETS.LOG), SHEETS.LOG, { time: nowStr(), meetingId, memberId, action, detail });
}

// ── 시트 읽기/쓰기 ──

function getSpreadsheet() {
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;
  const id = getProp('SPREADSHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  const ss = SpreadsheetApp.create('회의록 전자서명 데이터');
  setProp('SPREADSHEET_ID', ss.getId());
  return ss;
}

function getSheet(def) {
  const ss = getSpreadsheet();
  let sheet = ss.getSheetByName(def.name);
  if (!sheet) {
    sheet = ss.insertSheet(def.name);
    sheet.getRange(1, 1, 1, def.headers.length).setValues([def.headers]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function readAll(def) {
  const sheet = getSheet(def);
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const values = sheet.getRange(2, 1, last - 1, def.headers.length).getValues();
  return values.map((row, i) => {
    const obj = { _row: i + 2 };
    def.headers.forEach((h, j) => {
      const v = row[j] === null || row[j] === undefined ? '' : String(row[j]);
      obj[h] = /^'[=+\-@]/.test(v) ? v.slice(1) : v; // toCells에서 붙인 ' 제거
    });
    return obj;
  });
}

function toCells(def, obj) {
  // 모든 칸을 '일반 텍스트'로 저장해 '2026. 10. 10.' 같은 값이 날짜로 바뀌지 않게 하고,
  // =, +, -, @ 로 시작하는 값이 수식으로 해석되지 않게 앞에 ' 를 붙입니다.
  return def.headers.map((h) => {
    const v = obj[h] === undefined || obj[h] === null ? '' : String(obj[h]);
    return /^[=+\-@]/.test(v) ? "'" + v : v;
  });
}

function writeRow(sheet, def, rowNum, obj) {
  const range = sheet.getRange(rowNum, 1, 1, def.headers.length);
  range.setNumberFormat('@');
  range.setValues([toCells(def, obj)]);
}

function appendObj(sheet, def, obj) {
  writeRow(sheet, def, sheet.getLastRow() + 1, obj);
}

function upsertRow(def, key, obj) {
  const sheet = getSheet(def);
  const found = readAll(def).find((r) => r[key] === obj[key]);
  if (found) writeRow(sheet, def, found._row, obj);
  else appendObj(sheet, def, obj);
}

function deleteRowsWhere(def, pred) {
  const sheet = getSheet(def);
  const rows = readAll(def).filter(pred).map((r) => r._row).sort((a, b) => b - a);
  rows.forEach((r) => sheet.deleteRow(r));
}

// ── 기타 ──

function withLock(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function issueToken(kind, value, ttl) {
  const token = newId() + newId();
  CacheService.getScriptCache().put(`${kind}:${token}`, value, ttl);
  return token;
}

function readToken(kind, token) {
  return CacheService.getScriptCache().get(`${kind}:${token}`);
}

function hash(salt, pw) {
  return toHex(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, `${salt}:${pw}`, Utilities.Charset.UTF_8));
}

function toHex(bytes) {
  return bytes.map((b) => ((b < 0 ? b + 256 : b).toString(16)).padStart(2, '0')).join('');
}

function newId() {
  return Utilities.getUuid().replace(/-/g, '');
}

/** 6자리 숫자 비밀번호 */
function newPassword() {
  const n = parseInt(Utilities.getUuid().replace(/-/g, '').slice(0, 12), 16) % 1000000;
  return String(n).padStart(6, '0');
}

function nowStr() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss');
}

function clean(v) {
  return String(v === undefined || v === null ? '' : v).replace(/\s+/g, ' ').trim();
}

function cleanMultiline(v) {
  return String(v === undefined || v === null ? '' : v).replace(/\r\n?/g, '\n').replace(/\s+$/, '');
}

/** 위원이 사용한 기기 정보(브라우저가 알려주는 값, 최대 200자) */
function device(p) {
  return clean(p.device || '알 수 없음').slice(0, 200);
}

function getProp(k) { return PropertiesService.getScriptProperties().getProperty(k); }
function setProp(k, v) { PropertiesService.getScriptProperties().setProperty(k, v); }
