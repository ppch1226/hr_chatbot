/**
 * 시각화 회귀 테스트: 직원이 자주 할 법한 질문에 시각화 블록이 제대로 붙는지 확인
 *   npm run test:visuals            (서버와 별도로 실행 가능, Qdrant가 켜져 있어야 함)
 *   npm run test:visuals -- 3 7     (특정 번호만)
 * 질문마다: 검색된 근거 → LLM이 만든 블록(raw) → 검증 통과 블록 / 버려진 이유
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { embed } = require('./models');
const { search, expandQuery } = require('./retrieve');
const lawsources = require('./lawsources');
const VIS = require('./visuals');
const qdrant = require('./qdrant');

// expect: 이 질문에 기대하는 시각화 종류 (하나라도 나오면 통과)
// 항목별 일수·금액 표가 근거인 질문은 chart를 기대 (stats 4칸으로는 표를 다 못 보여줌)
const CASES = [
  { q: '복지포인트 차감 기준 알려줘', expect: ['info', 'stats', 'steps'] },
  { q: '청원휴가 일수 알려줘', expect: ['chart'] },
  { q: '배우자 출산휴가는 며칠인가요?', expect: ['stats', 'timeline'] },
  { q: '육아휴직은 몇 번 나눠 쓸 수 있나요?', expect: ['stats'] },
  { q: '연차휴가는 근속연수별로 며칠인가요?', expect: ['chart', 'stats'] },
  { q: '경조사 휴가 일수 알려줘', expect: ['chart'] },
  { q: '병가는 며칠까지 쓸 수 있나요?', expect: ['stats', 'chart', 'info'] },
  { q: '출장 갈 때 숙박비는 얼마까지 나와?', expect: [], none: true }, // 사규에 출장 숙박비 기준 없음(국외지사 주택임차 표만) → 그리지 않아야 통과
  { q: '휴직 신청 절차 알려줘', expect: ['steps'] },
  { q: '승진 소요연한은 직급별로 어떻게 되나요?', expect: ['chart'] },
  { q: '자녀 학자금 지원 기준 알려줘', expect: ['stats', 'info', 'chart'] },
  { q: '태아검진휴가는 며칠인가요?', expect: ['stats', 'chart'] },
  { q: '장기근속휴가는 몇 년 근무하면 며칠 주나요?', expect: ['chart', 'stats'] },
  { q: '임신 중 근로시간 단축은 어떻게 하나요?', expect: ['stats', 'steps', 'timeline', 'info'] },
  { q: '육아휴직 신청은 어떻게 하나요?', expect: ['steps'] },
  { q: '경조금은 얼마나 받을 수 있어?', expect: [], none: true }, // 사규에 경조금 금액이 없음 → 엉뚱한 표(재해부조금)를 그리지 않아야 통과
  { q: '건강검진 지원 기준 알려줘', expect: ['info'], allowNone: true }, // 사규가 세부 기준을 본부장에게 위임 → info 또는 없음
  { q: '시간외근무수당은 어떻게 계산돼?', expect: ['stats', 'info', 'steps', 'chart'] },
  { q: '겸직 허가 받으려면 어떻게 해야 해?', expect: ['steps', 'info'] },
  { q: '휴가 사용 절차가 어떻게 되나요?', expect: ['steps'] },
];

async function evidenceFor(question) {
  const q = expandQuery(question); // 서버(answer.js)와 같은 검색어 보정
  const [dense] = await embed([q]);
  const [r, laws] = await Promise.all([search(q, { dense }), lawsources.searchLaws(q, { dense, topK: 2 }).catch(() => [])]);
  const regs = r.chunks.map((c) => ({ docLabel: '(사규)', label: c.header || `${c.docLabel} ${c.type === '본문' ? c.label : c.type + ' ' + c.label}`, text: c.text }));
  const lawItems = laws.map((x) => ({ docLabel: `(${x.kind})`, label: x.title, text: x.text.length > 1400 ? x.text.slice(0, 1400) + ' …' : x.text }));
  return [...regs, ...lawItems];
}

(async () => {
  await qdrant.ensureRunning();
  const pick = process.argv.slice(2).map(Number).filter(Boolean);
  const cases = pick.length ? CASES.filter((_, i) => pick.includes(i + 1)) : CASES;
  const results = [];
  let pass = 0;
  for (const c of cases) {
    const t0 = Date.now();
    const ev = await evidenceFor(c.q);
    const out = await VIS.generate(c.q, ev);
    const got = out.visuals.map((v) => v.type + (v.chart ? ':' + v.chart : ''));
    const ok = c.none ? !out.visuals.length : (c.allowNone && !out.visuals.length) || out.visuals.some((v) => c.expect.includes(v.type));
    if (ok) pass++;
    results.push({ q: c.q, expect: c.expect, got, raw: out.raw, rejected: out.reasons, evidence: ev.map((e) => e.label), visuals: out.visuals });
    console.log(`${ok ? '✅' : '❌'} ${c.q}  (${((Date.now() - t0) / 1000).toFixed(1)}초)`);
    console.log(`   근거: ${ev.map((e) => e.label).slice(0, 4).join(' | ')}`);
    console.log(`   LLM 제안: ${out.raw.map((v) => v.type + (v.chart ? ':' + v.chart : '')).join(', ') || '(없음)'}  →  통과: ${got.join(', ') || '(없음)'}`);
    if (out.reasons.length) console.log(`   버린 이유: ${out.reasons.join(' / ')}`);
  }
  console.log(`\n기대한 시각화가 붙은 질문: ${pass}/${cases.length}`);
  const file = path.join(__dirname, '..', 'data', 'visuals-test.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(results, null, 2));
  console.log(`상세 결과: ${file}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
