/**
 * 규정 문서 블록 → 검색용 청크 (조문 단위 구조 청킹)
 *
 *  - 본문: 1조 = 1청크. 1,000자를 넘으면 ①②항 경계에서 약 800자 이하로 나누고 조문 제목을 반복
 *  - 모든 청크 앞에 "[규정명 > 장 > 절 > 제N조(제목)]" 경로 머리글 (오버랩 역할)
 *  - 별표: 마크다운 표로 복원, 별표 1개 = 1청크 (크면 행 단위로 나누고 머리행 반복)
 *  - 부칙: type=부칙 으로 분리 (기본 검색에서 제외, 시행일·경과조치 질문 때만 검색)
 *  - 개정 이력·"(삭제)" 조문은 청크로 만들지 않음
 */
const path = require('path');

const MAX_SINGLE = 1000; // 이 길이 이하 조문은 나누지 않음
const TARGET = 800; // 나눌 때 조각당 상한
const TABLE_MAX = 1500;

const norm = (s) =>
  String(s || '')
    .replace(/ |　/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/^\s+|\s+$/g, '')
    // "제 1 조", "제 1 장" → "제1조", "제1장"
    .replace(/^제\s*(\d+)\s*(장|절|조)(?:\s*의\s*(\d+))?/, (_, n, k, e) => `제${n}${k}${e ? '의' + e : ''}`);

const RE = {
  chapter: /^제(\d+)장\s*(.*)$/,
  section: /^제(\d+)절\s*(.*)$/,
  article: /^제(\d+)조(의\d+)?\s*\(([^)]{1,40})\)\s*(.*)$/s,
  addenda: /^부\s*칙\s*(.*)$/,
  appendix: /^\[?\s*(별표|별지)\s*(?:제?\s*(\d+(?:-\d+)?(?:\s*의\s*\d+)?)\s*호?)?\s*\]?\s*(.*)$/,
  revisionLine: /(제?\s*\d+\s*차\s*개정|제\s*정)\s*:/,
  deleted: /^\(?\s*\d{4}\.\s*\d{1,2}\.\s*\d{1,2}\.?\s*삭제\s*\)?\.?$|^삭제\s*(<[^>]*>)?\.?$/,
};

/** 파일명 → 규정명, 종류, 개정일 */
function docMeta(file) {
  const base = path.basename(file).replace(/\.hwpx?$/i, '');
  const name = base.replace(/\s*\(.*\)\s*$/, '').replace(/\s+/g, '');
  const m = base.match(/\((\d{4})년도\s*(\d{1,2})월(?:\s*(\d{1,2})일)?/);
  const revised = m ? [m[1], m[2].padStart(2, '0'), m[3] ? m[3].padStart(2, '0') : null].filter(Boolean).join('-') : '';
  const kind = /시행요강/.test(name) ? '시행요강' : name === '취업규칙' ? '취업규칙' : '규정';
  // "인사관리규정시행요강" → 상위 규정명 "인사관리규정"
  const parent = name.replace(/시행요강$/, '');
  return { doc: name, docLabel: name.replace(/(규정)(시행요강)/, '$1 $2'), kind, parent, revised, file: path.basename(file) };
}

/** 표 → 마크다운 (빈 열·중복 열 정리) */
function tableMd(rows) {
  rows = rows.map((r) => r.map((c) => String(c || '').replace(/\s+/g, ' ').replace(/\|/g, '/').trim()));
  rows = rows.filter((r) => r.some(Boolean));
  if (!rows.length) return '';
  const cols = Math.max(...rows.map((r) => r.length));
  const keep = [];
  for (let k = 0; k < cols; k++) {
    if (!rows.some((r) => r[k])) continue;
    // 병합으로 바로 왼쪽 열과 모든 행이 같으면 생략
    if (keep.length && rows.every((r) => (r[k] || '') === (r[keep[keep.length - 1]] || ''))) continue;
    keep.push(k);
  }
  const R = rows.map((r) => keep.map((k) => r[k] || ''));
  if (keep.length === 1) return R.map((r) => '- ' + r[0]).join('\n');
  const line = (r) => '| ' + r.join(' | ') + ' |';
  return [line(R[0]), line(R[0].map(() => '---')), ...R.slice(1).map(line)].join('\n');
}

/** 긴 텍스트를 경계 패턴 기준으로 TARGET 이하 조각으로 */
function splitBy(text, boundary, limit) {
  const lines = text.split('\n');
  const parts = [];
  let cur = [];
  const flush = () => { if (cur.length) parts.push(cur.join('\n')); cur = []; };
  for (const l of lines) {
    if (boundary.test(l) && cur.join('\n').length + l.length > limit) flush();
    cur.push(l);
  }
  flush();
  return parts;
}
function splitLong(text, limit = TARGET) {
  if (text.length <= limit) return [text];
  // 1) 항(①②…) 2) 호(1. 2. …) 3) 문장
  let parts = splitBy(text, /^\s*[①-⑳]/, limit);
  parts = parts.flatMap((p) => (p.length > limit * 1.3 ? splitBy(p, /^\s*(\d+\.|[가-하]\.)\s/, limit) : [p]));
  parts = parts.flatMap((p) => {
    if (p.length <= limit * 1.3) return [p];
    const out = [];
    let buf = '';
    for (const s of p.split(/(?<=[.다])\s+/)) {
      if (buf && buf.length + s.length > limit) { out.push(buf); buf = ''; }
      buf += (buf ? ' ' : '') + s;
    }
    if (buf) out.push(buf);
    return out;
  });
  return parts;
}

function splitTable(md, limit = TABLE_MAX) {
  if (md.length <= limit || !md.startsWith('|')) return [md];
  const [h, sep, ...rows] = md.split('\n');
  const out = [];
  let cur = [];
  for (const r of rows) {
    if (cur.length && [h, sep, ...cur, r].join('\n').length > limit) { out.push([h, sep, ...cur].join('\n')); cur = []; }
    cur.push(r);
  }
  if (cur.length) out.push([h, sep, ...cur].join('\n'));
  return out;
}

function chunkDocument(blocks, file) {
  const meta = docMeta(file);
  const units = []; // { type, chapter, section, articleNo, articleTitle, label, lines: [] }
  let chapter = '', section = '';
  let cur = null;
  let started = false;
  let zone = '본문'; // 본문 → 부칙 → 별표/별지
  let addendaNo = 0;

  const open = (u) => { cur = { chapter, section, lines: [], ...u }; units.push(cur); };

  for (const b of blocks) {
    if (b.type === 'table') {
      if (!started) continue; // 표지·개정 이력 표
      const md = tableMd(b.rows);
      if (md && cur) cur.lines.push(md);
      continue;
    }
    for (const raw of String(b.text).split('\n')) {
      const t = norm(raw);
      if (!t) continue;
      if (!started) {
        if (RE.chapter.test(t) || RE.article.test(t)) started = true;
        else continue;
      }
      if (RE.revisionLine.test(t) && t.length < 120) continue;

      let m;
      if (zone === '본문' && (m = t.match(RE.chapter))) { chapter = `제${m[1]}장 ${m[2]}`.trim(); section = ''; cur = null; continue; }
      if (zone === '본문' && (m = t.match(RE.section))) { section = `제${m[1]}절 ${m[2]}`.trim(); cur = null; continue; }
      if ((m = t.match(RE.addenda)) && t.length < 60) {
        zone = '부칙';
        addendaNo++;
        chapter = '부칙'; section = '';
        open({ type: '부칙', label: `부칙 ${m[1] || ''}`.trim(), articleNo: '', articleTitle: m[1] || '' });
        continue;
      }
      if ((m = t.match(RE.appendix)) && t.length < 80 && /^\[|^별(표|지)\s*(제?\s*)?\d/.test(t)) {
        zone = m[1];
        chapter = ''; section = '';
        const no = m[2] ? `${m[1]} ${m[2].replace(/\s+/g, '')}` : m[1];
        const title = (m[3] || '').replace(/^서식\s*\]?\s*/, '').trim();
        open({ type: m[1], label: `[${no}] ${title}`.trim(), articleNo: no, articleTitle: title });
        continue;
      }
      if ((m = t.match(RE.article))) {
        const no = `제${m[1]}조${m[2] || ''}`;
        const title = m[3].trim();
        if (zone === '부칙' && cur && cur.type === '부칙') { cur.lines.push(t); continue; } // 부칙 안의 조문은 부칙 블록에 포함
        if (zone !== '본문') zone = '본문';
        open({ type: '본문', articleNo: no, articleTitle: title, label: `${no}(${title})` });
        cur.lines.push(t);
        continue;
      }
      if (cur) cur.lines.push(t);
    }
  }

  const chunks = [];
  for (const u of units) {
    let body = u.lines.join('\n').trim();
    if (!body) continue;
    if (u.type === '본문') {
      const rest = body.replace(/^제\d+조(의\d+)?\s*\([^)]*\)\s*/, '').trim();
      if (!rest || RE.deleted.test(rest)) continue; // 삭제된 조문
    }
    const pathParts = [meta.docLabel, u.chapter, u.section, u.label].filter(Boolean);
    const header = `[${pathParts.join(' > ')}]`;
    let pieces;
    if (u.type === '별표' || u.type === '별지') {
      // 표 단위로 나누되, 표 밖 설명문은 앞 조각에 붙임
      pieces = [];
      let buf = '';
      for (const seg of body.split(/\n(?=\| )|(?<=\|)\n(?!\|)/)) {
        for (const s of seg.startsWith('|') ? splitTable(seg) : splitLong(seg, TABLE_MAX)) {
          if (buf && buf.length + s.length > TABLE_MAX) { pieces.push(buf); buf = ''; }
          buf += (buf ? '\n' : '') + s;
        }
      }
      if (buf) pieces.push(buf);
    } else pieces = body.length <= MAX_SINGLE ? [body] : splitLong(body);

    pieces.forEach((text, i) => {
      const part = pieces.length > 1 ? ` (${i + 1}/${pieces.length})` : '';
      chunks.push({
        doc: meta.doc,
        docLabel: meta.docLabel,
        kind: meta.kind,
        parent: meta.parent,
        revised: meta.revised,
        file: meta.file,
        type: u.type,
        chapter: u.chapter || '',
        section: u.section || '',
        articleNo: u.articleNo || '',
        articleTitle: u.articleTitle || '',
        label: u.label + part,
        part: i + 1,
        parts: pieces.length,
        header,
        text,
        // 임베딩·키워드 검색에 쓰는 본문 (머리글 포함)
        content: `${header}${part}\n${i > 0 && u.type === '본문' ? u.label + ' (이어서)\n' : ''}${text}`,
      });
    });
  }
  return { meta, chunks };
}

module.exports = { chunkDocument, docMeta, tableMd };
