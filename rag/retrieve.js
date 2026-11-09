/**
 * 검색: 메타데이터 필터 → 하이브리드(BGE-M3 dense + BM25 sparse, RRF) → 리랭커 → top_k
 */
const { embed, rerank } = require('./models');
const sparse = require('./sparse');
const qdrant = require('./qdrant');
const fs = require('fs');
const path = require('path');

const CFG = {
  candidates: Number(process.env.RAG_CANDIDATES || 30), // 1차 검색 후보 수
  topK: Number(process.env.RAG_TOP_K || 5), // LLM에 넘길 청크 수
  minScore: Number(process.env.RAG_MIN_SCORE || 0.05), // 리랭커 점수 하한 (이보다 낮으면 근거로 쓰지 않음)
  rerank: (process.env.RAG_RERANK || 'on') !== 'off',
};

// 규정명 → 질문에서 찾을 별칭
function docAliases() {
  try {
    const { docs } = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'rag-docs.json'), 'utf8'));
    return docs.map((d) => ({ doc: d.doc, parent: d.parent, kind: d.kind, label: d.docLabel }));
  } catch {
    return [];
  }
}

/** 질문에 규정명이 들어 있으면 그 규정(과 시행요강)으로 범위를 좁힘 */
function detectFilter(question) {
  const q = question.replace(/\s+/g, '');
  const must = [];
  const mustNot = [];
  const docs = docAliases();
  const named = new Set();
  for (const d of docs) {
    if (d.kind === '시행요강') {
      if (q.includes(d.doc) || q.includes(d.parent + '시행요강')) named.add(d.doc);
    } else if (q.includes(d.doc)) {
      named.add(d.doc);
      // "보수규정"만 언급하면 보수규정 시행요강도 함께 (명시적으로 "시행요강"이 없을 때)
      if (!/시행요강/.test(q)) docs.filter((x) => x.parent === d.doc && x.kind === '시행요강').forEach((x) => named.add(x.doc));
    }
  }
  if (named.size) must.push({ key: 'doc', match: { any: [...named] } });

  const wantsAddenda = /부칙|시행일|경과\s*조치|적용\s*례|언제부터/.test(question);
  const wantsForms = /서식|양식|별지|신청서|서약서|확인서/.test(question);
  if (!wantsAddenda) mustNot.push({ key: 'type', match: { value: '부칙' } });
  if (!wantsForms) mustNot.push({ key: 'type', match: { value: '별지' } });

  const filter = {};
  if (must.length) filter.must = must;
  if (mustNot.length) filter.must_not = mustNot;
  return { filter: Object.keys(filter).length ? filter : undefined, docs: [...named], wantsAddenda };
}

async function search(question, { topK = CFG.topK, candidates = CFG.candidates, useRerank = CFG.rerank, mode = 'hybrid', filter: forced, dense: given } = {}) {
  await qdrant.ensureRunning();
  const t0 = Date.now();
  const { filter, docs } = forced ? { filter: forced, docs: [] } : detectFilter(question);
  const [dense] = given ? [given] : await embed([question]); // 질문 임베딩은 한 번만 (answer에서 받아 씀)
  const sp = sparse.queryVector(question);
  const args = { dense, sparse: sp, filter, limit: candidates };
  let hits = mode === 'dense' ? await qdrant.denseOnly(args) : mode === 'sparse' ? await qdrant.sparseOnly(args) : await qdrant.hybrid(args);
  // 규정명으로 좁혔는데 결과가 없으면 필터 없이 다시
  if (!hits.length && filter && filter.must) hits = await qdrant.hybrid({ ...args, filter: { must_not: filter.must_not } });
  const t1 = Date.now();

  let ranked = hits.map((h, i) => ({ ...h.payload, id: h.id, retrievalRank: i + 1, retrievalScore: h.score }));
  if (useRerank && ranked.length) {
    const scores = await rerank(question, ranked.map((c) => c.content));
    ranked.forEach((c, i) => (c.score = scores[i]));
    ranked.sort((a, b) => b.score - a.score);
    const kept = ranked.filter((c) => c.score >= CFG.minScore);
    ranked = kept.length ? kept : ranked.slice(0, 2); // 전부 낮으면 상위 2개만 참고용으로
  } else ranked.forEach((c) => (c.score = c.retrievalScore));

  return {
    chunks: ranked.slice(0, topK),
    candidates: ranked,
    filterDocs: docs,
    timing: { retrieve: t1 - t0, rerank: Date.now() - t1 },
  };
}

module.exports = { search, detectFilter, CFG };
