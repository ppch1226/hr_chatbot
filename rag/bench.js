#!/usr/bin/env node
/** 답변 속도 측정: node rag/bench.js [라벨]  → eval/bench-<라벨>.json */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs'), path = require('path');
const rag = require('./answer');
const { embed, rerank } = require('./models');
const Q = [
  ['employee', '연차휴가는 며칠 받을 수 있나요?'],
  ['employee', '배우자 출산휴가는 며칠이야?'],
  ['employee', '태아검진휴가 신청방법 알려줘'],
  ['admin', '무단결근 직원 해고해도 되나요?'],
  ['admin', '연차휴가 사용촉진 절차 검토해줘'],
  ['admin', '직장 내 괴롭힘 신고가 들어오면 어떻게 처리해야 해?'],
];
(async () => {
  await embed(['워밍업']); await rerank('a', ['b']);
  const rows = [];
  for (const [role, q] of Q) {
    const stream = process.env.BENCH_STREAM === '1';
    const r = await rag.answer({ question: q, role, sessionId: 'bench-' + Math.random(), onEvent: stream ? () => {} : undefined });
    const t = r.timing;
    rows.push({ role, q, total: Math.round(r.elapsed * 1000), firstToken: r.timing.firstToken, ...t, law: undefined, lawDetail: t.law });
    console.log(`${role.padEnd(8)} ${String(Math.round(r.elapsed * 1000)).padStart(6)}ms (첫 글자 ${t.firstToken ?? "-"}ms) | 검색 ${t.retrieval} (사규 ${t.regSearch}: 임베딩+DB ${t.retrieve} / 리랭크 ${t.rerank}, 법령 ${t.lawGather}) | 판례조회 ${t.cases ?? "-"} 판례작성 ${t.casesWrite ?? "-"} | 생성 ${t.generation} (답변 ${t.llmAnswer}, 보조 ${t.llmVisuals}) | 입력 ${t.promptTokens}tok 출력 ${t.answerTokens}tok | ${q}`);
  }
  const avg = (role, k) => Math.round(rows.filter((x) => x.role === role).reduce((s, x) => s + (x[k] || 0), 0) / rows.filter((x) => x.role === role).length);
  const sum = { employee: { firstToken: avg('employee', 'firstToken'), total: avg('employee', 'total'), retrieval: avg('employee', 'retrieval'), generation: avg('employee', 'generation') }, admin: { firstToken: avg('admin', 'firstToken'), total: avg('admin', 'total'), retrieval: avg('admin', 'retrieval'), generation: avg('admin', 'generation') } };
  console.log('평균', JSON.stringify(sum));
  fs.mkdirSync(path.join(__dirname, '..', 'eval'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, '..', 'eval', `bench-${process.argv[2] || 'run'}.json`), JSON.stringify({ sum, rows }, null, 2));
  process.exit(0);
})();
