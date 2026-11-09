/**
 * HWP(5.0) / HWPX 문서 → 블록 목록
 *   { type: 'p', text }                      일반 문단
 *   { type: 'table', rows: [[셀, ...], ...] } 표 (병합 셀은 값을 복제해 각 행이 독립적으로 읽히도록)
 * 1x1 표(제목 상자 등)는 표가 아니라 문단으로 풉니다.
 */
const fs = require('fs');
const zlib = require('zlib');
const CFB = require('cfb');
const JSZip = require('jszip');

// HWP 레코드 태그 (HWPTAG_BEGIN = 16)
const T = { PARA_HEADER: 66, PARA_TEXT: 67, CTRL_HEADER: 71, LIST_HEADER: 72, TABLE: 77 };
// 8 WCHAR(16바이트)를 차지하는 인라인/확장 제어문자
const WIDE_CTRL = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);

function paraText(b) {
  let s = '';
  for (let i = 0; i + 1 < b.length; ) {
    const c = b.readUInt16LE(i);
    if (c < 32) {
      if (WIDE_CTRL.has(c)) { if (c === 9) s += '\t'; i += 16; continue; }
      if (c === 10) s += '\n';
      i += 2;
      continue;
    }
    s += String.fromCharCode(c);
    i += 2;
  }
  return s;
}

/** 표 셀 목록 → 2차원 배열 (병합 셀 값 복제) */
function grid(table) {
  const rows = table.rows || Math.max(0, ...table.cells.map((c) => c.row + c.rs));
  const cols = table.cols || Math.max(0, ...table.cells.map((c) => c.col + c.cs));
  const g = Array.from({ length: rows }, () => new Array(cols).fill(''));
  for (const c of table.cells) {
    const text = c.texts.map((t) => t.trim()).filter(Boolean).join(' / ');
    for (let r = c.row; r < Math.min(rows, c.row + c.rs); r++)
      for (let k = c.col; k < Math.min(cols, c.col + c.cs); k++) g[r][k] = text;
  }
  return g;
}

/** 완성된 표를 상위(본문 또는 상위 표의 셀)에 내보냄 */
function emitTable(table, sink) {
  const isBox = table.cells.length <= 1;
  if (isBox) {
    for (const c of table.cells) for (const t of c.texts) sink.para(t);
    return;
  }
  sink.table(grid(table));
}

function hwpBlocks(file) {
  const cfb = CFB.read(fs.readFileSync(file), { type: 'buffer' });
  const hdr = Buffer.from(CFB.find(cfb, 'Root Entry/FileHeader').content);
  if (hdr.readUInt32LE(36) & 2) throw new Error('암호화된 HWP 문서는 지원하지 않습니다: ' + file);
  const compressed = (hdr.readUInt32LE(36) & 1) === 1;
  const blocks = [];
  const stack = []; // 열린 표들 { lvl, rows, cols, cells, cur }

  const sinkFor = (depth) => ({
    para: (t) => {
      if (depth < 0) blocks.push({ type: 'p', text: t });
      else stack[depth].cur && stack[depth].cur.texts.push(t);
    },
    table: (rows) => {
      if (depth < 0) blocks.push({ type: 'table', rows });
      else stack[depth].cur && stack[depth].cur.texts.push(rows.map((r) => r.join(' / ')).join(' ; ')); // 중첩 표는 셀 안에 평문으로
    },
  });
  const closeTablesAtOrAbove = (lvl) => {
    while (stack.length && stack[stack.length - 1].lvl >= lvl) {
      const t = stack.pop();
      emitTable(t, sinkFor(stack.length - 1));
    }
  };

  for (let i = 0; ; i++) {
    const e = CFB.find(cfb, 'Root Entry/BodyText/Section' + i);
    if (!e) break;
    let buf = Buffer.from(e.content);
    if (compressed) buf = zlib.inflateRawSync(buf);
    let p = 0;
    while (p + 4 <= buf.length) {
      const h = buf.readUInt32LE(p);
      p += 4;
      const tag = h & 0x3ff;
      const lvl = (h >>> 10) & 0x3ff;
      let size = h >>> 20;
      if (size === 0xfff) { size = buf.readUInt32LE(p); p += 4; }
      const d = buf.subarray(p, p + size);
      p += size;

      if (tag === T.PARA_HEADER) closeTablesAtOrAbove(lvl);
      else if (tag === T.CTRL_HEADER && size >= 4 && Buffer.from(d.subarray(0, 4)).reverse().toString('latin1') === 'tbl ') {
        stack.push({ lvl, rows: 0, cols: 0, cells: [], cur: null });
      } else if (tag === T.TABLE && stack.length && size >= 8) {
        const t = stack[stack.length - 1];
        t.rows = d.readUInt16LE(4);
        t.cols = d.readUInt16LE(6);
      } else if (tag === T.LIST_HEADER && stack.length && lvl === stack[stack.length - 1].lvl + 1 && size >= 16) {
        const t = stack[stack.length - 1];
        t.cur = { col: d.readUInt16LE(8), row: d.readUInt16LE(10), cs: d.readUInt16LE(12) || 1, rs: d.readUInt16LE(14) || 1, texts: [] };
        t.cells.push(t.cur);
      } else if (tag === T.PARA_TEXT) {
        const text = paraText(d);
        // 가장 안쪽의 열린 표 중, 이 문단이 속한 표
        let depth = stack.length - 1;
        while (depth >= 0 && lvl <= stack[depth].lvl + 1) depth--;
        sinkFor(depth).para(text);
      }
    }
  }
  closeTablesAtOrAbove(0);
  return blocks;
}

const unxml = (s) => s.replace(/<hp:tab\b[^>]*\/>/g, '\t').replace(/<hp:lineBreak\b[^>]*\/>/g, '\n').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

/**
 * 변경 추적 처리
 *  accept: 삭제 표시 구간의 글자를 버리고 삽입은 유지 → 현행(변경 수락) 문서
 *  reject: 삽입 표시 구간의 글자를 버리고 삭제는 유지 → 변경 전(이전 판) 문서
 * 태그 구조(문단·표)는 그대로 두고 글자만 지움
 */
function applyTrackChanges(xml, mode) {
  const drop = mode === 'reject' ? /<hp:insertBegin\b[^>]*\/>[\s\S]*?<hp:insertEnd\b[^>]*\/>/g : /<hp:deleteBegin\b[^>]*\/>[\s\S]*?<hp:deleteEnd\b[^>]*\/>/g;
  return xml.replace(drop, (span) => span.replace(/>[^<]+</g, '><'));
}

/** HWPX에 변경 추적(삽입·삭제 표시)이 남아 있는지 */
async function hasTrackChanges(file) {
  if (!/\.hwpx$/i.test(file)) return false;
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  for (const n of Object.keys(zip.files).filter((x) => /Contents\/section\d+\.xml$/.test(x))) {
    if (/<hp:(insert|delete)Begin\b/.test(await zip.file(n).async('string'))) return true;
  }
  return false;
}

async function hwpxBlocks(file, { trackChanges = 'accept' } = {}) {
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const names = Object.keys(zip.files)
    .filter((n) => /Contents\/section\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/(\d+)\.xml$/)[1]) - Number(b.match(/(\d+)\.xml$/)[1]));
  const blocks = [];
  for (const n of names) {
    // 변경 추적: 기본은 "변경 내용 수락" 상태로 읽음
    const xml = applyTrackChanges(await zip.file(n).async('string'), trackChanges);
    const stack = []; // 표
    const paras = []; // 문단 스택(표 안에 문단, 그 안에 표...)
    const sink = () => {
      const t = stack[stack.length - 1];
      return {
        para: (s) => (t ? t.cur && t.cur.texts.push(s) : blocks.push({ type: 'p', text: s })),
        table: (rows) => (t ? t.cur && t.cur.texts.push(rows.map((r) => r.join(' / ')).join(' ; ')) : blocks.push({ type: 'table', rows })),
      };
    };
    const tok = /<hp:tbl\b([^>]*)>|<\/hp:tbl>|<hp:tc\b[^>]*>|<hp:cellAddr\b([^>]*)\/>|<hp:cellSpan\b([^>]*)\/>|<hp:p\b[^>]*>|<\/hp:p>|<hp:t(?:\s[^>]*[^/>])?>([\s\S]*?)<\/hp:t>|<hp:tab\b[^>]*\/>|<hp:lineBreak\b[^>]*\/>/g;
    const attr = (s, k) => Number((s.match(new RegExp(k + '="(\\d+)"')) || [])[1] || 0);
    let m;
    while ((m = tok.exec(xml))) {
      const t = m[0];
      if (t.startsWith('<hp:tbl')) {
        // 표가 열리기 전까지 모은 문단 텍스트는 그대로 둔다 (문단은 </hp:p>에서 배출)
        stack.push({ rows: attr(m[1], 'rowCnt'), cols: attr(m[1], 'colCnt'), cells: [], cur: null, paraDepth: paras.length });
      } else if (t === '</hp:tbl>') {
        const tb = stack.pop();
        emitTable(tb, sink());
      } else if (t.startsWith('<hp:tc')) {
        const tb = stack[stack.length - 1];
        tb.cur = { row: 0, col: 0, rs: 1, cs: 1, texts: [] };
        tb.cells.push(tb.cur);
      } else if (t.startsWith('<hp:cellAddr')) {
        const c = stack[stack.length - 1].cur;
        c.col = attr(m[2], 'colAddr');
        c.row = attr(m[2], 'rowAddr');
      } else if (t.startsWith('<hp:cellSpan')) {
        const c = stack[stack.length - 1].cur;
        c.cs = attr(m[3], 'colSpan') || 1;
        c.rs = attr(m[3], 'rowSpan') || 1;
      } else if (t.startsWith('<hp:p') && !t.startsWith('<hp:pa')) {
        paras.push({ text: '', tables: stack.length });
      } else if (t === '</hp:p>') {
        const pp = paras.pop();
        if (pp && pp.tables === stack.length) sink().para(pp.text);
      } else if (t.startsWith('<hp:tab')) {
        if (paras.length) paras[paras.length - 1].text += '\t';
      } else if (t.startsWith('<hp:lineBreak')) {
        if (paras.length) paras[paras.length - 1].text += '\n';
      } else if (m[4] != null && paras.length) {
        paras[paras.length - 1].text += unxml(m[4]);
      }
    }
  }
  return blocks;
}

async function parseFile(file, opts = {}) {
  if (/\.hwpx$/i.test(file)) return hwpxBlocks(file, opts);
  if (/\.hwp$/i.test(file)) return hwpBlocks(file);
  throw new Error('지원하지 않는 형식: ' + file);
}

module.exports = { parseFile, hasTrackChanges };
