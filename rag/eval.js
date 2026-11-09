#!/usr/bin/env node
/**
 * RAG 품질 평가
 *   node rag/eval.js build      → 규정 청크에서 Q&A 초안 생성 (eval/qa.draft.json, 사람 검수 후 eval/qa.json 으로 저장)
 *   node rag/eval.js retrieval  → 검색 방식별 Hit@1 / Hit@5 / MRR 비교 (dense, sparse, hybrid, hybrid+rerank)
 *   node rag/eval.js answer     → 최종 설정으로 답변 생성 후 LLM 채점 (정확성·근거충실성·관련성, 1~5)
 * 결과는 eval/report-*.json 에 저장
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { search } = require('./retrieve');
const { chat } = require('./llm');

const EVAL_DIR = path.join(__dirname, '..', 'eval');
const QA = path.join(EVAL_DIR, 'qa.json');
const chunks = () => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'rag-chunks.json'), 'utf8'));
const save = (name, data) => {
  fs.mkdirSync(EVAL_DIR, { recursive: true });
  fs.writeFileSync(path.join(EVAL_DIR, name), JSON.stringify(data, null, 2));
};

// 정답 판정: 같은 규정 + 같은 조문(분할 조각은 어느 것이든) / 별표는 라벨 일치
const goldKey = (c) => `${c.doc}|${c.type === '본문' ? c.articleNo : c.label.replace(/\s*\(\d+\/\d+\)$/, '')}`;
const isHit = (c, gold) => gold.includes(goldKey(c));

// ── 1) Q&A 초안 생성
async function build() {
  const all = chunks().filter((c) => (c.type === '본문' || c.type === '별표') && c.text.length > 120);
  // 규정별로 고르게, 조문 단위 중복 없이 샘플링
  const byDoc = {};
  for (const c of all) (byDoc[c.doc] = byDoc[c.doc] || []).push(c);
  const picked = [];
  const perDoc = { 인사관리규정: 8, 인사관리규정시행요강: 9, 보수규정: 4, 보수규정시행요강: 5, 복지규정: 3, 복지규정시행요강: 4, 취업규칙: 3 };
  for (const [doc, list] of Object.entries(byDoc)) {
    const seen = new Set();
    const pool = list.filter((c) => (seen.has(goldKey(c)) ? false : seen.add(goldKey(c))));
    const n = perDoc[doc] || 3;
    for (let i = 0; i < n && pool.length; i++) picked.push(pool.splice(Math.floor((pool.length * (i + 0.5)) / n) % pool.length, 1)[0]);
  }
  const items = [];
  for (const c of picked) {
    const out = await chat(
      [
        { role: 'system', content: '당신은 공기업 직원입니다. 사내 규정 조문을 보고, 동료가 사내 챗봇에 실제로 물어볼 법한 질문 1개와 모범 답변을 만듭니다. JSON으로만 답하세요.' },
        {
          role: 'user',
          content: `[조문]\n${c.header}\n${c.text}\n\n조건:\n- 질문은 구어체, 조문 제목·법률용어를 그대로 베끼지 말고 상황으로 묻기 (예: "아이가 아파서 쉬어야 하는데 며칠까지 돼요?")\n- 이 조문만 보면 답할 수 있는 구체적 질문 (숫자·기간·대상·절차 중 하나)\n- 모범 답변은 1~3문장, 조문 근거 그대로\n{"question":"...","answer":"..."}`,
        },
      ],
      { json: true, temperature: 0.7, maxTokens: 400 }
    );
    try {
      const j = JSON.parse(out.text);
      items.push({ id: items.length + 1, question: j.question, reference: j.answer, gold: [goldKey(c)], source: `${c.docLabel} ${c.label}` });
      process.stdout.write('.');
    } catch {}
  }
  // 범위 밖 / 개인정보 질문 (근거 없음을 잘 말하는지)
  items.push(
    { id: items.length + 1, question: '제 남은 연차가 며칠인지 알려주세요', reference: '개인별 잔여 연차는 규정으로 알 수 없으며 인사정보시스템에서 확인해야 한다. 연차 부여 기준은 안내 가능.', gold: [], type: 'personal' },
    { id: items.length + 2, question: '회사 주차장 이용 요금이 얼마인가요?', reference: '제공된 인사 규정에서 확인되지 않으므로 담당 부서에 문의하도록 안내.', gold: [], type: 'out_of_scope' }
  );
  save('qa.draft.json', items);
  console.log(`\n초안 ${items.length}문항 → eval/qa.draft.json (검수 후 eval/qa.json 으로 저장하세요)`);
}

// ── 2) 검색 평가
async function retrieval() {
  const qa = JSON.parse(fs.readFileSync(QA, 'utf8')).filter((q) => q.gold.length);
  const configs = [
    { name: 'dense (BGE-M3)', opt: { mode: 'dense', useRerank: false } },
    { name: 'sparse (BM25)', opt: { mode: 'sparse', useRerank: false } },
    { name: 'hybrid (RRF)', opt: { mode: 'hybrid', useRerank: false } },
    { name: 'hybrid + rerank (후보 20)', opt: { mode: 'hybrid', useRerank: true, candidates: 20 } },
    { name: 'hybrid + rerank (후보 30)', opt: { mode: 'hybrid', useRerank: true, candidates: 30 } },
  ];
  const report = [];
  for (const cfg of configs) {
    let h1 = 0, h3 = 0, h5 = 0, mrr = 0, ms = 0;
    const misses = [];
    for (const q of qa) {
      const t0 = Date.now();
      const r = await search(q.question, { topK: 10, ...cfg.opt });
      ms += Date.now() - t0;
      const rank = r.candidates.slice(0, 10).findIndex((c) => isHit(c, q.gold)) + 1;
      if (rank === 1) h1++;
      if (rank && rank <= 3) h3++;
      if (rank && rank <= 5) h5++;
      if (rank) mrr += 1 / rank;
      if (!rank || rank > 5) misses.push({ id: q.id, question: q.question, gold: q.gold, got: r.candidates.slice(0, 3).map((c) => goldKey(c)) });
    }
    const n = qa.length;
    const row = { config: cfg.name, n, 'Hit@1': +(h1 / n).toFixed(3), 'Hit@3': +(h3 / n).toFixed(3), 'Hit@5': +(h5 / n).toFixed(3), MRR: +(mrr / n).toFixed(3), avgMs: Math.round(ms / n), misses };
    report.push(row);
    console.log(`${cfg.name.padEnd(26)} Hit@1 ${row['Hit@1']}  Hit@3 ${row['Hit@3']}  Hit@5 ${row['Hit@5']}  MRR ${row.MRR}  평균 ${row.avgMs}ms`);
  }
  save('report-retrieval.json', report);
}

// ── 3) 답변 평가 (LLM 채점)
async function answer() {
  const { answer: ask } = require('./answer');
  const qa = JSON.parse(fs.readFileSync(QA, 'utf8'));
  const judgeModel = process.env.JUDGE_MODEL || 'openai/gpt-4.1';
  const rows = [];
  for (const q of qa) {
    const r = await ask({ question: q.question, sessionId: 'eval-' + q.id });
    const ctx = r.sources.map((s) => `[${s.n}] ${s.doc} ${s.label}\n${s.text}`).join('\n\n');
    const prev = process.env.LLM_MODEL;
    process.env.LLM_MODEL = judgeModel;
    const j = await chat(
      [
        { role: 'system', content: 'RAG 답변 채점관입니다. 각 항목을 1~5 정수로 엄격하게 채점하고 JSON으로만 답하세요.' },
        {
          role: 'user',
          content: `[질문]\n${q.question}\n\n[모범 답변]\n${q.reference}\n\n[검색된 근거]\n${ctx || '(없음)'}\n\n[챗봇 답변]\n${r.answer}\n\n채점 기준:\n- correctness: 모범 답변과 사실(숫자·기간·대상)이 일치하는가\n- faithfulness: 챗봇 답변의 모든 주장이 검색된 근거로 뒷받침되는가 (근거 밖 내용·추측이 있으면 감점)\n- relevance: 질문에 직접 답하는가\n{"correctness":n,"faithfulness":n,"relevance":n,"comment":"한 줄"}`,
        },
      ],
      { json: true, maxTokens: 300 }
    );
    process.env.LLM_MODEL = prev;
    let s = {};
    try { s = JSON.parse(j.text); } catch {}
    rows.push({ id: q.id, question: q.question, ...s, elapsed: r.elapsed, answer: r.answer, sources: r.sources.map((x) => `${x.doc} ${x.label}`) });
    process.stdout.write(`${q.id}:${s.correctness}/${s.faithfulness}/${s.relevance} `);
  }
  const avg = (k) => +(rows.reduce((a, r) => a + (Number(r[k]) || 0), 0) / rows.length).toFixed(2);
  const summary = { n: rows.length, judge: judgeModel, correctness: avg('correctness'), faithfulness: avg('faithfulness'), relevance: avg('relevance'), avgSeconds: avg('elapsed') };
  save('report-answer.json', { summary, rows });
  console.log('\n', summary);
}

const cmd = process.argv[2];
({ build, retrieval, answer }[cmd] || (() => console.log('사용법: node rag/eval.js build|retrieval|answer')))()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
