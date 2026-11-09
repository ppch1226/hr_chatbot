/**
 * 키워드(BM25) 검색용 희소 벡터
 * - 한국어는 조사가 붙어 단어 단위 매칭이 약하므로 "단어 + 한글 2-gram" 을 함께 토큰으로 사용
 * - 숫자·영문·조문번호(제27조, 별표1)는 그대로 토큰화해서 정확 매칭
 * - 문서 쪽 값 = BM25 TF 포화값, IDF는 Qdrant(modifier: idf)가 계산
 */
const K1 = 1.2;
const B = 0.75;

function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const STOP = new Set(['및', '등', '의', '이', '그', '수', '때', '경우', '따른', '따라', '대한', '관한', '한다', '하는', '있다', '없다', '다음', '각', '호', '항', '이하', '같다', '알려줘', '알려', '주세요', '무엇', '어떻게', '얼마', '인가요', '있나요', '되나요', '해줘']);

function tokenize(text) {
  const t = String(text || '')
    .replace(/제\s*(\d+)\s*(조|항|호|장|절)(?:\s*의\s*(\d+))?/g, (_, n, k, e) => ` 제${n}${k}${e ? '의' + e : ''} `)
    .replace(/별표\s*(\d+)/g, ' 별표$1 ')
    .toLowerCase();
  const words = t.match(/[가-힣]+|[a-z]+|\d+(?:[.,]\d+)*|제\d+(?:조|항|호|장|절)(?:의\d+)?|별표\d+/g) || [];
  const out = [];
  for (const w of words) {
    if (STOP.has(w)) continue;
    out.push('w:' + w);
    if (/^[가-힣]{2,}$/.test(w)) for (let i = 0; i + 1 < w.length; i++) out.push('b:' + w.slice(i, i + 2));
  }
  return out;
}

function counts(tokens) {
  const m = new Map();
  for (const tk of tokens) {
    const id = fnv1a(tk);
    m.set(id, (m.get(id) || 0) + 1);
  }
  return m;
}

/** 문서 → 희소 벡터 (avgLen: 전체 청크 평균 토큰 수) */
function docVector(text, avgLen) {
  const tokens = tokenize(text);
  const len = tokens.length || 1;
  const m = counts(tokens);
  const indices = [], values = [];
  for (const [id, tf] of m) {
    indices.push(id);
    values.push((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * len) / avgLen)));
  }
  return { indices, values };
}

/** 질문 → 희소 벡터 (토큰 존재 여부만) */
function queryVector(text) {
  const m = counts(tokenize(text));
  return { indices: [...m.keys()], values: [...m.keys()].map(() => 1) };
}

module.exports = { tokenize, docVector, queryVector };
